// Cloudflare Worker entry: one Durable Object ("Room") per room code.

import { routePartykitRequest, Server, type Connection, type ConnectionContext } from "partyserver";
import { isValidCode } from "../shared/constants";
import { encode } from "../shared/protocol";
import { RoomCore } from "./core";

interface Env {
  Room: DurableObjectNamespace<Room>;
  /** Cloudflare rate limiter (wrangler.jsonc). Optional so tests/old configs still run. */
  CONNECT_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

export class Room extends Server<Env> {
  private core!: RoomCore;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  // partysocket reuses the same connection id across reconnect attempts, so a late close
  // from an old socket could erase the new one. Give every socket its own key instead.
  private keys = new WeakMap<Connection, string>();
  private socks = new Map<string, Connection>();
  private nextKey = 0;

  onStart() {
    this.core = new RoomCore(this.name, {
      send: (key, msg) => this.socks.get(key)?.send(encode(msg)),
      close: (key) => this.socks.get(key)?.close(4000, "replaced"),
      setTimer: (key, ms, fn) => {
        this.stopTimer(key);
        this.timers.set(key, setTimeout(() => (this.timers.delete(key), fn()), ms));
      },
      clearTimer: (key) => this.stopTimer(key),
      randomId: () => crypto.randomUUID().replaceAll("-", "").slice(0, 10),
    });
  }

  private stopTimer(key: string) {
    const t = this.timers.get(key);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(key);
  }

  onConnect(conn: Connection, ctx: ConnectionContext) {
    const role = new URL(ctx.request.url).searchParams.get("role") === "host" ? "host" : "phone";
    const key = `c${++this.nextKey}`;
    this.keys.set(conn, key);
    this.socks.set(key, conn);
    this.core.connect(key, role);
  }

  onMessage(conn: Connection, message: string | ArrayBuffer) {
    const key = this.keys.get(conn);
    if (key) this.core.message(key, message);
  }

  onClose(conn: Connection) {
    this.drop(conn);
  }

  onError(conn: Connection) {
    this.drop(conn);
  }

  private drop(conn: Connection) {
    const key = this.keys.get(conn);
    if (!key) return;
    this.keys.delete(conn);
    this.socks.delete(key);
    this.core.disconnect(key);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env, {
        onBeforeConnect: async (req, { name }) => {
          if (!isValidCode(name)) return new Response("Bad room code", { status: 400 });
          const ip = req.headers.get("cf-connecting-ip") ?? "local";
          try {
            const { success } = (await env.CONNECT_LIMIT?.limit({ key: ip })) ?? { success: true };
            if (!success) return new Response("Too many connections, slow down", { status: 429 });
          } catch {} // limiter unavailable: never block play
          return undefined;
        },
      })) || new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
