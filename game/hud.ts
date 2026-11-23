// Where things go on the host screen (PLAN.md 5b). Used by the Phaser scene (camera viewports)
// and by React (frames, labels), so both agree at every window size.
//   top-left: minimap · top-center: banners · right edge: positions tower
//   bottom-left: room code · bottom-right: traps-hidden counter

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HudLayout {
  /** Scale unit: 1 at 1080p, grows with window height so text reads from a sofa. */
  u: number;
  pad: number;
  minimap: Box;
  /** Positions tower on the right edge: fixed width so the camera can frame around it. */
  towerW: number;
}

/** What the scene tells the React HUD each frame (React reads it on its own refresh). */
export interface CameraInfo {
  kind: string;
  layout: HudLayout | null;
}

/** aspect = track height / width (of the minimap area). */
export function hudLayout(w: number, h: number, aspect: number): HudLayout {
  const u = Math.max(0.7, Math.min(2.2, h / 1080));
  const pad = Math.round(16 * u);
  const mmW = Math.round(Math.min(w * 0.2, 340 * u));
  const mmH = Math.round(mmW * aspect);
  return {
    u,
    pad,
    minimap: { x: pad, y: pad, w: mmW, h: mmH },
    towerW: Math.round(290 * u),
  };
}
