"use client";

// Dev-only page (/dev): opens 1–7 fake phone controllers so one person can test an
// 8-player race, with a lag / jitter / packet-loss simulator. Open it in a second tab of the
// same browser as /host: the host steers the bots through a BroadcastChannel.

import { useEffect, useReducer, useRef, useState } from "react";
import { isValidCode, MAX_PLAYERS } from "@/shared/constants";
import { openDevChannel, type DevMsg } from "@/shared/devchannel";
import { store } from "@/shared/net";
import { NO_SIM, type NetSimConfig } from "@/shared/netsim";
import { FakePhone } from "./fakePhone";

const SIM_KEY = "tt-dev-sim";

export default function DevApp() {
  const [room, setRoom] = useState("");
  const [sim, setSim] = useState<NetSimConfig>(NO_SIM);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const phones = useRef<FakePhone[]>([]);
  const nextId = useRef(1);
  const [steerSeen, setSteerSeen] = useState(false);

  // Default to the room the host tab in this browser is showing.
  useEffect(() => {
    setRoom(store.get<{ code: string }>("tt-host")?.code ?? "");
    setSim(store.get<NetSimConfig>(SIM_KEY) ?? NO_SIM);
    const id = setInterval(rerender, 250);
    return () => {
      clearInterval(id);
      phones.current.forEach((p) => p.stop());
      phones.current = [];
    };
  }, []);

  // Tell the host which pids are bots; apply the steering it sends back.
  useEffect(() => {
    const ch = openDevChannel();
    if (!ch) return;
    ch.onmessage = (e: MessageEvent<DevMsg>) => {
      const m = e.data;
      if (m?.v !== 1 || m.t !== "steer") return;
      const p = phones.current.find((x) => x.view.pid === m.pid && x.room === m.room);
      if (p) {
        p.setSteer(m.s);
        setSteerSeen(true);
      }
    };
    const id = setInterval(() => {
      const byRoom = new Map<string, string[]>();
      for (const p of phones.current) if (p.view.pid) byRoom.set(p.room, [...(byRoom.get(p.room) ?? []), p.view.pid]);
      for (const [r, pids] of byRoom) ch.postMessage({ v: 1, t: "bots", room: r, pids } satisfies DevMsg);
    }, 1000);
    return () => {
      clearInterval(id);
      ch.close();
    };
  }, []);

  const setCount = (n: number) => {
    const list = phones.current;
    while (list.length > n) list.pop()!.stop();
    while (list.length < n) list.push(new FakePhone(nextId.current++, room, sim, () => {}));
    rerender();
  };

  const updateSim = (patch: Partial<NetSimConfig>) => {
    const next = { ...sim, ...patch };
    setSim(next);
    store.set(SIM_KEY, next);
    phones.current.forEach((p) => p.setSim(next));
  };

  const list = phones.current;
  const canAdd = isValidCode(room);

  return (
    <main className="min-h-full space-y-6 p-6 font-mono text-sm" style={{ userSelect: "text" }}>
      <h1 className="text-2xl font-black">Dev tools · fake phones</h1>
      <p className="max-w-3xl opacity-70">
        Open <b>/host</b> in another tab of this browser, then add bots here. They join over the real room server and send
        input like a phone (only on change + 1/s heartbeat); the host tab tells them which button to press. Press D on the host for
        fps, ping and messages per second.
      </p>

      <section className="flex flex-wrap items-center gap-3">
        <label>
          Room{" "}
          <input
            value={room}
            onChange={(e) => setRoom(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4))}
            className="w-24 rounded bg-white/10 px-2 py-1 text-lg tracking-widest"
          />
        </label>
        <span className="opacity-70">Fake phones:</span>
        {Array.from({ length: MAX_PLAYERS }, (_, n) => (
          <button
            key={n}
            disabled={!canAdd && n > 0}
            onClick={() => setCount(n)}
            className="h-9 w-9 rounded font-bold disabled:opacity-30"
            style={{ background: list.length === n ? "var(--racer)" : "rgba(255,255,255,0.1)", color: list.length === n ? "black" : undefined }}
          >
            {n}
          </button>
        ))}
        <span className="opacity-60">(1–7 + your own phone = 8)</span>
      </section>

      <section className="grid max-w-xl grid-cols-[8rem_1fr_5rem] items-center gap-x-4 gap-y-2">
        <Slider label="Lag (one way)" unit="ms" max={500} step={10} value={sim.lag} onChange={(lag) => updateSim({ lag })} />
        <Slider label="Jitter" unit="ms" max={200} step={5} value={sim.jitter} onChange={(jitter) => updateSim({ jitter })} />
        <Slider label="Input loss" unit="%" max={50} step={1} value={sim.loss} onChange={(loss) => updateSim({ loss })} />
      </section>
      <p className="opacity-60">
        Same simulator on a real phone: add <code>&amp;lag=80&amp;jitter=20&amp;loss=5</code> to its /play URL.
      </p>

      {list.length > 0 && !steerSeen && (
        <p className="text-yellow-300">No steering from a host tab yet. Bots only steer once a race runs in /host in this same browser.</p>
      )}

      {list.length > 0 && (
        <table className="w-full max-w-4xl text-left">
          <thead className="opacity-60">
            <tr>
              <th>#</th>
              <th>name</th>
              <th>status</th>
              <th>phase</th>
              <th>role</th>
              <th>steer</th>
              <th>rtt</th>
              <th>touch→TV</th>
              <th>msg/s out·in</th>
              <th>dropped</th>
            </tr>
          </thead>
          <tbody>
            {list.map(({ view: v }) => (
              <tr key={v.id}>
                <td>{v.id}</td>
                <td>
                  <span style={{ color: v.color || undefined }}>■</span> {v.name}
                </td>
                <td className={v.status.startsWith("error") ? "text-red-400" : ""}>{v.status}</td>
                <td>{v.phase}</td>
                <td style={{ color: v.role === "traitor" ? "var(--traitor)" : undefined }}>{v.role ?? "–"}</td>
                <td>{v.steer === -1 ? "◀" : v.steer === 1 ? "▶" : "·"}</td>
                <td>{v.rtt === null ? "–" : `${Math.round(v.rtt)} ms`}</td>
                <td>{v.tt === null ? "–" : `${Math.round(v.tt)} ms`}</td>
                <td>
                  {v.outRate}·{v.inRate}
                </td>
                <td>{v.dropped}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function Slider({ label, unit, max, step, value, onChange }: { label: string; unit: string; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <>
      <span>{label}</span>
      <input type="range" min={0} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span>
        {value} {unit}
      </span>
    </>
  );
}
