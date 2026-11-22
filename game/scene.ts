// Phaser scene for the big screen. Shows the track's pre-made background image, then each
// frame steps the race (fixed 60 Hz inside RaceHost) and draws interpolated cars.

import * as Phaser from "phaser";
import type { RaceHost } from "./race";

const WATER = 0x1f8fcf;

export function createGame(parent: HTMLElement, host: RaceHost): Phaser.Game {
  const { w, h } = host.track!.def.world;
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

  preload() {
    const { def } = this.host.track!;
    this.load.svg("track", def.background, { width: def.world.w, height: def.world.h });
  }

  create() {
    this.add.image(0, 0, "track").setOrigin(0).setDepth(0);
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
