"use client";

import { useEffect, useRef } from "react";
import { t } from "@/shared/strings";

/**
 * Two big steering halves. Reacts on pointerdown (never click), supports multi-touch,
 * lights up instantly before anything goes over the network.
 * onSteer is called only when the steering value actually changes.
 */
export default function Controls({ color, onSteer, bottom = 0 }: { color: string; onSteer: (s: -1 | 0 | 1, at: number) => void; bottom?: number }) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const down = useRef({ left: new Set<number>(), right: new Set<number>() });
  const last = useRef<-1 | 0 | 1>(0);
  const onSteerRef = useRef(onSteer);
  onSteerRef.current = onSteer;

  useEffect(() => {
    const left = leftRef.current!;
    const right = rightRef.current!;

    const update = (at: number) => {
      const l = down.current.left.size > 0;
      const r = down.current.right.size > 0;
      left.style.background = l ? color : "rgba(255,255,255,0.08)";
      right.style.background = r ? color : "rgba(255,255,255,0.08)";
      const s: -1 | 0 | 1 = l === r ? 0 : l ? -1 : 1;
      if (s !== last.current) {
        last.current = s;
        if (s !== 0) navigator.vibrate?.(8);
        onSteerRef.current(s, at);
      }
    };

    const bind = (el: HTMLElement, side: "left" | "right") => {
      const press = (e: PointerEvent) => {
        e.preventDefault();
        down.current[side].add(e.pointerId);
        update(e.timeStamp);
        // Keep receiving this finger's events even if it slides off the button. Nice to have; never block steering.
        try {
          el.setPointerCapture(e.pointerId);
        } catch {}
      };
      const release = (e: PointerEvent) => {
        if (!down.current[side].delete(e.pointerId)) return;
        update(e.timeStamp);
      };
      el.addEventListener("pointerdown", press);
      el.addEventListener("pointerup", release);
      el.addEventListener("pointercancel", release);
      el.addEventListener("lostpointercapture", release);
      return () => {
        el.removeEventListener("pointerdown", press);
        el.removeEventListener("pointerup", release);
        el.removeEventListener("pointercancel", release);
        el.removeEventListener("lostpointercapture", release);
      };
    };

    const unbindL = bind(left, "left");
    const unbindR = bind(right, "right");

    // Page hidden (lock, app switch): let go of everything so the car doesn't keep turning.
    const onHide = () => {
      if (document.visibilityState !== "hidden") return;
      down.current.left.clear();
      down.current.right.clear();
      update(performance.now());
    };
    document.addEventListener("visibilitychange", onHide);
    // iOS Safari: block pinch-zoom gestures.
    const block = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", block);

    return () => {
      unbindL();
      unbindR();
      document.removeEventListener("visibilitychange", onHide);
      document.removeEventListener("gesturestart", block);
    };
  }, [color]);

  const half = "flex flex-1 items-center justify-center text-8xl font-black transition-none";
  return (
    <div className="absolute inset-0 flex gap-2 p-2 pt-14" style={{ paddingBottom: 8 + bottom }}>
      <div ref={leftRef} className={half + " rounded-3xl"} style={{ background: "rgba(255,255,255,0.08)", touchAction: "none" }} aria-label={t("phone.steerLeft")}>
        ◀
      </div>
      <div ref={rightRef} className={half + " rounded-3xl"} style={{ background: "rgba(255,255,255,0.08)", touchAction: "none" }} aria-label={t("phone.steerRight")}>
        ▶
      </div>
    </div>
  );
}
