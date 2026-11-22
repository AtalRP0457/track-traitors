// Test-only helper: read track files straight from public/assets/tracks (Node, no fetch).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTrack, type TrackFile } from "../shared/track-format";
import { buildTrack, type Track } from "./track";

export const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const DIR = join(PUBLIC_DIR, "assets", "tracks");

export const trackIds = () => readdirSync(DIR).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
export const readTrackRaw = (id: string): unknown => JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8"));
export const readTrackFile = (id: string): TrackFile => parseTrack(readTrackRaw(id));
export const loadTestTrack = (id = "sunny-cove"): Track => buildTrack(readTrackFile(id));
export const publicFileExists = (path: string) => existsSync(join(PUBLIC_DIR, path));
