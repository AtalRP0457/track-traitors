// Dev-only link between the host tab and the /dev tab in the SAME browser (BroadcastChannel,
// never the network). The host tells fake phones which button a bot would press; the fake phone
// then sends that input over the real network path like a finger would.

export type DevMsg =
  /** /dev → host: these pids are fake phones in this room (sent every second). */
  | { v: 1; t: "bots"; room: string; pids: string[] }
  /** host → /dev: bot pid should now hold steer s. */
  | { v: 1; t: "steer"; room: string; pid: string; s: -1 | 0 | 1 };

export function openDevChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("tt-dev");
}
