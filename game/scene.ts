// Phaser scene for the big screen. Fills the whole window (RESIZE). Shows the track's pre-made
// background, steps the race (fixed 60 Hz inside RaceHost) and draws interpolated cars.
// Two cameras, both driven once per frame with no network traffic:
//   main      broadcast camera (Director: intro → grid → pack, trap cuts, finish line);
//             every car still racing is always in frame
//   minimap   whole track + colored dots, top-left
// Under the background: a slowly drifting wave layer that shows through the open sea.
// Over the road: live track hazards (lava cracks glowing on their rhythm, crab crowds walking).

import * as Phaser from "phaser";
import { Director, type CarPos } from "./camera";
import { hudLayout, type HudLayout } from "./hud";
import type { RaceHost } from "./race";
import { CARD_ICON } from "../shared/rules";
import { baseTrackId, type Theme } from "../shared/track-format";
import { crabSpots, FX } from "./sim";
import { pointAt, roadHalf, timedOn, trackBounds, type Track } from "./track";

const WATER = 0x1f8fcf;
const BG_RES = 2;
/** Sea color under the art (and past the map edge) per theme. */
const SEA: Record<Theme, number> = { beach: 0x1478b8, harbor: 0x10689f, lagoon: 0x1386b3, jungle: 0x106c8c, volcano: 0x10425f, night: 0x08162f, sandcastle: 0x1788c4 };
/** Lava cracks glow this many ticks before they open, as a warning. */
const LAVA_WARN = 45;

export function createGame(parent: HTMLElement, host: RaceHost, director: Director): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: WATER,
    scale: { mode: Phaser.Scale.RESIZE, width: "100%", height: "100%" },
    banner: false,
    scene: new RaceScene(host, director),
  });
}

interface CarSprites {
  body: Phaser.GameObjects.Image;
  /** Car number on the roof (accessibility: colors are not the only way to tell cars apart). */
  num: Phaser.GameObjects.Text;
  label: Phaser.GameObjects.Text;
  dot: Phaser.GameObjects.Arc;
}

class RaceScene extends Phaser.Scene {
  private cars = new Map<string, CarSprites>();
  private mini!: Phaser.Cameras.Scene2D.Camera;
  private bg!: Phaser.GameObjects.Image;
  private miniMap!: Phaser.GameObjects.Image;
  private layout!: HudLayout;
  private bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
  private shownTrack = "";
  private loadingTrack: string | null = null;
  /** Traps that went off this race, drawn where they were. Hidden ones are never drawn. */
  private trapIcons = new Map<number, Phaser.GameObjects.Text>();
  private trapRace: unknown = null;
  private waves!: Phaser.GameObjects.TileSprite;
  private hazardG!: Phaser.GameObjects.Graphics;
  private crabIcons: Phaser.GameObjects.Text[] = [];

  constructor(private host: RaceHost, private director: Director) {
    super("race");
  }

  preload() {
    this.queueTrack(this.host.track!);
  }

  /** Each track's images load only when it's chosen (PLAN.md 5: "Load each track only when chosen"). */
  private queueTrack(t: Track) {
    const { def } = t;
    const id = baseTrackId(def.id); // a Mirror version shares the images, flipped
    // Rasterize at 2× so the broadcast camera's close-ups stay sharp.
    this.load.svg(`bg-${id}`, def.background, { width: def.world.w * BG_RES, height: def.world.h * BG_RES });
    this.load.svg(`mini-${id}`, def.minimap, { width: 640, height: Math.round((640 * def.world.h) / def.world.w) });
  }

  /** Point the images at a track: textures, mirror flip, sea color. */
  private showTrack(t: Track) {
    const id = baseTrackId(t.def.id);
    const { w, h } = t.def.world;
    const flip = !!t.def.mirror;
    this.bg.setTexture(`bg-${id}`).setDisplaySize(w, h).setFlipX(flip);
    this.miniMap.setTexture(`mini-${id}`).setDisplaySize(w, h).setFlipX(flip);
    const sea = SEA[t.def.theme ?? "beach"];
    this.waves.setPosition(-w, -h).setSize(w * 3, h * 3).setTint(sea);
    this.cameras.main.setBackgroundColor(sea);
  }

