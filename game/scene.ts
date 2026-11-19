// Phaser scene for the big screen. Draws the track once into a texture, then each frame
// steps the race (fixed 60 Hz inside RaceHost) and draws interpolated cars.

import * as Phaser from "phaser";
import { pointAt } from "./track";
import type { RaceHost } from "./race";

const ROAD = 0x3a3f4b;
const CURB = 0xf3e2b3; // sand
const GRASS = 0x2fae6a;
const WATER = 0x1f8fcf;

export function createGame(parent: HTMLElement, host: RaceHost): Phaser.Game {
  const { w, h } = host.track.def.world;
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: w,
    height: h,
    backgroundColor: WATER,
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    banner: false,
    scene: new RaceScene(host),
  });
}

class RaceScene extends Phaser.Scene {
  private cars = new Map<string, { body: Phaser.GameObjects.Image; label: Phaser.GameObjects.Text }>();

  constructor(private host: RaceHost) {
    super("race");
  }

  create() {
    this.drawTrack();
    this.makeCarTexture();
    this.game.events.on(Phaser.Core.Events.POST_RENDER, () => this.host.afterRender());
  }

  update(_time: number, delta: number) {
    this.host.update(delta);

    const race = this.host.race;
    const seen = new Set<string>();
    if (race) {
      for (const c of race.cars) {
        seen.add(c.pid);
        const pose = this.host.pose(c.pid)!;
        const car = this.carFor(c.pid);
        car.body.setPosition(pose.x, pose.y).setRotation(pose.a);
        car.label.setPosition(pose.x, pose.y - 26);
      }
    }
    for (const [pid, car] of this.cars) {
      if (seen.has(pid)) continue;
      car.body.destroy();
      car.label.destroy();
      this.cars.delete(pid);
    }
  }

  private carFor(pid: string) {
    let car = this.cars.get(pid);
    const info = this.host.players.find((p) => p.pid === pid);
    if (!car) {
      const body = this.add.image(0, 0, "car").setDepth(2);
      const label = this.add
        .text(0, 0, "", { fontFamily: "system-ui, sans-serif", fontSize: "18px", fontStyle: "bold", color: "#ffffff", stroke: "#0b1d2a", strokeThickness: 4 })
        .setOrigin(0.5)
        .setDepth(3);
      car = { body, label };
      this.cars.set(pid, car);
    }
    if (info) {
      car.body.setTint(Phaser.Display.Color.HexStringToColor(info.color).color);
      car.body.setAlpha(info.on ? 1 : 0.5);
      if (car.label.text !== info.name) car.label.setText(info.name);
    }
    return car;
  }

  /** Bake the track (island, sand curbs, road, start line) into one texture. No per-frame cost. */
  private drawTrack() {
    const t = this.host.track;
    const { w, h } = t.def.world;
    const g = this.add.graphics();
    const n = t.xs.length;

    const ribbon = (width: number, color: number) => {
      g.fillStyle(color, 1);
      for (let i = 0; i < n; i++) g.fillCircle(t.xs[i], t.ys[i], width / 2);
    };

    g.fillStyle(GRASS, 1);
    g.fillRoundedRect(60, 40, w - 120, h - 80, 120);
    ribbon(t.def.width + 22, CURB);
    ribbon(t.def.width, ROAD);

    // Dashed center line.
    g.fillStyle(0xffffff, 0.35);
    for (let i = 0; i < n; i += 6) g.fillCircle(t.xs[i], t.ys[i], 2.5);

    // Checkered start line across the road at s = 0.
    const s = pointAt(t, 0);
    const nx = -Math.sin(s.a), ny = Math.cos(s.a);
    const tx = Math.cos(s.a), ty = Math.sin(s.a);
    const sq = 10;
    const cells = Math.floor(t.def.width / sq);
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < 2; j++) {
        g.fillStyle((i + j) % 2 ? 0x111111 : 0xffffff, 1);
        const off = (i - cells / 2 + 0.5) * sq;
        const along = (j - 0.5) * sq;
        g.fillRect(s.x + nx * off + tx * along - sq / 2, s.y + ny * off + ty * along - sq / 2, sq, sq);
      }
    }

    g.generateTexture("track", w, h);
    g.destroy();
    this.add.image(0, 0, "track").setOrigin(0).setDepth(0);
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
