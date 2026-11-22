// Renders each track's pre-made images from its JSON:
//   <id>.bg.svg       full-size background (island, sand curbs, road, start line) — host + later phone view
//   <id>.minimap.svg  small road outline for the corner minimap
// Run after editing a track file:  npm run tracks

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTrack } from "../shared/track-format";
import { buildTrack, pointAt, type Track } from "../game/track";

const DIR = join(import.meta.dirname, "..", "public", "assets", "tracks");

const COLORS = { road: "#3a3f4b", sand: "#f3e2b3", grass: "#2fae6a", water: "#1f8fcf", shallow: "#5fc3ef" };

const f = (n: number) => Math.round(n * 10) / 10;

function loopPath(t: Track): string {
  let d = `M${f(t.xs[0])} ${f(t.ys[0])}`;
  for (let i = 1; i < t.xs.length; i++) d += `L${f(t.xs[i])} ${f(t.ys[i])}`;
  return d + "Z";
}

function background(t: Track): string {
  const { w, h } = t.def.world;
  const road = loopPath(t);
  const parts: string[] = [
    `<rect width="${w}" height="${h}" fill="${COLORS.water}"/>`,
    `<rect x="60" y="40" width="${w - 120}" height="${h - 80}" rx="120" fill="${COLORS.grass}"/>`,
  ];
  for (const s of t.def.surfaces) {
    parts.push(`<path d="M${s.poly.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z" fill="${s.kind === "sand" ? COLORS.sand : COLORS.shallow}"/>`);
  }
  parts.push(
    `<path d="${road}" fill="none" stroke="${COLORS.sand}" stroke-width="${t.def.width + 22}" stroke-linejoin="round"/>`,
    `<path d="${road}" fill="none" stroke="${COLORS.road}" stroke-width="${t.def.width}" stroke-linejoin="round"/>`,
  );
  // Dotted center line.
  let dots = "";
  for (let i = 0; i < t.xs.length; i += 6) dots += `<circle cx="${f(t.xs[i])}" cy="${f(t.ys[i])}" r="2.5"/>`;
  parts.push(`<g fill="#ffffff" fill-opacity="0.35">${dots}</g>`);
  // Checkered start line across the road at s = 0.
  const s = pointAt(t, 0);
  const sq = 10;
  const cells = Math.floor(t.def.width / sq);
  let checks = "";
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < 2; j++) {
      checks += `<rect x="${f((j - 1) * sq)}" y="${f((i - cells / 2) * sq)}" width="${sq}" height="${sq}" fill="${(i + j) % 2 ? "#111111" : "#ffffff"}"/>`;
    }
  }
  parts.push(`<g transform="translate(${f(s.x)} ${f(s.y)}) rotate(${f((s.a * 180) / Math.PI)})">${checks}</g>`);
  return svg(w, h, w, h, parts);
}

function minimap(t: Track): string {
  const { w, h } = t.def.world;
  const scale = 320 / w;
  const road = loopPath(t);
  return svg(Math.round(w * scale), Math.round(h * scale), w, h, [
    `<path d="${road}" fill="none" stroke="#0b1d2a" stroke-opacity="0.6" stroke-width="${t.def.width * 1.4}" stroke-linejoin="round"/>`,
    `<path d="${road}" fill="none" stroke="#ffffff" stroke-width="${t.def.width * 0.8}" stroke-linejoin="round"/>`,
  ]);
}

function svg(pw: number, ph: number, w: number, h: number, parts: string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${w} ${h}">\n${parts.join("\n")}\n</svg>\n`;
}

for (const file of readdirSync(DIR).filter((n) => n.endsWith(".json"))) {
  const def = parseTrack(JSON.parse(readFileSync(join(DIR, file), "utf8")));
  const t = buildTrack(def);
  writeFileSync(join("public", def.background), background(t));
  writeFileSync(join("public", def.minimap), minimap(t));
  console.log(`${def.id}: ${def.background}, ${def.minimap}`);
}
