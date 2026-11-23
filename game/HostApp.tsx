"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { analytics } from "@/shared/analytics";
import { LAPS, MAX_PLAYERS, randomCode } from "@/shared/constants";
import { BEGINNER_TRACK, DEFAULT_SETTINGS, previewTrack, REACTIONS, TRACKS, type MatchSettings, type MirrorSetting } from "@/shared/rules";
import { t, trackName } from "@/shared/strings";
import { clueText } from "@/shared/clues";
import { openRoom, randomToken, send, store } from "@/shared/net";
import { parseMsg, type AnyMsg, type Clue, type LobbyMsg, type PlayerInfo } from "@/shared/protocol";
import type { PartySocket } from "partysocket";
import { Director } from "./camera";
import { DevBotRelay } from "./devbots";
import { Sfx } from "./sound";
import AdBreak from "./AdBreak";
import { adDue } from "@/shared/ads";
import { percentile, RaceHost } from "./race";
import { fetchTrackFile } from "@/shared/track-format";
import { buildTrack, type Track } from "./track";

const HOST_KEY = "tt-host";
const SETTINGS_KEY = "tt-settings";
/** Completed matches on this host device (PLAN.md 6: ads rule; also picks the beginner track). */
const MATCHES_KEY = "tt-matches";

/** Fetch + build a track once per page; later races reuse it. */
const trackCache = new Map<string, Promise<Track>>();
function fetchTrack(id: string): Promise<Track> {
  let p = trackCache.get(id);
  if (!p) {
    p = fetchTrackFile(id).then(buildTrack);
    p.catch(() => trackCache.delete(id));
    trackCache.set(id, p);
  }
  return p;
}

