# Asset licenses

Every image, sound and font used by the game is listed here with its source and license.

| Asset | Where | Source | License |
|---|---|---|---|
| Track "Sunny Cove" (layout) | `public/assets/tracks/sunny-cove.json` | Made for this project | Ours |
| Sunny Cove background + minimap | `public/assets/tracks/sunny-cove.bg.svg`, `sunny-cove.minimap.svg` | Generated from the track JSON by `npm run tracks` | Ours |
| Tracks "Coconut Harbor", "Lagoon Figure-8" (layouts) | `public/assets/tracks/coconut-harbor.json`, `lagoon-figure8.json` | Made for this project | Ours |
| Coconut Harbor + Lagoon Figure-8 backgrounds + minimaps (bridges, channels, shallow water) | `public/assets/tracks/*.bg.svg`, `*.minimap.svg` | Generated from the track JSON by `npm run tracks` | Ours |
| Trap icons, reaction buttons (🛢️ 🦀 🥥 ⚡ 🚀 ⛰️ 😂 😱 🔥 👏 🤔 😈) | `shared/rules.ts` | Unicode emoji drawn with the device's system font, no image files shipped | System font (not bundled) |
| Glitch static + reaction float effects | `app/globals.css` | Made for this project, CSS only | Ours |
| Car sprite | `game/scene.ts` (`makeCarTexture`) | Made for this project, drawn in code | Ours |
| Player name words | `shared/names.ts` | Made for this project | Ours |

No third-party assets yet.
