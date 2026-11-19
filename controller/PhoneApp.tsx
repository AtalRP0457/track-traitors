"use client";

import { useEffect, useRef, useState } from "react";
import { CAR_COLORS, isValidCode } from "@/shared/constants";
import { randomName } from "@/shared/names";
import { openRoom, send, store } from "@/shared/net";
import { parseMsg, type ErrorMsg, type LobbyMsg, type WelcomeMsg } from "@/shared/protocol";
import type { PartySocket } from "partysocket";

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
  const [error, setError] = useState<ErrorMsg | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<PartySocket | null>(null);

  // Room code from the QR link. If we already have a seat in this room, rejoin straight away.
  useEffect(() => {
    const room = new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";
    setName(randomName());
    if (isValidCode(room)) {
      setCode(room);
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
      send(ws, { v: 1, t: "join", pid: saved?.pid ?? "", seat: saved?.seat ?? "", name: saved?.name ?? name, color: saved?.color ?? color });
    });
    ws.addEventListener("close", () => setConnected(false));
    ws.addEventListener("message", (e) => {
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
        case "error":
          setError(m as unknown as ErrorMsg);
          store.del(seatKey(code));
          ws.close();
          break;
      }
    });
    return () => ws.close();
    // name/color are read once at join time on purpose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, joining]);

  const startReq = () => send(wsRef.current, { v: 1, t: "startreq" });

  // ---------- screens ----------

  if (error) {
    return (
      <Screen>
        <p className="text-2xl font-bold">{error.msg}</p>
        <Big onPress={() => location.assign("/play")}>Try again</Big>
      </Screen>
    );
  }

  if (!code) {
    return (
      <Screen>
        <h1 className="text-3xl font-black">Enter room code</h1>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4))}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          className="w-56 rounded-xl bg-white/10 p-4 text-center font-mono text-5xl tracking-[0.3em] select-text"
          style={{ fontSize: 48 }}
        />
        <Big disabled={!isValidCode(typed)} onPress={() => location.assign(`/play?room=${typed}`)}>
          Next
        </Big>
      </Screen>
    );
  }

  if (!joining) {
    return (
      <Screen>
        <div className="opacity-70">Room {code}</div>
        <h1 className="text-3xl font-black">Your racer</h1>
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold">{name}</span>
          <button onPointerDown={() => setName(randomName())} className="rounded-full bg-white/15 px-4 py-2 text-xl" aria-label="New name">
            🎲
          </button>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {CAR_COLORS.map((c) => (
            <button
              key={c}
              onPointerDown={() => setColor(c)}
              aria-label={`Color ${c}`}
              className="h-14 w-14 rounded-full"
              style={{ background: c, outline: c === color ? "4px solid white" : "none", outlineOffset: 3 }}
            />
          ))}
        </div>
        <Big onPress={() => setJoining(true)}>Join</Big>
      </Screen>
    );
  }

  if (!me || !lobby) {
    return (
      <Screen>
        <p className="text-2xl">{connected ? "Joining…" : "Connecting…"}</p>
      </Screen>
    );
  }

  const isVip = lobby.vip === me.pid;
  return (
    <Screen>
      <Dot ok={connected && lobby.host} />
      <div className="h-16 w-16 rounded-full" style={{ background: me.color }} />
      <h1 className="text-3xl font-black">{me.name}</h1>
      {!lobby.host && <p className="text-xl text-yellow-300">Host disconnected — waiting…</p>}
      <p className="text-xl opacity-80">{lobby.players.length} in the lobby</p>
      {isVip ? (
        <Big onPress={startReq}>Start race</Big>
      ) : (
        <p className="text-xl opacity-80">Waiting for {lobby.players.find((p) => p.pid === lobby.vip)?.name ?? "host"} to start…</p>
      )}
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

function Dot({ ok }: { ok: boolean }) {
  return <span className="absolute right-4 top-4 h-4 w-4 rounded-full" style={{ background: ok ? "#3DDC84" : "#FF4D6D" }} />;
}