  /** Show the host's current track; loads its images first if needed. */
  private syncTrack() {
    const t = this.host.track;
    if (!t || t.def.id === this.shownTrack) return;
    const id = baseTrackId(t.def.id);
    if (!this.textures.exists(`bg-${id}`) || !this.textures.exists(`mini-${id}`)) {
      if (this.loadingTrack === t.def.id) return;
      this.loadingTrack = t.def.id;
      this.queueTrack(t);
      this.load.once(Phaser.Loader.Events.COMPLETE, () => (this.loadingTrack = null));
      this.load.start();
      return;
    }
    this.shownTrack = t.def.id;
    this.bounds = trackBounds(t);
    this.showTrack(t);
    this.relayout(this.scale.width, this.scale.height);
  }

  create() {
    const t = this.host.track!;
    this.shownTrack = t.def.id;
    this.bounds = trackBounds(t);
    this.makeWaveTexture();
    this.waves = this.add.tileSprite(0, 0, 10, 10, "waves").setOrigin(0).setDepth(-1);
    this.bg = this.add.image(0, 0, `bg-${baseTrackId(t.def.id)}`).setOrigin(0).setDepth(0);
    // Minimap image covers the world exactly (its viewBox is the world), seen only by the minimap camera.
    this.miniMap = this.add.image(0, 0, `mini-${baseTrackId(t.def.id)}`).setOrigin(0).setDepth(0);
    this.hazardG = this.add.graphics().setDepth(1.2);
    this.makeCarTexture();
    this.showTrack(t);

    this.mini = this.cameras.add(0, 0, 10, 10, false, "minimap").setBackgroundColor("rgba(11,29,42,0.55)");
    this.cameras.main.ignore(this.miniMap);
    this.mini.ignore([this.bg, this.waves, this.hazardG]);

    this.scale.on(Phaser.Scale.Events.RESIZE, (size: Phaser.Structs.Size) => this.relayout(size.width, size.height));
    this.relayout(this.scale.width, this.scale.height);
    this.game.events.on(Phaser.Core.Events.POST_RENDER, () => this.host.afterRender());
  }

