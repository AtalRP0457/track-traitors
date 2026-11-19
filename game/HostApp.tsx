"use client";

import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { randomCode } from "@/shared/constants";
import { openRoom, randomToken, send, store } from "@/shared/net";
import { parseMsg, type LobbyMsg } from "@/shared/protocol";
import type { PartySocket } from "partysocket";

const HOST_KEY = "tt-host";

export default function HostApp() {
  const [code, setCode] = useState<string | null>(null);
  const [lobby, setLobby] = useState<LobbyMsg | null>(null);
  const [joinUrl, setJoinUrl] = useState("");
  const [qr, setQr] = useState("");
  const [online, setOnline] = useState(false);
  const wsRef = useRef<PartySocket | null>(null);

  // Pick (or resume) a room. A reload keeps the same room thanks to the stored host token.
  useEffect(() => {
    const saved = store.get<{ code: string; seat: string }>(HOST_KEY);
    const room = saved ?? { code: randomCode(), seat: randomToken() };
    store.set(HOST_KEY, room);
    setCode(room.code);
  }, []);

  useEffect(() => {
    if (!code) return;
    const seat = store.get<{ seat: string }>(HOST_KEY)!.seat;
    const ws = openRoom(code, "host");
    wsRef.current = ws;
    ws.addEventListener("open", () => {
      setOnline(true);
      send(ws, { v: 1, t: "hosthello", seat });
    });
    ws.addEventListener("close", () => setOnline(false));
    ws.addEventListener("message", (e) => {
      const m = parseMsg(e.data);
      if (!m) return;
      if (m.t === "lobby") setLobby(m as unknown as LobbyMsg);
      if (m.t === "error" && m.code === "taken") {
        // Code collision with another live room: start over with a fresh code.
        store.set(HOST_KEY, { code: randomCode(), seat: randomToken() });
        ws.close();
        setCode(store.get<{ code: string }>(HOST_KEY)!.code);
      }
    });
    return () => ws.close();
  }, [code]);

  // QR points phones at /play on this machine's Wi-Fi address, not "localhost".
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    (async () => {
      const { hostname, port, protocol } = window.location;
      let host = hostname;
      if (hostname === "localhost" || hostname === "127.0.0.1") {
        try {
          const { ips } = await (await fetch("/api/lan")).json();
          if (ips[0]) host = ips[0];
        } catch {}
      }
      const url = `${protocol}//${host}${port ? ":" + port : ""}/play?room=${code}`;
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

  const newRoom = () => {
    store.del(HOST_KEY);
    location.reload();
  };

  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-8 p-8">
      <div className="flex flex-wrap items-center justify-center gap-12">
        <div className="text-center">
          <div className="text-xl uppercase tracking-widest opacity-70">Room code</div>
          <div className="font-mono text-8xl font-black tracking-[0.2em]">{code ?? "····"}</div>
          <div className="mt-2 text-lg opacity-70">{joinUrl}</div>
          <div className="mt-2 text-sm">
            <span className={online ? "text-green-400" : "text-red-400"}>●</span> {online ? "Room server connected" : "Connecting to room server…"}
          </div>
        </div>
        {qr && <img src={qr} alt="Scan to join" className="h-72 w-72 rounded-2xl bg-white p-2" />}
      </div>

      <section className="w-full max-w-3xl">
        <h2 className="mb-3 text-2xl font-bold">Players ({lobby?.players.length ?? 0}/8)</h2>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {lobby?.players.map((p) => (
            <li key={p.pid} className="rounded-xl p-3 font-bold text-black" style={{ background: p.color, opacity: p.on ? 1 : 0.4 }}>
              {p.name}
              {p.pid === lobby.vip && " ★"}
              {!p.on && <div className="text-xs font-normal">reconnecting…</div>}
            </li>
          ))}
        </ul>
        {lobby && lobby.players.length === 0 && <p className="opacity-70">Scan the QR code with your phone to join.</p>}
      </section>

      <button onClick={newRoom} className="text-sm underline opacity-50">
        New room code
      </button>
    </main>
  );
}
