"use client";

// Phone screens for a Traitors match: secret role card, trap draft, Glitch target picker,
// vote, and reaction buttons. Every button reacts on pointerdown (never click).

import { useEffect, useRef, useState } from "react";
import { CARD_ICON, REACTIONS, type Card, type Role } from "@/shared/rules";
import { t, type StringKey } from "@/shared/strings";
import { trackUrl, parseTrack } from "@/shared/track-format";
import type { Clue } from "@/shared/protocol";
import { clueText } from "@/shared/clues";
import { buildTrack, type Track } from "@/game/track";
import { snapTrap, trapZonePaths } from "@/game/traps";

export interface Seat { pid: string; name: string; color: string }

/** Fires on pointerdown so it feels instant; ignores the click that follows. */
export function Tap({ onTap, className, style, children, disabled, label }: {
  onTap: () => void; className?: string; style?: React.CSSProperties; children: React.ReactNode; disabled?: boolean; label?: string;
}) {
  return (
    <button
      aria-label={label}
      disabled={disabled}
      onPointerDown={(e) => {
        e.preventDefault();
        if (!disabled) onTap();
      }}
      className={(className ?? "") + " active:scale-95 disabled:opacity-40"}
      style={style}
    >
      {children}
    </button>
  );
}

export function RoleCard({ role, mates, caught, seats }: { role: Role; mates: string[]; caught: boolean; seats: Map<string, Seat> }) {
  const traitor = role === "traitor";
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl p-8 text-center text-black" style={{ background: traitor ? "var(--traitor)" : "var(--racer)" }}>
      <div className="text-xl font-bold uppercase tracking-widest">{t("role.you")}</div>
      <div className="text-6xl font-black">{traitor ? "😈" : "🏎️"}</div>
      <div className="text-5xl font-black">{t(traitor ? "role.traitor" : "role.racer")}</div>
      <p className="text-xl font-bold">{t(traitor ? "role.traitorHelp" : "role.racerHelp")}</p>
      {traitor && mates.length > 0 && <p className="text-lg font-bold">{t("role.mates", { names: mates.map((m) => seats.get(m)?.name ?? "?").join(", ") })}</p>}
      {caught && <p className="text-lg font-bold">{t("role.caught")}</p>}
    </div>
  );
}

/** Load + build a track on the phone (small JSON) for the draft map. */
function useTrack(id: string): Track | null {
  const [track, setTrack] = useState<Track | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch(trackUrl(id))
      .then((r) => r.json())
      .then((raw) => !cancelled && setTrack(buildTrack(parseTrack(raw))))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);
  return track?.def.id === id ? track : null;
}

/**
 * Trap draft: pick a card, tap the glowing road on the minimap. The tap is snapped to a legal
 * spot (on the road, inside a trap zone) before it's sent; the host checks it again anyway.
 */