export default function HostApp() {
  const [code, setCode] = useState<string | null>(null);
  const [lobby, setLobby] = useState<LobbyMsg | null>(null);
  const [joinUrl, setJoinUrl] = useState("");
  const [qr, setQr] = useState("");
  const [online, setOnline] = useState(false);
  const [showDebug, setShowDebug] = useState(true);
  const [trackError, setTrackError] = useState("");
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const wsRef = useRef<PartySocket | null>(null);
  const hostRef = useRef<RaceHost | null>(null);
  const director = useRef(new Director()).current;
  const sfx = useRef<Sfx | null>(null);
  if (!sfx.current && typeof window !== "undefined") sfx.current = new Sfx();
  const [fullscreen, setFullscreen] = useState(false);
  const [cursorHidden, setCursorHidden] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  /** Debug overlay numbers: message counts (this second), rates (last second), ping per player. */
  const net = useRef({ in: 0, out: 0, inRate: 0, outRate: 0, ping: new Map<string, number>(), bots: 0 });
  const tx = (m: AnyMsg) => {
    net.current.out++;
    send(wsRef.current, m);
  };

  // One RaceHost for the life of the page; it sends through whichever socket is current.
  if (!hostRef.current) {
    const h = new RaceHost(null, (m) => tx(m), rerender, analytics.log);
    h.settings = { ...DEFAULT_SETTINGS, ...store.get<Partial<MatchSettings>>(SETTINGS_KEY) };
    h.matchesPlayed = store.get<number>(MATCHES_KEY) ?? 0;
    h.onMatchDone = () => store.set(MATCHES_KEY, h.matchesPlayed);
    h.sound = (name) => sfx.current?.play(name);
    h.loadTrack = fetchTrack;
    h.onTrapCut = (x, y) => director.trapHit(x, y, performance.now());
    hostRef.current = h;
  }
  const host = hostRef.current;
  // Dev-only handle for debugging from the browser console.
  if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") (window as unknown as { __tt: RaceHost }).__tt = host;

  // Pick (or resume) a room. A reload keeps the same room thanks to the stored host token.
  useEffect(() => {
    const saved = store.get<{ code: string; seat: string }>(HOST_KEY);
    const room = saved ?? { code: randomCode(), seat: randomToken() };
    store.set(HOST_KEY, room);
    setCode(room.code);
    analytics.setContext({ role: "host", room: room.code });
    if (!saved) analytics.log({ e: "room_created" });
  }, []);

  useEffect(() => {
    if (!code) return;
    const seat = store.get<{ seat: string }>(HOST_KEY)!.seat;
    const ws = openRoom(code, "host");
    wsRef.current = ws;
    ws.addEventListener("open", () => {
      setOnline(true);
      tx({ v: 1, t: "hosthello", seat });
    });
    let wasOpen = false;
    ws.addEventListener("open", () => (wasOpen = true));
    ws.addEventListener("close", () => {
      setOnline(false);
      if (wasOpen) analytics.log({ e: "disconnect", who: "host", phase: host.phase });
      wasOpen = false;
    });
    ws.addEventListener("message", (e) => {
      net.current.in++;
      const m = parseMsg(e.data);
      if (!m) return;
      switch (m.t) {
        case "in":
          host.onInput(String(m.p), m.s as -1 | 0 | 1, Number(m.k));
          break;
        case "ping":
          tx({ v: 1, t: "pong", k: Number(m.k), p: String(m.p) });
          if (typeof m.r === "number") net.current.ping.set(String(m.p), m.r);
          break;
        case "stat":
          host.onStat(String(m.p), Number(m.tt));
          break;
        case "start":
          startRef.current();
          break;
        case "viewers":
          host.onViewers(Number(m.n));
          break;
        case "progress":
          host.onProgress(Number(m.n), Number(m.of));
          break;
        case "traps":
          host.onTraps(Number(m.race), Array.isArray(m.list) ? m.list : []);
          break;
        case "glitch":
          host.onGlitch(String(m.target));
          break;
        case "react":
          host.onReact(String(m.p), Number(m.e), performance.now());
          break;
        case "voteresult":
          host.onVoteResult(typeof m.caught === "string" ? m.caught : null, m.traitor === true);
          break;
        case "scores":
          host.onScores((m.scores ?? {}) as Record<string, number>);
          break;
        case "reveal":
          host.onReveal(Array.isArray(m.traitors) ? m.traitors.map(String) : []);
          break;
        case "lobby":
          setLobby(m as unknown as LobbyMsg);
          host.setLobby(m as unknown as LobbyMsg);
          break;
        case "error":
          if (m.code === "taken") {
            // Code collision with another live room: start over with a fresh code.
            store.set(HOST_KEY, { code: randomCode(), seat: randomToken() });
            ws.close();
            const fresh = store.get<{ code: string }>(HOST_KEY)!.code;
            analytics.setContext({ room: fresh });
            analytics.log({ e: "room_created" });
            setCode(fresh);
          }
          break;
      }
    });
    return () => ws.close();
  }, [code, host]);

  // Load the track file, then start Phaser (browser only, after the page is up).
  useEffect(() => {
    let game: { destroy(removeCanvas: boolean): void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        host.track = await fetchTrack(previewTrack(host.settings, host.matchesPlayed === 0));
      } catch (e) {
        setTrackError(t("host.trackError", { id: previewTrack(host.settings, host.matchesPlayed === 0), err: (e as Error).message }));
        return;
      }
      const { createGame } = await import("./scene");
      if (!cancelled && canvasRef.current) {
        game = createGame(canvasRef.current, host, director);
        if (process.env.NODE_ENV !== "production") (window as unknown as { __ttGame: unknown }).__ttGame = game;
      }
      rerender();
    })();
    return () => {
      cancelled = true;
      game?.destroy(true);
    };
  }, [host, director]);

  // QR points phones at /play on this machine's Wi-Fi address, not "localhost".
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    (async () => {
      const { hostname, port, protocol } = window.location;
      let addr = hostname;
      if (hostname === "localhost" || hostname === "127.0.0.1") {
        try {
          const { ips } = await (await fetch("/api/lan")).json();
          if (ips[0]) addr = ips[0];
        } catch {}
      }
      const url = `${protocol}//${addr}${port ? ":" + port : ""}/play?room=${code}`;
      const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: "#0b1d2a", light: "#ffffff" } });
      if (!cancelled) {
        setJoinUrl(url);
        setQr(dataUrl);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  // Dev: steer the /dev page's fake phones (same-browser BroadcastChannel, never in production).
  useEffect(() => {
    if (!code || process.env.NODE_ENV === "production") return;
    const relay = new DevBotRelay(host, code);
    const id = setInterval(() => (net.current.bots = relay.count), 1000);
    return () => {
      clearInterval(id);
      relay.dispose();
    };
  }, [code, host]);

  // Message rates for the debug overlay.
  useEffect(() => {
    const id = setInterval(() => {
      const n = net.current;
      n.inRate = n.in;
      n.outRate = n.out;
      n.in = n.out = 0;
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Live HUD (standings, countdown, debug numbers) refreshes a few times a second, not every frame.
  useEffect(() => {
    const id = setInterval(rerender, 200);
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "d") setShowDebug((s) => !s);
      if (k === "f") toggleFullscreen();
      if (k === "m") toggleMute();
      // Dev: fake a trap hit on the leader to try the trap-cut camera before traps exist.
      if (k === "t" && process.env.NODE_ENV !== "production" && host.race) {
        const lead = host.race.cars.reduce((a, b) => (b.dist > a.dist ? b : a));
        const p = host.pose(lead.pid)!;
        director.trapHit(p.x, p.y, performance.now());
      }
    };
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      clearInterval(id);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, [host, director]);

  // Hide the mouse cursor after 3 s without movement.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      sfx.current?.unlock();
      setCursorHidden(false);
      clearTimeout(timer);
      timer = setTimeout(() => setCursorHidden(true), 3000);
    };
    wake();
    window.addEventListener("pointermove", wake);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);

  // Ads (PLAN.md 6): only here, between matches, after the first 20 matches on this device.
  const [adThen, setAdThen] = useState<(() => void) | null>(null);
  const startRef = useRef(() => {});
  startRef.current = () => {
    if (adThen || (host.phase !== "lobby" && host.phase !== "podium")) return;
    if (adDue(host.matchesPlayed, navigator.onLine)) setAdThen(() => () => host.start());
    else host.start();
  };
  const adThenRef = useRef(adThen);
  adThenRef.current = adThen;
  const adDone = useCallback(() => {
    const go = adThenRef.current;
    setAdThen(null);
    go?.();
  }, []);

  const [muted, setMuted] = useState(false);
  useEffect(() => setMuted(sfx.current?.muted ?? false), []);
  function toggleMute() {
    const m = !(sfx.current?.muted ?? false);
    sfx.current?.unlock();
    sfx.current?.setMuted(m);
    setMuted(m);
  }

  const newRoom = () => {
    store.del(HOST_KEY);
    location.reload();
  };

  const roster = host.roster;
  const byPid = new Map(roster.map((p) => [p.pid, p]));
  const isBot = (pid: string) => host.bots.some((b) => b.pid === pid);
  const phase = host.phase;
  const cam = host.camera;
  const L = cam.layout;
  const u = L?.u ?? 1;
  const racing = (phase === "race" || phase === "countdown") && host.race;
  const showBanner = host.banner && host.race && host.race.tick - host.banner.tick < 180;
  const secs = Math.max(0, Math.ceil(host.phaseLeft / 1000));
  const raceOf = t("host.raceOf", { race: host.raceNo, races: host.match.races });
  const hidden = host.race?.traps.filter((x) => x.live).length ?? 0;
  const glitching = host.race && phase === "race" && host.race.tick < host.glitchFlash;
  const setSetting = (patch: Partial<MatchSettings>) => {
    host.settings = { ...host.settings, ...patch };
    store.set(SETTINGS_KEY, host.settings);
    rerender();
  };
  const scoreboard = [...roster].sort((a, b) => (host.scores[b.pid] ?? 0) - (host.scores[a.pid] ?? 0));
  const tag = (pid: string) =>
    host.knownTraitors.has(pid) ? <span className="ml-2 rounded bg-[var(--traitor)] px-2 text-sm font-black uppercase text-black">{t(host.revealed ? "host.traitorTag" : "host.caughtTag")}</span>
    : isBot(pid) ? <span className="ml-2 rounded bg-white/20 px-2 text-sm uppercase">{t("host.bot")}</span> : null;

  return (
    <main className="fixed inset-0 overflow-hidden" style={{ cursor: cursorHidden ? "none" : undefined }}>
      <div ref={canvasRef} className="absolute inset-0" />

      {phase === "lobby" && (
        <Overlay>
          <div className="flex flex-wrap items-center justify-center gap-10">
            <div className="text-center">
              <div className="text-xl uppercase tracking-widest opacity-70">{t("host.roomCode")}</div>
              <div className="font-mono text-7xl font-black tracking-[0.2em]">{code ?? "····"}</div>
              <div className="mt-2 text-lg opacity-70">{joinUrl}</div>
              <div className="mt-2 text-sm">
                <span className={online ? "text-green-400" : "text-red-400"}>●</span> {online ? t("host.serverOk") : t("host.serverWait")}
              </div>
            </div>
            {qr && <img src={qr} alt={t("host.qrAlt")} className="h-52 w-52 rounded-2xl bg-white p-2" />}
          </div>
          <section className="w-full max-w-3xl">
            <h2 className="mb-3 text-2xl font-bold">{t("host.players", { n: lobby?.players.length ?? 0, max: MAX_PLAYERS })}</h2>
            <PlayerGrid players={lobby?.players ?? []} vip={lobby?.vip ?? null} />
            {lobby && lobby.players.length === 0 && <p className="opacity-70">{t("host.scanToJoin")}</p>}
          </section>
          <Settings s={host.settings} set={setSetting} />
          <div className="flex items-center gap-6">
            <button
              onClick={() => startRef.current()}
              disabled={!lobby || lobby.players.length === 0 || !host.track}
              className="rounded-2xl px-8 py-4 text-2xl font-black text-black disabled:opacity-30"
              style={{ background: "var(--racer)" }}
            >
              {t("race.startMatch")}
            </button>
            <button onClick={newRoom} className="text-sm underline opacity-50">
              {t("host.newCode")}
            </button>
          </div>
        </Overlay>
      )}

      {phase === "role" && (
        <Overlay>
          <h1 className="text-7xl font-black">{t("host.roleTitle")}</h1>
          <p className="text-3xl">📱 {t("host.roleSub")}</p>
          <div className="text-6xl font-black opacity-80">{secs}</div>
        </Overlay>
      )}

      {phase === "draft" && (
        <Overlay>
          <div className="text-2xl uppercase tracking-widest opacity-70">{raceOf} · {host.track ? trackName(host.track.def.id) : ""}</div>
          <h1 className="text-7xl font-black" style={{ color: "var(--traitor)" }}>{t("host.draftTitle")}</h1>
          <p className="text-3xl">{t("host.draftSub", { n: host.progress.n, of: host.progress.of })}</p>
          <div className="text-6xl font-black opacity-80">{secs > 0 ? secs : "…"}</div>
        </Overlay>
      )}

      {phase === "countdown" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="text-[14rem] font-black drop-shadow-[0_6px_0_rgba(0,0,0,0.5)]">{Math.max(1, Math.ceil(host.countdownLeft / 1000))}</div>
        </div>
      )}

      {racing && L && (
        <>
          {/* Minimap frame (the map itself is a Phaser camera underneath). */}
          <div className="pointer-events-none absolute rounded-lg ring-2 ring-white/40" style={{ left: L.minimap.x, top: L.minimap.y, width: L.minimap.w, height: L.minimap.h }} />

          {/* Positions tower, right edge. */}
          <ol className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 space-y-1 overflow-hidden rounded-l-2xl bg-black/55 font-bold" style={{ width: L.towerW, padding: 12 * u, fontSize: 22 * u }}>
            <li className="text-center uppercase tracking-widest opacity-60" style={{ fontSize: 14 * u }}>{raceOf}</li>
            {[...host.race!.cars]
              .sort((a, b) => (a.finishMs ?? Infinity) - (b.finishMs ?? Infinity) || b.dist - a.dist)
              .map((c, i) => {
                const p = byPid.get(c.pid);
                return (
                  <li key={c.pid} className="flex items-center" style={{ gap: 8 * u }}>
                    <span className="opacity-70" style={{ width: 24 * u }}>{i + 1}</span>
                    <span className="flex shrink-0 items-center justify-center rounded-full font-black text-[#0b1d2a]" style={{ background: p?.color, width: 22 * u, height: 22 * u, fontSize: 13 * u, outline: host.knownTraitors.has(c.pid) ? `${3 * u}px solid var(--traitor)` : undefined }}>
                      {host.carNumber(c.pid)}
                    </span>
                    <span className="truncate" style={{ opacity: p?.on === false ? 0.5 : 1 }}>{p?.name ?? "?"}</span>
                    <span className="ml-auto shrink-0 opacity-70" style={{ paddingLeft: 8 * u, fontSize: 15 * u }}>
                      {c.finishMs !== null ? "🏁" : t("race.lap", { lap: Math.min(c.lap + 1, LAPS), laps: LAPS })}
                    </span>
                  </li>
                );
              })}
          </ol>

          {/* Event banners, top center. */}
          {showBanner && (
            <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded-2xl bg-black/65 font-black" style={{ top: L.pad, padding: `${8 * u}px ${24 * u}px`, fontSize: 36 * u }}>
              {t(host.banner!.key, host.banner!.vars)}
            </div>
          )}

          {/* Bottom right: traps still hidden (left of the tower). */}
          {host.race!.traps.length > 0 && (
            <div className="pointer-events-none absolute rounded-lg bg-black/55 font-bold" style={{ right: L.towerW + L.pad, bottom: L.pad, padding: `${4 * u}px ${12 * u}px`, fontSize: 22 * u }}>
              {t("host.trapsHidden", { n: hidden })}
            </div>
          )}
        </>
      )}

      {/* Glitch: static flash on the TV, never who did it. */}
      {glitching && <div className="glitch-static pointer-events-none absolute inset-0" />}

      {/* Reactions float up from the bottom. */}
      <Reactions host={host} byPid={byPid} u={u} />

      {/* Bottom left: room code + fullscreen (outside the lobby, which shows them big). */}
      {phase !== "lobby" && (
        <div className="absolute z-10 flex items-center font-bold" style={{ left: L?.pad ?? 16, bottom: L?.pad ?? 16, gap: 12 * u }}>
          <span className="rounded-lg bg-black/55 font-mono tracking-widest" style={{ padding: `${4 * u}px ${12 * u}px`, fontSize: 22 * u }}>
            {t("host.roomShort", { code: code ?? "" })}
          </span>
          <FullscreenButton on={fullscreen} u={u} />
          <MuteButton muted={muted} u={u} onToggle={toggleMute} />
        </div>
      )}
      {phase === "lobby" && (
        <div className="absolute bottom-4 left-4 z-10">
          <FullscreenButton on={fullscreen} u={1} />
          <span className="ml-3"><MuteButton muted={muted} u={1} onToggle={toggleMute} /></span>
        </div>
      )}

      {phase === "results" && (
        <Overlay>
          <h1 className="text-6xl font-black">{t("host.resultsTitle", { race: host.raceNo })}</h1>
          <ol className="w-full max-w-2xl space-y-2">
            {host.results.map((r, i) => {
              const p = byPid.get(r.pid);
              return (
                <li key={r.pid} className="flex items-center gap-4 rounded-xl bg-white/10 p-3 text-2xl font-bold">
                  <span className="w-10 text-3xl">{["🥇", "🥈", "🥉"][i] ?? i + 1}</span>
                  <span className="h-5 w-5 rounded-full" style={{ background: p?.color }} />
                  <span>{p?.name ?? t("host.leftRoom")}</span>
                  {tag(r.pid)}
                  <span className="ml-auto font-mono text-xl opacity-80">{r.ms !== null ? (r.ms / 1000).toFixed(2) + "s" : t("host.dnf")}</span>
                  <span className="w-16 text-right text-green-300">+{host.racePoints(r.pid)}</span>
                  <span className="w-16 text-right">{host.scores[r.pid] ?? 0}</span>
                </li>
              );
            })}
          </ol>
          <div className="text-4xl font-black opacity-80">{secs}</div>
        </Overlay>
      )}

      {phase === "vote" && (
        <Overlay>
          <h1 className="text-7xl font-black" style={{ color: "var(--traitor)" }}>{t("host.voteTitle")}</h1>
          <p className="text-3xl">📱 {t("host.voteSub", { n: host.progress.n, of: host.progress.of })}</p>
          <ClueList clues={host.clues} name={(pid) => host.name(pid)} />
          <div className="text-6xl font-black opacity-80">{secs > 0 ? secs : "…"}</div>
        </Overlay>
      )}

      {phase === "reveal" && host.voteResult && (
        <Overlay>
          {host.voteResult.caught ? (
            <>
              <div className="h-24 w-24 rounded-full" style={{ background: byPid.get(host.voteResult.caught)?.color }} />
              <h1 className="text-center text-7xl font-black" style={{ color: host.voteResult.traitor ? "var(--traitor)" : "var(--racer)" }}>
                {t(host.voteResult.traitor ? "reveal.caughtTraitor" : "reveal.innocent", { name: host.name(host.voteResult.caught) })}
              </h1>
            </>
          ) : (
            <h1 className="max-w-4xl text-center text-6xl font-black">{t("reveal.nobody")}</h1>
          )}
        </Overlay>
      )}

      {phase === "podium" && (
        <Overlay>
          <h1 className="text-6xl font-black">{t("podium.title")}</h1>
          <ol className="w-full max-w-2xl space-y-2">
            {scoreboard.map((p, i) => (
              <li key={p.pid} className="flex items-center gap-4 rounded-xl bg-white/10 p-3 font-bold" style={{ fontSize: i < 3 ? 32 : 24 }}>
                <span className="w-12">{["🥇", "🥈", "🥉"][i] ?? i + 1}</span>
                <span className="h-5 w-5 rounded-full" style={{ background: p.color }} />
                <span>{p.name}</span>
                {tag(p.pid)}
                <span className="ml-auto font-mono">{host.scores[p.pid] ?? 0}</span>
              </li>
            ))}
          </ol>
          <p className="text-3xl font-bold" style={{ color: "var(--traitor)" }}>
            {host.knownTraitors.size === 0
              ? t("podium.noTraitors")
              : t(host.knownTraitors.size > 1 ? "podium.traitors" : "podium.traitor", { names: [...host.knownTraitors].map((p) => host.name(p)).join(", ") })}
          </p>
          <div className="flex gap-4">
            <button onClick={() => startRef.current()} className="rounded-2xl px-8 py-4 text-2xl font-black text-black" style={{ background: "var(--racer)" }}>
              {t("race.playAgain")}
            </button>
            <button onClick={() => host.backToLobby()} className="rounded-2xl border-2 px-8 py-4 text-2xl font-bold" style={{ borderColor: "var(--racer)" }}>
              {t("host.lobby")}
            </button>
          </div>
        </Overlay>
      )}

      {phase !== "lobby" && lobby && !online && (
        <div className="absolute inset-x-0 top-0 bg-red-600 p-2 text-center font-bold">{t("host.lostServer")}</div>
      )}

      {adThen && <AdBreak onDone={adDone} />}

      {trackError && <div className="absolute inset-x-0 top-0 bg-red-600 p-2 text-center font-bold">{trackError}</div>}

      {showDebug && (
        <DebugPanel
          host={host}
          players={lobby?.players ?? []}
          net={net.current}
          style={racing && L ? { left: L.pad, top: L.minimap.y + L.minimap.h + L.pad } : { right: 12, bottom: 12 }}
        />
      )}
    </main>
  );
}

