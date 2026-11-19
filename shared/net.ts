// Browser-side helpers for reaching the room server.

import { PartySocket } from "partysocket";
import { PARTY_NAME } from "./constants";
import { encode, type AnyMsg } from "./protocol";

/** Room server address. In dev the room server runs on the same machine as the web server, port 1999. */
export function partyHost(): string {
  return process.env.NEXT_PUBLIC_PARTY_HOST || `${window.location.hostname}:1999`;
}

export function openRoom(code: string, role: "host" | "phone"): PartySocket {
  return new PartySocket({
    host: partyHost(),
    party: PARTY_NAME,
    room: code,
    query: { role },
    // Reconnect fast after a phone unlock or Wi-Fi blip.
    minReconnectionDelay: 200,
    maxReconnectionDelay: 2000,
  });
}

export function send(ws: PartySocket | null, msg: AnyMsg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
}

export function randomToken(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** localStorage can throw (private mode, blocked storage); never let that break play. */
export const store = {
  get<T>(key: string): T | null {
    try {
      const s = localStorage.getItem(key);
      return s ? (JSON.parse(s) as T) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  del(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};
