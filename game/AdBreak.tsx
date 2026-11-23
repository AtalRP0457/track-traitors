"use client";

// One short ad on the big screen between matches (PLAN.md 6). Only mounted between matches, so
// ad code never loads during a race; phones never load it. Uses the H5 Games Ads API when an ad
// client id is configured (NEXT_PUBLIC_ADS_CLIENT); without one, or if the ad is blocked or slow,
// it simply continues. Family-safe: non-personalized ads requested.

import { useEffect, useRef } from "react";
import { AD_TIMEOUT_MS } from "@/shared/ads";
import { t } from "@/shared/strings";

type AdBreakFn = (o: { type: string; name: string; adBreakDone: () => void }) => void;
declare global {
  interface Window {
    adBreak?: AdBreakFn;
    adConfig?: (o: Record<string, unknown>) => void;
    adsbygoogle?: unknown[];
  }
}

const CLIENT = process.env.NEXT_PUBLIC_ADS_CLIENT ?? "";

function loadScript(): Promise<void> {
  if (document.getElementById("h5-ads")) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.id = "h5-ads";
    s.async = true;
    s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(CLIENT)}`;
    s.crossOrigin = "anonymous";
    s.dataset.adFrequencyHint = "30s";
    if (process.env.NODE_ENV !== "production") s.dataset.adbreakTest = "on";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("blocked"));
    document.head.appendChild(s);
    window.adsbygoogle = window.adsbygoogle || [];
    window.adBreak = window.adConfig = function (o: unknown) {
      window.adsbygoogle!.push(o);
    } as AdBreakFn & ((o: Record<string, unknown>) => void);
    window.adConfig({ preloadAdBreaks: "on", sound: "on" });
    // Non-personalized ads only (families).
    (window.adsbygoogle as unknown as { requestNonPersonalizedAds?: number }).requestNonPersonalizedAds = 1;
  });
}

export default function AdBreak({ onDone }: { onDone: () => void }) {
  const done = useRef(false);
  useEffect(() => {
    const finish = () => {
      if (done.current) return;
      done.current = true;
      onDone();
    };
    if (!CLIENT) return finish();
    const timer = setTimeout(finish, AD_TIMEOUT_MS);
    loadScript()
      .then(() => window.adBreak?.({ type: "next", name: "between-matches", adBreakDone: finish }))
      .catch(finish);
    return () => clearTimeout(timer);
  }, [onDone]);
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#0b1d2a]">
      <p className="text-4xl font-bold opacity-80">{t("ads.nextMatch")}</p>
    </div>
  );
}