  private relayout(w: number, h: number) {
    const b = this.bounds;
    this.layout = hudLayout(w, h, (b.y1 - b.y0) / (b.x1 - b.x0));
    this.cameras.main.setViewport(0, 0, w, h);
    const m = this.layout.minimap;
    this.mini.setViewport(m.x, m.y, m.w, m.h).setZoom(m.w / (b.x1 - b.x0)).centerOn((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
    for (const car of this.cars.values()) car.dot.setRadius(this.dotRadius());
    this.host.camera.layout = this.layout;
  }

  private dotRadius() {
    return (7 * this.layout.u) / this.mini.zoom;
  }

  update(time: number, delta: number) {
    this.host.update(delta);
    this.syncTrack();
    const race = this.host.race;
    const t = this.host.track!;
    const live: CarPos[] = [];
    if (race) for (const c of race.cars) live.push({ pid: c.pid, x: c.x, y: c.y, a: c.a, dist: c.dist, finished: c.finishMs !== null });

    const start = pointAt(t, 0);
    const out = this.director.update({
      nowMs: time,
      dtMs: delta,
      phase: directorPhase(this.host.phase),
      countdownLeft: this.host.countdownLeft,
      cars: live,
      finishLine: { x: start.x, y: start.y },
      finishDist: (race?.laps ?? 0) * t.length,
      view: { w: this.scale.width, h: this.scale.height },
      track: this.bounds,
      world: { x0: 0, y0: 0, x1: t.def.world.w, y1: t.def.world.h },
      insets: this.host.phase === "race" || this.host.phase === "countdown" ? { l: 0, r: this.layout.towerW, t: 0, b: 0 } : undefined,
    });
    const cam = this.cameras.main;
    cam.setZoom(out.shot.zoom).centerOn(out.shot.cx, out.shot.cy);

    // Water drifts slowly in a loop.
    this.waves.tilePositionX = time * 0.012 + Math.sin(time / 2300) * 18;
    this.waves.tilePositionY = time * 0.006 + Math.cos(time / 1900) * 12;
    this.drawHazards(t, race?.tick ?? 0, time, race !== null && this.host.phase !== "lobby");

    const seen = new Set<string>();
    const labelScale = this.layout.u / out.shot.zoom;
    if (race) {
      for (const c of race.cars) {
        seen.add(c.pid);
        const pose = this.host.pose(c.pid)!;
        const car = this.carFor(c.pid);
        // Ramp: the car grows a little while it's in the air.
        const jump = c.air > 0 ? 1 + 0.4 * Math.sin((Math.PI * (FX.air - c.air)) / FX.air) : 1;
        car.body.setPosition(pose.x, pose.y).setRotation(pose.a).setScale(jump).setDepth(c.air > 0 ? 2.5 : 2);
        car.num.setPosition(pose.x, pose.y).setScale(jump).setDepth(c.air > 0 ? 2.6 : 2.1);
        // Just respawned: blink while it can't be bumped.
        if (c.ghost > 0) car.body.setAlpha(Math.floor(time / 120) % 2 ? 0.35 : 0.9);
        car.label.setPosition(pose.x, pose.y - 24 * labelScale).setScale(labelScale);
        car.dot.setPosition(pose.x, pose.y);
      }
    }
    this.drawTraps(labelScale);
    for (const [pid, car] of this.cars) {
      if (seen.has(pid)) continue;
      car.body.destroy();
      car.num.destroy();
      car.label.destroy();
      car.dot.destroy();
      this.cars.delete(pid);
    }

    this.host.camera.kind = out.kind;
  }

  /** Lava cracks (glow before and while open) and crab crowds walking across the road. */
  private drawHazards(t: Track, tick: number, time: number, live: boolean) {
    const g = this.hazardG;
    g.clear();
    for (const h of t.lavas) {
      const open = live && timedOn(h, tick);
      const warn = live && !open && timedOn(h, tick, LAVA_WARN);
      if (!open && !warn) continue;
      const p = pointAt(t, h.s);
      const half = roadHalf(t, h.s) + 6;
      const flicker = 0.75 + 0.25 * Math.sin(time / 60);
      const len = open ? h.len * 2 : h.len * 1.1;
      g.fillStyle(open ? 0xff5a1a : 0xff7a1a, open ? 0.9 * flicker : 0.25 + 0.25 * Math.sin(time / 90));
      fillRot(g, p.x, p.y, p.a, len, half * 2);
      if (open) {
        g.fillStyle(0xffd23f, 0.85 * flicker);
        fillRot(g, p.x, p.y, p.a, len * 0.45, half * 2 - 8);
        g.fillStyle(0xff7a1a, 0.18);
        fillRot(g, p.x, p.y, p.a, len * 2.4, half * 2 + 30);
      }
    }
    let k = 0;
    if (live) {
      for (const h of t.crabs) {
        for (const c of crabSpots(t, h, tick)) {
          let icon = this.crabIcons[k];
          if (!icon) {
            icon = this.add.text(0, 0, "🦀", { fontSize: "30px" }).setOrigin(0.5).setDepth(2.2);
            this.mini.ignore(icon);
            this.crabIcons.push(icon);
          }
          // A little sideways scuttle.
          icon.setPosition(c.x, c.y + Math.sin(time / 70 + k) * 2).setRotation(Math.sin(time / 110 + k) * 0.25).setVisible(true);
          k++;
        }
      }
    }
    for (; k < this.crabIcons.length; k++) this.crabIcons[k].setVisible(false);
  }

  /** Traps appear only once triggered (PLAN.md 2: invisible until a car touches one). */
  private drawTraps(scale: number) {
    const race = this.host.race;
    if (race !== this.trapRace) {
      for (const icon of this.trapIcons.values()) icon.destroy();
      this.trapIcons.clear();
      this.trapRace = race;
    }
    if (!race) return;
    for (const trap of race.traps) {
      if (trap.live) continue;
      let icon = this.trapIcons.get(trap.id);
      if (!icon) {
        icon = this.add.text(trap.x, trap.y, CARD_ICON[trap.card], { fontSize: "34px" }).setOrigin(0.5).setDepth(1.5);
        this.mini.ignore(icon);
        this.trapIcons.set(trap.id, icon);
      }
      icon.setScale(Math.max(0.8, scale));
    }
  }

  private carFor(pid: string): CarSprites {
    let car = this.cars.get(pid);
    const info = this.host.roster.find((p) => p.pid === pid);
    if (!car) {
      const body = this.add.image(0, 0, "car").setDepth(2);
      const num = this.add
        .text(0, 0, "", { fontFamily: "system-ui, sans-serif", fontSize: "15px", fontStyle: "bold", color: "#0b1d2a", stroke: "#ffffff", strokeThickness: 3 })
        .setOrigin(0.5)
        .setDepth(2.1);
      const label = this.add
        .text(0, 0, "", { fontFamily: "system-ui, sans-serif", fontSize: "20px", fontStyle: "bold", color: "#ffffff", stroke: "#0b1d2a", strokeThickness: 5 })
        .setOrigin(0.5, 1)
        .setDepth(3);
      const dot = this.add.circle(0, 0, this.dotRadius(), 0xffffff).setStrokeStyle(2 / this.mini.zoom, 0x0b1d2a).setDepth(4);
      this.mini.ignore([body, num, label]);
      this.cameras.main.ignore(dot);
      car = { body, num, label, dot };
      this.cars.set(pid, car);
    }
    if (info) {
      const color = Phaser.Display.Color.HexStringToColor(info.color).color;
      car.body.setTint(color);
      car.body.setAlpha(info.on ? 1 : 0.5);
      car.dot.setFillStyle(color, info.on ? 1 : 0.5);
      if (car.label.text !== info.name) car.label.setText(info.name);
      const n = String(this.host.carNumber(pid));
      if (car.num.text !== n) car.num.setText(n);
    }
    return car;
  }

  /** Tile of sea with light wave strokes; tinted per theme and drifted under the art. */
  private makeWaveTexture() {
    const S = 256;
    const g = this.add.graphics();
    // Light crests: drawn in a slightly darker base so the tint gives sea + bright crests.
    g.fillStyle(0xb8c8d8, 1);
    g.fillRect(0, 0, S, S);
    g.lineStyle(4, 0xffffff, 1);
    for (const [x, y, w] of [[20, 40, 60], [140, 90, 70], [60, 170, 50], [180, 220, 60], [100, 10, 40]] as const) {
      g.beginPath();
      for (let i = 0; i <= 12; i++) {
        const px = x + (w * i) / 12, py = y + Math.sin((i / 12) * Math.PI * 2) * 5;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.strokePath();
    }
    g.generateTexture("waves", S, S);
    g.destroy();
  }

  /** White car shape so each player's color can be applied with a tint. Faces +x. */
  private makeCarTexture() {
    const g = this.add.graphics();
    g.fillStyle(0x000000, 0.25);
    g.fillEllipse(19, 13, 36, 22); // blob shadow
    g.fillStyle(0xffffff, 1);
    g.fillRoundedRect(2, 2, 34, 20, 6);
    g.fillStyle(0x1b2a38, 1);
    g.fillRoundedRect(20, 5, 9, 14, 3); // windshield
    g.fillStyle(0x111111, 1);
    g.fillRect(6, 0, 7, 3);
    g.fillRect(6, 21, 7, 3);
    g.fillRect(25, 0, 7, 3);
    g.fillRect(25, 21, 7, 3);
    g.generateTexture("car", 38, 24);
    g.destroy();
  }
}

/** The camera only needs to know: wide shot, countdown, live race, or wide again after. */
function directorPhase(p: RaceHost["phase"]): "lobby" | "countdown" | "race" | "results" {
  if (p === "countdown" || p === "race") return p;
  return p === "lobby" || p === "role" || p === "draft" ? "lobby" : "results";
}

/** Filled rectangle centered at (x, y), long side along angle a. */
function fillRot(g: Phaser.GameObjects.Graphics, x: number, y: number, a: number, along: number, across: number) {
  const c = Math.cos(a), s = Math.sin(a);
  const hx = along / 2, hy = across / 2;
  g.beginPath();
  g.moveTo(x - c * hx + s * hy, y - s * hx - c * hy);
  g.lineTo(x + c * hx + s * hy, y + s * hx - c * hy);
  g.lineTo(x + c * hx - s * hy, y + s * hx + c * hy);
  g.lineTo(x - c * hx - s * hy, y - s * hx + c * hy);
  g.closePath();
  g.fillPath();

}