export function Draft({ trackId, cards, n, mine, endAt, onPlace }: {
  trackId: string; cards: Card[]; n: number; mine: [Card, number, number][]; endAt: number;
  onPlace: (card: Card, x: number, y: number) => void;
}) {
  const track = useTrack(trackId);
  const [pick, setPick] = useState<Card | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(id);
  }, []);
  const left = n - mine.length;
  const secs = Math.max(0, Math.ceil((endAt - performance.now()) / 1000));
  useEffect(() => {
    if (pick && !cards.includes(pick)) setPick(null);
  }, [cards, pick]);

  const place = (e: React.PointerEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m || !pick || !track || left <= 0) return;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    const p = snapTrap(track, pt.x, pt.y);
    if (!p) return;
    navigator.vibrate?.(15);
    onPlace(pick, p.x, p.y);
    setPick(null);
  };

  const zones = track ? trapZonePaths(track) : [];
  return (
    <div className="flex h-full w-full flex-col items-center gap-3 p-3">
      <div className="flex w-full items-center justify-between pr-24">
        <h1 className="text-2xl font-black" style={{ color: "var(--traitor)" }}>{t("draft.title")}</h1>
        <span className="text-2xl font-black tabular-nums">{secs}</span>
      </div>
      <p className="text-center text-lg">{left <= 0 ? t("draft.done") : pick ? t("draft.tapMap") : t("draft.pickCard")}</p>
      <div className="relative w-full flex-1">
        {track && (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${track.def.world.w} ${track.def.world.h}`}
            className="absolute inset-0 h-full w-full"
            onPointerDown={place}
            style={{ touchAction: "none" }}
          >
            <image href={track.def.minimap} x={0} y={0} width={track.def.world.w} height={track.def.world.h} />
            {zones.map((pts, i) => (
              <polyline
                key={i}
                points={pts.map(([x, y]) => `${x},${y}`).join(" ")}
                fill="none"
                stroke="#FF7A1A"
                strokeOpacity={pick ? 0.85 : 0.45}
                strokeWidth={track.def.width * 0.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                className={pick ? "zone-glow" : undefined}
              />
            ))}
            {mine.map(([card, x, y], i) => (
              <text key={i} x={x} y={y} fontSize={track.def.width} textAnchor="middle" dominantBaseline="central">
                {CARD_ICON[card]}
              </text>
            ))}
          </svg>
        )}
      </div>
      {left > 0 && (
        <div className="grid w-full grid-cols-3 gap-2">
          {cards.map((c) => (
            <Tap
              key={c}
              onTap={() => setPick(c === pick ? null : c)}
              className="flex flex-col items-center rounded-2xl p-2 text-black"
              style={{ background: c === pick ? "var(--traitor)" : "#f4f8fb", outline: c === pick ? "4px solid white" : "none" }}
            >
              <span className="text-4xl">{CARD_ICON[c]}</span>
              <span className="text-base font-black leading-tight">{t(`card.${c}` as StringKey)}</span>
              <span className="text-xs leading-tight opacity-70">{t(`cardHelp.${c}` as StringKey)}</span>
            </Tap>
          ))}
        </div>
      )}
      {left > 0 && n > 1 && <p className="opacity-70">{t("draft.left", { n: left })}</p>}
    </div>
  );
}

export function GlitchPicker({ rivals, onPick, onCancel }: { rivals: Seat[]; onPick: (pid: string) => void; onCancel: () => void }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/85 p-4">
      <h2 className="text-3xl font-black" style={{ color: "var(--traitor)" }}>{t("glitch.pick")}</h2>
      <div className="grid w-full max-w-md grid-cols-2 gap-2">
        {rivals.map((p) => (
          <Tap key={p.pid} onTap={() => onPick(p.pid)} className="rounded-2xl p-4 text-xl font-black text-black" style={{ background: p.color }}>
            {p.name}
          </Tap>
        ))}
      </div>
      <Tap onTap={onCancel} className="rounded-2xl bg-white/15 px-6 py-3 text-xl font-bold">
        {t("glitch.cancel")}
      </Tap>
    </div>
  );
}

export function Vote({ candidates, clues, name, endAt, voted, onVote }: {
  candidates: Seat[]; clues: Clue[]; name: (pid: string) => string; endAt: number; voted: string | null; onVote: (pid: string) => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.ceil((endAt - performance.now()) / 1000));
  return (
    <div className="flex h-full w-full flex-col items-center gap-3 overflow-y-auto p-4">
      <div className="flex w-full items-center justify-between">
        <h1 className="text-2xl font-black" style={{ color: "var(--traitor)" }}>{t("vote.title")}</h1>
        <span className="text-2xl font-black tabular-nums">{secs}</span>
      </div>
      {clues.length > 0 && (
        <div className="w-full rounded-2xl bg-white/10 p-3">
          <div className="mb-1 text-sm uppercase tracking-widest opacity-60">{t("vote.clues")}</div>
          <ul className="space-y-1 text-base">
            {clues.map((c, i) => (
              <li key={i}>• {clueText(c, name)}</li>
            ))}
          </ul>
        </div>
      )}
      {voted !== null ? (
        <p className="mt-6 text-2xl font-bold">{t("vote.sent")}</p>
      ) : (
        <div className="grid w-full grid-cols-2 gap-2">
          {candidates.map((p) => (
            <Tap key={p.pid} onTap={() => onVote(p.pid)} className="rounded-2xl p-4 text-xl font-black text-black" style={{ background: p.color }}>
              {p.name}
            </Tap>
          ))}
          <Tap onTap={() => onVote("")} className="col-span-2 rounded-2xl bg-white/15 p-3 text-xl font-bold">
            {t("vote.skip")}
          </Tap>
        </div>
      )}
    </div>
  );
}

/** Six fixed reaction buttons (no free text). */
export function Reactions({ onReact }: { onReact: (e: number) => void }) {
  return (
    <div className="flex w-full max-w-sm justify-between gap-1">
      {REACTIONS.map((r, i) => (
        <Tap key={i} onTap={() => onReact(i)} className="flex-1 rounded-2xl bg-white/10 py-2 text-3xl">
          {r}
        </Tap>
      ))}
    </div>
  );
}
