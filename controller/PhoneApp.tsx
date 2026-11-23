"use client";

import { useEffect, useRef, useState } from "react";
import { analytics } from "@/shared/analytics";
import { CAR_COLORS, HEARTBEAT_MS, isValidCode, LAPS, PING_MS, RTT_GREEN, RTT_YELLOW } from "@/shared/constants";
import { randomName } from "@/shared/names";
import { openRoom, send, store } from "@/shared/net";
import { NetSim, simFromQuery } from "@/shared/netsim";
import { ordinal, t } from "@/shared/strings";
import { parseMsg, type AnyMsg, type BotInfo, type Clue, type ErrorMsg, type LobbyMsg, type Phase, type ResultMsg, type RoleMsg, type WelcomeMsg } from "@/shared/protocol";
import type { Card } from "@/shared/rules";
import type { PartySocket } from "partysocket";
import Controls from "./Controls";
import { Draft, GlitchPicker, Reactions, RoleCard, Tap, Vote, type Seat as SeatInfo } from "./MatchScreens";

type Seat = { pid: string; seat: string; name: string; color: string };
const seatKey = (code: string) => `tt-seat-${code}`;

export default function PhoneApp() {
  const [code, setCode] = useState("");
  const [typed, setTyped] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState(CAR_COLORS[0]);
  const [joining, setJoining] = useState(false);
  const [me, setMe] = useState<Seat | null>(null);
  const [lobby, setLobby] = useState<LobbyMsg | null>(null);
  const [phase, setPhase] = useState<Phase>("lobby");
  const [countdownEnd, setCountdownEnd] = useState(0);
  const [lap, setLap] = useState(0);
  const [result, setResult] = useState<ResultMsg | null>(null);
  const [error, setError] = useState<ErrorMsg | null>(null);
  const [connected, setConnected] = useState(false);
  const [rtt, setRtt] = useState<{ ms: number; viaHost: boolean } | null>(null);
  const [tt, setTt] = useState<number | null>(null);
  const [, setNow] = useState(0);
  // Traitors match state (secrets here are only this phone's own).
  const [role, setRole] = useState<RoleMsg | null>(null);
  const [draft, setDraft] = useState<{ cards: Card[]; n: number; endAt: number; track: string } | null>(null);
  const [mine, setMine] = useState<[Card, number, number][]>([]);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [bots, setBots] = useState<BotInfo[]>([]);
  const [info, setInfo] = useState<{ race?: number; races?: number; clues: Clue[]; endAt: number }>({ clues: [], endAt: 0 });
  const [voted, setVoted] = useState<string | null>(null);
  const [voteResult, setVoteResult] = useState<{ caught: string | null; traitor: boolean } | null>(null);
  const [caught, setCaught] = useState<string[]>([]);
  const [reveal, setReveal] = useState<string[] | null>(null);
  const [glitchedUntil, setGlitchedUntil] = useState(0);
  const [glitchUsed, setGlitchUsed] = useState(false);
  const [picking, setPicking] = useState(false);
  const wsRef = useRef<PartySocket | null>(null);
  // Dev: ?lag=&jitter=&loss= on the /play URL simulates a bad network on this phone.
  const sim = useRef<NetSim | null>(null);
  if (!sim.current) sim.current = new NetSim(typeof location === "undefined" ? undefined : simFromQuery(new URLSearchParams(location.search)));
  /** Send through the (optional) network simulator. Steering input may be dropped by it. */
  const tx = (msg: AnyMsg) => sim.current!.out(() => send(wsRef.current, msg), msg.t === "in");

  // Input state lives in refs: it changes faster than React should re-render.
  const input = useRef({ s: 0 as -1 | 0 | 1, k: 0 });
  const touchAt = useRef(new Map<number, number>());
  const pings = useRef(new Map<number, number>());
  const rtts = useRef<number[]>([]);

  // Room code from the QR link. If we already have a seat in this room, rejoin straight away.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const room = q.get("room")?.toUpperCase() ?? "";
    setName(randomName());
    if (isValidCode(room)) {
      setCode(room);
      analytics.setContext({ role: "phone", room });
      if (!store.get<Seat>(seatKey(room))) analytics.log({ e: "join_opened", via: q.get("via") === "code" ? "code" : "qr" });
      if (store.get<Seat>(seatKey(room))) setJoining(true);
    }
  }, []);

  useEffect(() => {
    if (!code || !joining) return;
    const ws = openRoom(code, "phone");
    wsRef.current = ws;
    ws.addEventListener("open", () => {
      setConnected(true);
      const saved = store.get<Seat>(seatKey(code));
      tx({ v: 1, t: "join", pid: saved?.pid ?? "", seat: saved?.seat ?? "", name: saved?.name ?? name, color: saved?.color ?? color });
    });
    ws.addEventListener("close", () => setConnected(false));
    ws.addEventListener("message", sim.current!.in((e: MessageEvent) => {
      const m = parseMsg(e.data);
      if (!m) return;
      switch (m.t) {
        case "welcome": {
          const w = m as unknown as WelcomeMsg;
          const seat = { pid: w.pid, seat: w.seat, name: w.name, color: w.color };
          store.set(seatKey(code), seat);
          setMe(seat);
          setError(null);
          break;
        }
        case "lobby":
          setLobby(m as unknown as LobbyMsg);
          break;
        case "phase": {
          const ph = m.phase as Phase;
          setPhase(ph);
          const endAt = performance.now() + Number(m.ms ?? 0);
          setInfo({ race: m.race as number | undefined, races: m.races as number | undefined, clues: (m.clues as Clue[]) ?? [], endAt });
          if (ph === "lobby") {
            setRole(null);
            setScores({});
            setBots([]);
          }
          if (ph === "role") {
            setReveal(null);
            setCaught([]);
            setVoteResult(null);
          }
          if (ph === "draft") setVoteResult(null);
          if (ph !== "draft") setDraft(null);
          if (ph === "vote") setVoted(null);
          if (ph === "race") setGlitchUsed(false);
          if (ph !== "race") setPicking(false);
          if (ph === "countdown") {
            setCountdownEnd(performance.now() + Number(m.ms ?? 0));
            setLap(0);
            setResult(null);
            input.current.s = 0;
          }
          break;
        }
        case "lap":
          setLap(Number(m.lap));
          break;
        case "role":
          setRole(m as unknown as RoleMsg);
          break;
        case "draft":
          setDraft({ cards: m.cards as Card[], n: Number(m.n), endAt: performance.now() + Number(m.ms ?? 0), track: String(m.track) });
          break;
        case "mytraps":
          setMine(m.list as [Card, number, number][]);
          break;
        case "scores":
          setScores(m.scores as Record<string, number>);
          break;
        case "seats":
          setBots(m.bots as BotInfo[]);
          break;
        case "voteresult": {
          const vr = { caught: (m.caught as string | null) ?? null, traitor: m.traitor === true };
          setVoteResult(vr);
          if (vr.caught && vr.traitor) setCaught((c) => [...c, vr.caught!]);
          break;
        }
        case "reveal":
          setReveal((m.traitors as string[]) ?? []);
          break;
        case "glitched":
          setGlitchedUntil(performance.now() + Number(m.ms));
          navigator.vibrate?.([60, 40, 60]);
          break;
        case "glitchok":
          if (m.ok) setGlitchUsed(true);
          break;
        case "result":
          setResult(m as unknown as ResultMsg);
          break;
        case "pong": {
          const sent = pings.current.get(Number(m.k));
          if (sent === undefined) break;
          pings.current.delete(Number(m.k));
          rtts.current.push(performance.now() - sent);
          if (rtts.current.length > 5) rtts.current.shift();
          setRtt({ ms: median(rtts.current), viaHost: m.h === 1 });
          break;
        }
        case "ack": {
          // Host drew our input k. Touch → TV ≈ (ack arrival − touch) − one-way trip back (≈ RTT / 2).
          const at = touchAt.current.get(Number(m.k));
          if (at === undefined) break;
          touchAt.current.delete(Number(m.k));
          const half = rtts.current.length ? median(rtts.current) / 2 : 0;
          const ms = Math.max(0, performance.now() - at - half);
          setTt(ms);
          tx({ v: 1, t: "stat", tt: Math.round(ms) });
          break;
        }
        case "error":
          setError(m as unknown as ErrorMsg);
          store.del(seatKey(code));
          ws.close();
          break;
      }
    }));

    // Ping for the latency dot; heartbeat re-sends the current input once a second.
    let pk = 0;
    const pingId = setInterval(() => {
      pings.current.set(++pk, performance.now());
      if (pings.current.size > 10) pings.current.delete(pk - 10);
      tx({ v: 1, t: "ping", k: pk, r: rtts.current.length ? Math.round(median(rtts.current)) : undefined });
    }, PING_MS);
    const beatId = setInterval(() => {
      tx({ v: 1, t: "in", s: input.current.s, b: 0, g: 0, k: input.current.k });
    }, HEARTBEAT_MS);

    // Back from lock screen: don't wait for the backoff timer, reconnect now.
    const onVisible = () => {
      if (document.visibilityState === "visible" && ws.readyState !== WebSocket.OPEN) ws.reconnect();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(pingId);
      clearInterval(beatId);
      document.removeEventListener("visibilitychange", onVisible);
      ws.close();
    };
    // name/color are read once at join time on purpose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, joining]);

  // Keep the screen awake while racing.
  const racing = phase === "countdown" || phase === "race";
  useEffect(() => {
    if (!racing || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const grab = () => {
      if (document.visibilityState === "visible") navigator.wakeLock.request("screen").then((l) => (lock = l)).catch(() => {});
    };
    grab();
    document.addEventListener("visibilitychange", grab);
    return () => {
      document.removeEventListener("visibilitychange", grab);
      lock?.release().catch(() => {});
    };
  }, [racing]);

  // Tick the countdown display (and the glitched banner).
  useEffect(() => {
    if (phase !== "countdown" && phase !== "race" && phase !== "role") return;
    const id = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(id);
  }, [phase]);

  const steer = (s: -1 | 0 | 1, at: number) => {
    const k = ++input.current.k;
    input.current.s = s;
    touchAt.current.set(k, at);
    if (touchAt.current.size > 20) touchAt.current.delete(k - 20);
    tx({ v: 1, t: "in", s, b: 0, g: 0, k });
  };

  const startReq = () => tx({ v: 1, t: "startreq" });
  const place = (card: Card, x: number, y: number) => tx({ v: 1, t: "place", card, x, y });
  const vote = (who: string) => {
    setVoted(who);
    navigator.vibrate?.(15);
    tx({ v: 1, t: "vote", who });
  };
  const glitch = (target: string) => {
    setPicking(false);
    setGlitchUsed(true);
    navigator.vibrate?.(20);
    tx({ v: 1, t: "glitch", target });
  };
  const react = (e: number) => {
    navigator.vibrate?.(8);
    tx({ v: 1, t: "react", e });
  };

  // ---------- screens ----------

  if (error) {
    return (
      <Screen>
        <p className="text-2xl font-bold">{t(`error.${error.code}`)}</p>
        <Big onPress={() => location.assign(error.code === "started" ? `/play?room=${code}` : "/play")}>{t("phone.tryAgain")}</Big>
      </Screen>
    );
  }

  if (!code) {
    return (
      <Screen>
        <h1 className="text-3xl font-black">{t("phone.enterCode")}</h1>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4))}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          className="w-56 rounded-xl bg-white/10 p-4 text-center font-mono tracking-[0.3em] select-text"
          style={{ fontSize: 48 }}
        />
        <Big disabled={!isValidCode(typed)} onPress={() => location.assign(`/play?room=${typed}&via=code`)}>
          {t("phone.next")}
        </Big>
      </Screen>
    );
  }

  if (!joining) {
    return (
      <Screen>
        <div className="opacity-70">{t("phone.room", { code })}</div>
        <h1 className="text-3xl font-black">{t("phone.yourRacer")}</h1>
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold">{name}</span>
          <button onPointerDown={() => setName(randomName())} className="rounded-full bg-white/15 px-4 py-2 text-xl" aria-label={t("phone.newName")}>
            🎲
          </button>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {CAR_COLORS.map((c) => (
            <button
              key={c}
              onPointerDown={() => setColor(c)}
              aria-label={t("phone.color", { color: c })}
              className="h-14 w-14 rounded-full"
              style={{ background: c, outline: c === color ? "4px solid white" : "none", outlineOffset: 3 }}
            />
          ))}
        </div>
        <Big onPress={() => setJoining(true)}>{t("phone.join")}</Big>
      </Screen>
    );
  }

  if (!me || !lobby) {
    return (
      <Screen>
        <p className="text-2xl">{connected ? t("phone.joining") : t("phone.connecting")}</p>
      </Screen>
    );
  }

  const hostOk = connected && lobby.host;
  const status = <Status connected={connected} host={lobby.host} rtt={rtt} tt={tt} />;
  const inRace = racing && (lobby.players.some((p) => p.pid === me.pid));
  const seats = new Map<string, SeatInfo>([...lobby.players, ...bots].map((p) => [p.pid, p]));
  const nameOf = (pid: string) => seats.get(pid)?.name ?? "?";
  const traitor = role?.role === "traitor";
  const canGlitch = traitor && !role?.caught && phase === "race" && !glitchUsed && lap < LAPS;
  const raceOf = info.race && info.races ? t("host.raceOf", { race: info.race, races: info.races }) : "";
  const myScore = scores[me.pid];
  /** Same number as on my car and the TV's positions tower (seat order: phones, then bots). */
  const carNo = lobby.players.findIndex((p) => p.pid === me.pid) + 1;

  if (inRace) {
    const left = Math.max(0, Math.ceil((countdownEnd - performance.now()) / 1000));
    const glitched = performance.now() < glitchedUntil;
    return (
      <main className="controller">
        <Controls color={me.color} onSteer={steer} bottom={traitor ? 88 : 0} />
        {traitor && (
          <div className="absolute inset-x-2 bottom-2 flex h-20">
            <Tap
              onTap={() => setPicking(true)}
              disabled={!canGlitch}
              className="flex-1 rounded-3xl text-3xl font-black text-black"
              style={{ background: "var(--traitor)" }}
            >
              {glitchUsed || role?.caught ? t("glitch.used") : t("glitch.button")}
            </Tap>
          </div>
        )}
        {picking && canGlitch && (
          <GlitchPicker rivals={[...seats.values()].filter((p) => p.pid !== me.pid && !(role?.mates ?? []).includes(p.pid))} onPick={glitch} onCancel={() => setPicking(false)} />
        )}
        {glitched && (
          <div className="glitch-static pointer-events-none absolute inset-x-0 top-1/3 flex items-center justify-center py-6 text-3xl font-black" style={{ color: "var(--traitor)" }}>
            {t("glitch.hit")}
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex h-14 items-center justify-between px-4 text-lg font-bold">
          <span className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full text-sm font-black text-[#0b1d2a]" style={{ background: me.color }}>
              {carNo}
            </span>
            {me.name}
          </span>
          <span>{lap >= LAPS ? t("race.finished") : t("race.lap", { lap: Math.min(lap + 1, LAPS), laps: LAPS })}</span>
          {status}
        </div>
        {phase === "countdown" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-9xl font-black">{left || t("race.go")}</div>
        )}
        {!hostOk && <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-yellow-500 p-2 text-center font-bold text-black">{t("race.hostGone")}</div>}
      </main>
    );
  }

  if (phase === "role" && role) {
    return (
      <Screen>
        <div className="absolute right-4 top-4">{status}</div>
        {raceOf && <div className="opacity-70">{raceOf}</div>}
        <RoleCard role={role.role} mates={role.mates} caught={role.caught} seats={seats} />
      </Screen>
    );
  }

  if (phase === "draft" && draft) {
    return (
      <main className="controller flex flex-col">
        <div className="absolute right-3 top-3 z-10">{status}</div>
        <Draft trackId={draft.track} cards={draft.cards} n={draft.n} mine={mine} endAt={draft.endAt} onPlace={place} />
      </main>
    );
  }

  if (phase === "vote") {
    const candidates = lobby.players.filter((p) => p.pid !== me.pid && !caught.includes(p.pid));
    return (
      <main className="controller flex flex-col">
        <Vote candidates={candidates} clues={info.clues} name={nameOf} endAt={info.endAt} voted={voted} onVote={vote} />
      </main>
    );
  }

  const isVip = lobby.vip === me.pid;
  const myPlace = result ? result.places.findIndex((p) => p.pid === me.pid) : -1;
  const ranking = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const overall = ranking.findIndex(([pid]) => pid === me.pid);
  const between = phase === "results" || phase === "reveal" || phase === "draft" || phase === "role";
  return (
    <Screen>
      <div className="absolute right-4 top-4">{status}</div>
      {raceOf && phase !== "lobby" && phase !== "podium" && <div className="opacity-70">{raceOf}</div>}
      <div className="h-16 w-16 rounded-full" style={{ background: me.color }} />
      <h1 className="text-3xl font-black">{me.name}</h1>
      {!lobby.host && <p className="text-xl text-yellow-300">{t("race.hostGone")}</p>}
      {phase === "results" && myPlace >= 0 && (
        <p className="text-4xl font-black">
          {t("phone.place", { medal: ["🥇", "🥈", "🥉"][myPlace] ?? "", n: ordinal(myPlace + 1) })}
        </p>
      )}
      {phase === "reveal" && voteResult && (
        <p className="text-3xl font-black" style={{ color: voteResult.traitor ? "var(--traitor)" : "var(--racer)" }}>
          {voteResult.caught ? t(voteResult.traitor ? "reveal.caughtTraitor" : "reveal.innocent", { name: nameOf(voteResult.caught) }) : t("reveal.nobody")}
        </p>
      )}
      {phase === "podium" && overall >= 0 && (
        <p className="text-4xl font-black">{["🥇", "🥈", "🥉"][overall] ?? ""} {t("phone.overall", { n: ordinal(overall + 1) })}</p>
      )}
      {phase === "podium" && reveal && (
        <p className="text-2xl font-bold" style={{ color: "var(--traitor)" }}>
          {reveal.includes(me.pid)
            ? t("phone.youWereTraitor")
            : reveal.length === 0
              ? t("podium.noTraitors")
              : t(reveal.length > 1 ? "podium.traitors" : "podium.traitor", { names: reveal.map(nameOf).join(", ") })}
        </p>
      )}
      {myScore !== undefined && phase !== "lobby" && <p className="text-2xl font-bold">{t("phone.score", { n: myScore })}</p>}
      {between && <p className="text-xl opacity-80">📺 {t("phone.watchTv")}</p>}
      {(phase === "lobby" || phase === "podium") && (
        <>
          <p className="text-xl opacity-80">{t("phone.inRoom", { n: lobby.players.length })}</p>
          {isVip ? (
            <Big onPress={startReq}>{phase === "podium" ? t("race.playAgain") : t("race.startMatch")}</Big>
          ) : (
            <p className="text-xl opacity-80">{t("phone.waitingFor", { name: lobby.players.find((p) => p.pid === lobby.vip)?.name ?? t("phone.theHost") })}</p>
          )}
        </>
      )}
      <Reactions onReact={react} />
    </Screen>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return <main className="controller flex flex-col items-center justify-center gap-6 p-6 text-center">{children}</main>;
}

/** Big button that fires on pointerdown (never click) for instant response. */
function Big({ children, onPress, disabled }: { children: React.ReactNode; onPress: () => void; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onPointerDown={(e) => {
        e.preventDefault();
        if (!disabled) onPress();
      }}
      className="w-full max-w-xs rounded-2xl py-5 text-2xl font-black text-black active:scale-95 disabled:opacity-40"
      style={{ background: "var(--racer)" }}
    >
      {children}
    </button>
  );
}

/** Latency dot: green / yellow / red from measured round-trip time to the host. */
function Status({ connected, host, rtt, tt }: { connected: boolean; host: boolean; rtt: { ms: number; viaHost: boolean } | null; tt: number | null }) {
  let color = "#FF4D6D";
  if (connected && host && rtt?.viaHost) color = rtt.ms < RTT_GREEN ? "#3DDC84" : rtt.ms < RTT_YELLOW ? "#FFD23F" : "#FF4D6D";
  else if (connected) color = "#FFD23F";
  return (
    <span className="flex items-center gap-2 font-mono text-xs opacity-90">
      {rtt && <span>{Math.round(rtt.ms)}ms{tt !== null && ` · ${Math.round(tt)}`}</span>}
      <span className="h-4 w-4 rounded-full" style={{ background: color }} />
    </span>
  );
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