function Settings({ s, set }: { s: MatchSettings; set: (p: Partial<MatchSettings>) => void }) {
  const row = <T,>(label: string, value: T, opts: [T, string][], pick: (v: T) => void) => (
    <div className="flex max-w-4xl flex-wrap items-center gap-2">
      <span className="w-32 text-right text-lg opacity-70">{label}</span>
      {opts.map(([v, text]) => (
        <button
          key={String(v)}
          onClick={() => pick(v)}
          className="rounded-lg px-3 py-0.5 text-base font-bold"
          style={v === value ? { background: "var(--racer)", color: "black" } : { background: "rgba(255,255,255,0.1)" }}
        >
          {text}
        </button>
      ))}
    </div>
  );
  return (
    <section className="flex flex-col gap-1.5">
      {row(t("settings.races"), s.races, [[1, "1"], [3, "3"], [5, "5"]] as [MatchSettings["races"], string][], (races) => set({ races }))}
      {row(t("settings.traitors"), s.traitors, [[0, t("settings.auto")], [1, "1"], [2, "2"]] as [MatchSettings["traitors"], string][], (traitors) => set({ traitors }))}
      {row(t("settings.cards"), s.cards, [[1, "1"], [2, "2"]] as [MatchSettings["cards"], string][], (cards) => set({ cards }))}
      {row(t("settings.bots"), s.bots, [[true, t("settings.on")], [false, t("settings.off")]], (bots) => set({ bots }))}
      {row(t("settings.track"), s.track, [["mix", t("settings.mix")], ...TRACKS.map((id) => [id, id === BEGINNER_TRACK ? `${trackName(id)} · ${t("settings.beginner")}` : trackName(id)] as [string, string])], (track) => set({ track }))}
      {row(t("settings.mirror"), s.mirror, [["off", t("settings.off")], ["on", t("settings.on")], ["mix", t("settings.mirrorMix")]] as [MirrorSetting, string][], (mirror) => set({ mirror }))}
    </section>
  );
}

