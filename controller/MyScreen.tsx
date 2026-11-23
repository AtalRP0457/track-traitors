"use client";

// "My screen": the phone's own view behind the steering buttons (PLAN.md 5). Never video: it is
// drawn here from small car snapshots (15/s) and the track's pre-made background image.
// Rules: half resolution, max 30 fps (drops to 15, then to a still picture if the phone is slow),
// darkened so the buttons stay readable, and it stops completely when hidden or switched off.

import { useEffect, useRef } from "react";
import { fetchTrackFile, type TrackFile } from "@/shared/track-format";

export interface Snap { at: number; c: number[] }

/** Latest snapshots, written by the socket handler without re-rendering React. */
export class SnapStore {
  ids: string[] = [];
  prev: Snap | null = null;
  cur: Snap | null = null;
  push(c: number[], ids?: string[]) {
    if (ids) this.ids = ids;
    this.prev = this.cur;
    this.cur = { at: performance.now(), c };
  }
  clear() {
    this.prev = this.cur = null;
  }
}

/** World px shown across the screen's short side. */
const VIEW_PX = 560;
const RES = 0.5;
const BG_SCALE = 0.5;

export default function MyScreen({ trackId, me, store, cars }: {
  trackId: string;
  me: string;
  store: SnapStore;
  /** pid → color and car number. */
  cars: Map<string, { color: string; n: number }>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const carsRef = useRef(cars);
  carsRef.current = cars;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !trackId) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    let def: TrackFile | null = null;
    let bg: HTMLCanvasElement | null = null;
    let raf = 0;
    let last = 0;
    let gap = 1000 / 30; // frame cap: 30 fps, then 15, then still
    let cost = 0;
    let still = false;
    let cancelled = false;

    fetchTrackFile(trackId)
      .then((d) => {
        if (cancelled) return;
        def = d;
        const img = new Image();
        img.onload = () => {
          if (cancelled || !def) return;
          // Rasterize the SVG once, small; every frame then only blits it.
          const c = document.createElement("canvas");
          c.width = Math.round(def.world.w * BG_SCALE);
          c.height = Math.round(def.world.h * BG_SCALE);
          const g = c.getContext("2d")!;
          if (def.mirror) g.setTransform(-1, 0, 0, 1, c.width, 0);
          g.drawImage(img, 0, 0, c.width, c.height);
          bg = c;
        };
        img.src = d.background;
      })
      .catch(() => {});

    const resize = () => {
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * RES));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * RES));
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = (now: number) => {
      const W = canvas.width, H = canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#0c3550";
      ctx.fillRect(0, 0, W, H);
      const { cur, prev, ids } = store;
      if (!cur || !def) return;
      // Interpolate between the last two snapshots (about one snapshot behind real time).
      const span = prev ? Math.max(1, cur.at - prev.at) : 1;
      const u = prev ? Math.min(1, (now - cur.at) / span) : 1;
      const at = (k: number) => {
        const b = cur.c[k];
        const a = prev && prev.c.length === cur.c.length ? prev.c[k] : b;
        return a + (b - a) * u;
      };
      const ang = (k: number) => {
        const b = cur.c[k] / 100;
        const a = prev && prev.c.length === cur.c.length ? prev.c[k] / 100 : b;
        const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
        return a + d * u;
      };
      const mine = ids.indexOf(me);
      if (mine < 0) return;
      const mx = at(mine * 3), my = at(mine * 3 + 1), ma = ang(mine * 3 + 2);
      const scale = Math.min(W, H) / VIEW_PX;
      // My car sits low in the middle, always pointing up.
      ctx.translate(W / 2, H * 0.66);
      ctx.scale(scale, scale);
      ctx.rotate(-ma - Math.PI / 2);
      ctx.translate(-mx, -my);
      if (bg) ctx.drawImage(bg, 0, 0, def.world.w, def.world.h);
      for (let i = 0; i < ids.length; i++) {
        const info = carsRef.current.get(ids[i]);
        const x = at(i * 3), y = at(i * 3 + 1), a = ang(i * 3 + 2);
        if (Math.abs(x - mx) > VIEW_PX * 1.2 || Math.abs(y - my) > VIEW_PX * 1.2) continue;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(a);
        ctx.fillStyle = "rgba(0,0,0,0.3)";
        ctx.fillRect(-17, -9, 38, 24);
        ctx.fillStyle = info?.color ?? "#ffffff";
        ctx.fillRect(-19, -12, 38, 24);
        ctx.fillStyle = "#1b2a38";
        ctx.fillRect(3, -7, 9, 14);
        if (i === mine) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 3;
          ctx.strokeRect(-19, -12, 38, 24);
        }
        ctx.restore();
      }
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < gap - 2) return;
      last = now;
      const t0 = performance.now();
      draw(now);
      // Slow phone: 30 → 15 fps → a still picture.
      cost = cost * 0.9 + (performance.now() - t0) * 0.1;
      if (cost > 14 && gap < 60) gap = 1000 / 15;
      else if (cost > 30) {
        still = true;
        cancelAnimationFrame(raf);
      }
    };
    const start = () => {
      if (!still && document.visibilityState === "visible") {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(loop);
      }
    };
    const onVis = () => (document.visibilityState === "visible" ? start() : cancelAnimationFrame(raf));
    document.addEventListener("visibilitychange", onVis);
    start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [trackId, me, store]);

  return (
    <>
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" style={{ imageRendering: "auto" }} />
      {/* Darken so the buttons stay readable. */}
      <div className="pointer-events-none absolute inset-0 bg-black/40" />
    </>
  );
}
