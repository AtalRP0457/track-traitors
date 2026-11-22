// Phaser scene for the big screen. Fills the whole window (RESIZE). Shows the track's pre-made
// background, steps the race (fixed 60 Hz inside RaceHost) and draws interpolated cars.
// Three cameras, all driven once per frame with no network traffic:
//   main      broadcast camera (Director: intro → grid → pack, trap cuts, finish line)
//   minimap   whole track + colored dots, top-left
//   straggler small window following a car that fell far behind (only when needed)

import * as Phaser from "phaser";
import { CAM, Director, type CarPos } from "./camera";
import { hudLayout, type HudLayout } from "./hud";
import type { RaceHost } from "./race";
import { DT } from "./sim";
import { pointAt, trackBounds } from "./track";

const WATER = 0x1f8fcf;
const BG_RES = 2;

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
  label: Phaser.GameObjects.Text;
  dot: Phaser.GameObjects.Arc;
}

class RaceScene extends Phaser.Scene {
  private cars = new Map<string, CarSprites>();
  private mini!: Phaser.Cameras.Scene2D.Camera;
  private strag!: Phaser.Cameras.Scene2D.Camera;
  private bg!: Phaser.GameObjects.Image;
  private miniMap!: Phaser.GameObjects.Image;
  private layout!: HudLayout;
  private bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };

  constructor(private host: RaceHost, private director: Director) {
    super("race");
  }

  preload() {
    const { def } = this.host.track!;
    // Rasterize at 2× so the broadcast camera's close-ups stay sharp.
    this.load.svg("track", def.background, { width: def.world.w * BG_RES, height: def.world.h * BG_RES });
    this.load.svg("minimap", def.minimap, { width: 640, height: Math.round((640 * def.world.h) / def.world.w) });
  }

  create() {
    const t = this.host.track!;
    this.bounds = trackBounds(t);
    this.bg = this.add.image(0, 0, "track").setOrigin(0).setDisplaySize(t.def.world.w, t.def.world.h).setDepth(0);
    // Minimap image covers the world exactly (its viewBox is the world), seen only by the minimap camera.
    this.miniMap = this.add.image(0, 0, "minimap").setOrigin(0).setDisplaySize(t.def.world.w, t.def.world.h).setDepth(0);
    this.makeCarTexture();

    this.mini = this.cameras.add(0, 0, 10, 10, false, "minimap").setBackgroundColor("rgba(11,29,42,0.55)");
    this.strag = this.cameras.add(0, 0, 10, 10, false, "straggler").setBackgroundColor(WATER).setVisible(false);
    this.cameras.main.ignore(this.miniMap);
    this.strag.ignore(this.miniMap);
    this.mini.ignore(this.bg);

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
    const s = this.layout.straggler;
    this.strag.setViewport(s.x, s.y, s.w, s.h).setZoom(Math.min(s.w, s.h) / (10 * CAM.carLen));
    for (const car of this.cars.values()) car.dot.setRadius(this.dotRadius());
    this.host.camera.layout = this.layout;
  }

  private dotRadius() {
    return (7 * this.layout.u) / this.mini.zoom;
  }

  update(time: number, delta: number) {
    this.host.update(delta);
    const race = this.host.race;
    const t = this.host.track!;
    const live: CarPos[] = [];
    if (race) for (const c of race.cars) live.push({ pid: c.pid, x: c.x, y: c.y, a: c.a, dist: c.dist, finished: c.finishMs !== null });

    const start = pointAt(t, 0);
    const out = this.director.update({
      nowMs: time,
      dtMs: delta,
      phase: this.host.phase,
      countdownLeft: this.host.countdownLeft,
      cars: live,
      tick: this.host.renderTick,
      finishLine: { x: start.x, y: start.y },
      finishDist: (race?.laps ?? 0) * t.length,
      view: { w: this.scale.width, h: this.scale.height },
      track: this.bounds,
      world: { x0: 0, y0: 0, x1: t.def.world.w, y1: t.def.world.h },
      insets: this.host.phase === "race" || this.host.phase === "countdown" ? { l: 0, r: this.layout.towerW, t: 0, b: 0 } : undefined,
    });
    const cam = this.cameras.main;
    cam.setZoom(out.shot.zoom).centerOn(out.shot.cx, out.shot.cy);

    // Slow motion is display-only: physics keeps running, we draw recorded poses at 0.5×.
    const replayTick = out.slowmo ? out.slowmo.fromTick + ((time - out.slowmo.sinceMs) / 1000 / DT) * CAM.slowmo : null;

    const seen = new Set<string>();
    const labelScale = this.layout.u / out.shot.zoom;
    if (race) {
      for (const c of race.cars) {
        seen.add(c.pid);
        const pose = replayTick !== null ? this.host.poseAt(c.pid, replayTick)! : this.host.pose(c.pid)!;
        const car = this.carFor(c.pid);
        car.body.setPosition(pose.x, pose.y).setRotation(pose.a);
        car.label.setPosition(pose.x, pose.y - 24 * labelScale).setScale(labelScale);
        const livePose = this.host.pose(c.pid)!;
        car.dot.setPosition(livePose.x, livePose.y);
      }
    }
    for (const [pid, car] of this.cars) {
      if (seen.has(pid)) continue;
      car.body.destroy();
      car.label.destroy();
      car.dot.destroy();
      this.cars.delete(pid);
    }

    // Straggler window: follow the car the pack shot left out.
    let sp = out.straggler ? this.host.pose(out.straggler) : null;
    if (sp) {
      // Only when it's really off screen (the free area left of the tower).
      const wv = cam.worldView;
      const freeX1 = wv.x + wv.width - this.layout.towerW / out.shot.zoom;
      if (sp.x > wv.x && sp.x < freeX1 && sp.y > wv.y && sp.y < wv.y + wv.height) sp = null;
    }
    this.strag.setVisible(!!sp);
    if (sp) this.strag.centerOn(sp.x, sp.y);

    this.host.camera.kind = out.kind;
    this.host.camera.straggler = sp ? out.straggler : null;
    this.host.camera.slowmo = replayTick !== null;
  }

  private carFor(pid: string): CarSprites {
    let car = this.cars.get(pid);
    const info = this.host.players.find((p) => p.pid === pid);
    if (!car) {
      const body = this.add.image(0, 0, "car").setDepth(2);
      const label = this.add
        .text(0, 0, "", { fontFamily: "system-ui, sans-serif", fontSize: "20px", fontStyle: "bold", color: "#ffffff", stroke: "#0b1d2a", strokeThickness: 5 })
        .setOrigin(0.5, 1)
        .setDepth(3);
      const dot = this.add.circle(0, 0, this.dotRadius(), 0xffffff).setStrokeStyle(2 / this.mini.zoom, 0x0b1d2a).setDepth(4);
      this.mini.ignore([body, label]);
      this.cameras.main.ignore(dot);
      this.strag.ignore(dot);
      car = { body, label, dot };
      this.cars.set(pid, car);
    }
    if (info) {
      const color = Phaser.Display.Color.HexStringToColor(info.color).color;
      car.body.setTint(color);
      car.body.setAlpha(info.on ? 1 : 0.5);
      car.dot.setFillStyle(color, info.on ? 1 : 0.5);
      if (car.label.text !== info.name) car.label.setText(info.name);
    }
    return car;
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