function ClueList({ clues, name }: { clues: Clue[]; name: (pid: string) => string }) {
  if (clues.length === 0) return null;
  return (
    <ul className="grid max-w-4xl grid-cols-1 gap-2 text-2xl sm:grid-cols-2">
      {clues.map((c, i) => (
        <li key={i} className="rounded-xl bg-white/10 px-4 py-2">{clueText(c, name)}</li>
      ))}
    </ul>
  );
}

/** Phone reactions float up from the bottom of the TV and fade (3 s). */
function Reactions({ host, byPid, u }: { host: RaceHost; byPid: Map<string, PlayerInfo>; u: number }) {
  const now = performance.now();
  const live = host.reactions.filter((r) => now - r.atMs < 3000);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 overflow-hidden">
      {live.map((r) => (
        <div
          key={r.id}
          className="reaction absolute bottom-0 flex flex-col items-center"
          style={{ left: `${15 + ((r.id * 37) % 60)}%`, fontSize: 64 * u }}
        >
          <span>{REACTIONS[r.e]}</span>
          <span className="rounded-full px-2 font-bold" style={{ fontSize: 14 * u, background: byPid.get(r.pid)?.color, color: "black" }}>
            {byPid.get(r.pid)?.name}
          </span>
        </div>
      ))}
    </div>
  );
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

