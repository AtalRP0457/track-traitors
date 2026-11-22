"use client";

import QRCode from "qrcode";
import { useEffect, useReducer, useRef, useState } from "react";
import { analytics } from "@/shared/analytics";
import { DEFAULT_TRACK, LAPS, MAX_PLAYERS, randomCode } from "@/shared/constants";
import { t } from "@/shared/strings";
import { openRoom, randomToken, send, store } from "@/shared/net";
import { parseMsg, type AnyMsg, type LobbyMsg, type PlayerInfo } from "@/shared/protocol";
import type { PartySocket } from "partysocket";
import { Director } from "./camera";
import { DevBotRelay } from "./devbots";
import { percentile, RaceHost } from "./race";
import { parseTrack, trackUrl } from "@/shared/track-format";
import { buildTrack } from "./track";

const HOST_KEY = "tt-host";

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
    hostRef.current = new RaceHost(null, (m) => tx(m), rerender, analytics.log);
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
          host.start();
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
        const res = await fetch(trackUrl(DEFAULT_TRACK));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        host.track = buildTrack(parseTrack(await res.json()));
      } catch (e) {
        setTrackError(t("host.trackError", { id: DEFAULT_TRACK, err: (e as Error).message }));
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
      // Dev: fake a trap hit on the leader to try the trap-cut camera before traps exist.
      if (k === "t" && process.env.NODE_ENV !== "production" && host.race) {
        const lead = host.race.cars.reduce((a, b) => (b.dist > a.dist ? b : a));
        const p = host.pose(lead.pid)!;
        director.trapHit(p.x, p.y, performance.now(), host.renderTick);
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
      setCursorHidden(false);
      clearTimeout(timer);
      timer = setTimeout(() => setCursorHidden(true), 3000);
    };
    wake();
    window.addEventListener("pointermove", wake);
    window.addEventListener("pointerdown", wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
    };
  }, []);

  const newRoom = () => {
    store.del(HOST_KEY);
    location.reload();
  };

  const byPid = new Map((lobby?.players ?? []).map((p) => [p.pid, p]));
  const phase = host.phase;
  const cam = host.camera;
  const L = cam.layout;
  const u = L?.u ?? 1;
  const racing = (phase === "race" || phase === "countdown") && host.race;
  const showBanner = host.banner && host.race && host.race.tick - host.banner.tick < 180;
  const straggler = cam.straggler ? byPid.get(cam.straggler) : undefined;

  return (
    <main className="fixed inset-0 overflow-hidden" style={{ cursor: cursorHidden ? "none" : undefined }}>
      <div ref={canvasRef} className="absolute inset-0" />

      {phase === "lobby" && (
        <Overlay>
          <div className="flex flex-wrap items-center justify-center gap-12">
            <div className="text-center">
              <div className="text-xl uppercase tracking-widest opacity-70">{t("host.roomCode")}</div>
              <div className="font-mono text-8xl font-black tracking-[0.2em]">{code ?? "····"}</div>
              <div className="mt-2 text-lg opacity-70">{joinUrl}</div>
              <div className="mt-2 text-sm">
                <span className={online ? "text-green-400" : "text-red-400"}>●</span> {online ? t("host.serverOk") : t("host.serverWait")}
              </div>
            </div>
            {qr && <img src={qr} alt={t("host.qrAlt")} className="h-72 w-72 rounded-2xl bg-white p-2" />}
          </div>
          <section className="w-full max-w-3xl">
            <h2 className="mb-3 text-2xl font-bold">{t("host.players", { n: lobby?.players.length ?? 0, max: MAX_PLAYERS })}</h2>
            <PlayerGrid players={lobby?.players ?? []} vip={lobby?.vip ?? null} />
            {lobby && lobby.players.length === 0 && <p className="opacity-70">{t("host.scanToJoin")}</p>}
          </section>
          <div className="flex items-center gap-6">
            <button
              onClick={() => host.start()}
              disabled={!lobby || lobby.players.length === 0 || !host.track}
              className="rounded-2xl px-8 py-4 text-2xl font-black text-black disabled:opacity-30"
              style={{ background: "var(--racer)" }}
            >
              {t("race.startRace")}
            </button>
            <button onClick={newRoom} className="text-sm underline opacity-50">
              {t("host.newCode")}
            </button>
          </div>
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

          {/* Straggler window frame + name. */}
          {straggler && (
            <div
              className="pointer-events-none absolute rounded-lg ring-4"
              style={{ left: L.straggler.x, top: L.straggler.y, width: L.straggler.w, height: L.straggler.h, boxShadow: `0 0 0 ${4 * u}px ${straggler.color}` }}
            >
              <div className="absolute -top-1 left-0 -translate-y-full rounded bg-black/60 px-2 font-bold" style={{ fontSize: 16 * u }}>
                {t("host.farBehind", { name: straggler.name })}
              </div>
            </div>
          )}

          {/* Positions tower, right edge. */}
          <ol className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 space-y-1 overflow-hidden rounded-l-2xl bg-black/55 font-bold" style={{ width: L.towerW, padding: 12 * u, fontSize: 22 * u }}>
            {[...host.race!.cars]
              .sort((a, b) => (a.finishMs ?? Infinity) - (b.finishMs ?? Infinity) || b.dist - a.dist)
              .map((c, i) => {
                const p = byPid.get(c.pid);
                return (
                  <li key={c.pid} className="flex items-center" style={{ gap: 8 * u }}>
                    <span className="opacity-70" style={{ width: 24 * u }}>{i + 1}</span>
                    <span className="rounded-full" style={{ background: p?.color, width: 14 * u, height: 14 * u }} />
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
            <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-2xl bg-black/65 font-black" style={{ top: L.pad, padding: `${8 * u}px ${24 * u}px`, fontSize: 36 * u }}>
              {t(host.banner!.key, host.banner!.vars)}
            </div>
          )}
          {cam.slowmo && (
            <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded bg-[var(--traitor)] font-black uppercase tracking-widest text-black" style={{ top: L.pad + 80 * u, padding: `${2 * u}px ${10 * u}px`, fontSize: 16 * u }}>
              {t("host.slowmo")}
            </div>
          )}
        </>
      )}

      {/* Bottom left: room code + fullscreen (outside the lobby, which shows them big). */}
      {phase !== "lobby" && (
        <div className="absolute flex items-center font-bold" style={{ left: L?.pad ?? 16, bottom: L?.pad ?? 16, gap: 12 * u }}>
          <span className="rounded-lg bg-black/55 font-mono tracking-widest" style={{ padding: `${4 * u}px ${12 * u}px`, fontSize: 22 * u }}>
            {t("host.roomShort", { code: code ?? "" })}
          </span>
          <FullscreenButton on={fullscreen} u={u} />
        </div>
      )}
      {phase === "lobby" && (
        <div className="absolute bottom-4 left-4 z-10">
          <FullscreenButton on={fullscreen} u={1} />
        </div>
      )}

      {phase === "results" && (
        <Overlay>
          <h1 className="text-6xl font-black">{t("host.results")}</h1>
          <ol className="w-full max-w-xl space-y-2">
            {host.results.map((r, i) => {
              const p = byPid.get(r.pid);
              return (
                <li key={r.pid} className="flex items-center gap-4 rounded-xl bg-white/10 p-3 text-2xl font-bold">
                  <span className="w-10 text-3xl">{["🥇", "🥈", "🥉"][i] ?? i + 1}</span>
                  <span className="h-5 w-5 rounded-full" style={{ background: p?.color }} />
                  <span>{p?.name ?? t("host.leftRoom")}</span>
                  <span className="ml-auto font-mono text-xl opacity-80">{r.ms !== null ? (r.ms / 1000).toFixed(2) + "s" : t("host.dnf")}</span>
                </li>
              );
            })}
          </ol>
          <div className="flex gap-4">
            <button onClick={() => host.start()} className="rounded-2xl px-8 py-4 text-2xl font-black text-black" style={{ background: "var(--racer)" }}>
              {t("race.raceAgain")}
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

function Overlay({ children }: { children: React.ReactNode }) {
  return <div className="absolute inset-0 flex flex-col items-center justify-center gap-8 overflow-auto bg-[#0b1d2a]/85 p-8">{children}</div>;
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
        camera: {host.camera.kind}
        {host.camera.slowmo && " (slow-mo)"} · D hide · T test trap cut
      </div>
    </div>
  );
}