function FullscreenButton({ on, u }: { on: boolean; u: number }) {
  return (
    <button
      onClick={toggleFullscreen}
      className="rounded-lg bg-black/55 font-bold"
      style={{ padding: `${4 * u}px ${12 * u}px`, fontSize: 18 * u }}
      aria-label={on ? t("host.exitFullscreen") : t("host.fullscreen")}
    >
      {on ? "⤡" : "⤢"} {on ? t("host.exitFullscreen") : t("host.fullscreen")} <span className="opacity-50">(F)</span>
    </button>
  );
}

function MuteButton({ muted, u, onToggle }: { muted: boolean; u: number; onToggle: () => void }) {
  return (
    <button onClick={onToggle} className="rounded-lg bg-black/55 font-bold" style={{ padding: `${4 * u}px ${12 * u}px`, fontSize: 18 * u }} aria-label={muted ? t("host.soundOn") : t("host.soundOff")}>
      {muted ? "🔇" : "🔊"} <span className="opacity-50">(M)</span>
    </button>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return <div className="absolute inset-0 flex flex-col items-center justify-center-safe gap-6 overflow-auto bg-[#0b1d2a]/85 p-6">{children}</div>;
}

function PlayerGrid({ players, vip }: { players: PlayerInfo[]; vip: string | null }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {players.map((p) => (
        <li key={p.pid} className="rounded-xl p-3 font-bold text-black" style={{ background: p.color, opacity: p.on ? 1 : 0.4 }}>
          {p.name}
          {p.pid === vip && " ★"}
          {!p.on && <div className="text-xs font-normal">{t("host.reconnecting")}</div>}
        </li>
      ))}
    </ul>
  );
}

/** Press D to toggle. Shows the numbers the Phase 1 gate needs. Dev-facing, so not in strings/en.json. */
function DebugPanel({ host, players, net, style }: { host: RaceHost; players: PlayerInfo[]; net: { inRate: number; outRate: number; ping: Map<string, number>; bots: number }; style: React.CSSProperties }) {
  const p50 = percentile(host.stats, 50);
  const p95 = percentile(host.stats, 95);
  const fmt = (x: number | null | undefined) => (x == null ? "–" : `${Math.round(x)} ms`);
  const fps = Math.round(host.fps);
  return (
    <div className="pointer-events-none absolute rounded-lg bg-black/60 p-3 font-mono text-xs leading-5" style={style}>
      <div>
        <span className={fps >= 58 ? "text-green-400" : fps >= 45 ? "text-yellow-300" : "text-red-400"}>{fps} fps</span> · msg/s in {net.inRate} · out {net.outRate}
        {net.bots > 0 && ` · ${net.bots} dev bots`}
      </div>
      <div className="font-bold">touch → TV (target &lt; 120 ms)</div>
      <div>
        p50 {fmt(p50)} · p95 {fmt(p95)} · n={host.stats.length}
      </div>
      <div className="opacity-60">player: ping · touch→TV</div>
      {players.map((p) => (
        <div key={p.pid}>
          <span style={{ color: p.color }}>■</span> {p.name}: {fmt(net.ping.get(p.pid))} · {fmt(host.lastStat.get(p.pid))}
          {!p.on && " (offline)"}
        </div>
      ))}
      <div className="opacity-60">
        camera: {host.camera.kind} · D hide · T test trap cut
      </div>
    </div>
  );
}
