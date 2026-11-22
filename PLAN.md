# Track Traitors — Build Plan

Party racing game. One big screen (TV, laptop, or a phone) runs the race. Every player's phone is their controller and private screen. Works on iPhone and Android with no install (web), plus store apps later for offline hotspot play.

**One line:** Race your friends. Hide traps on their track. Find the traitor before the finish line.

---

## 1. Product decisions (settled)

| Decision | Choice |
|---|---|
| Players | 3–8 per party (bots fill empty seats; 1–2 players can race bots in Classic mode) |
| Platforms | Web first (any browser). Android app, then iPhone app, via Capacitor. Discord Activity later |
| Price | **Free.** First 20 matches per host device have no ads. After that: one short ad on the big screen **between matches only**. Never during a race. Never on phones |
| Offline | Hotspot/LAN mode in the store apps. No ads offline |
| Look | Bright beach/island kart style (inspired by the genre, **all original** cars, characters, names, art). Racer color = blue `#4DA3FF`, traitor/trap color = orange `#FF7A1A`. Start with simple 2D art; upgrade to a tilted 2.5D/3D camera in Phase 4 |
| Priority | **Efficiency and fast response** over visual detail. Phones must stay cool |
| Out of scope for now | Payments, accounts with email, free text chat, a second game (Jetpack Squad) |

---

## 2. How a match plays

A match = 3 races of ~90 seconds. Full match ≈ 8 minutes. **Each race is 2 laps** (decided 2026-11-19); track length is tuned so 2 laps ≈ 90 s.

1. **Lobby.** Host opens `/host`, gets a 4-letter room code + QR. Phones scan, enter name, pick a car color. First player to join (or the host) presses Start.
2. **Secret roles (phone only, 5 s).** Each phone privately shows *Racer* or *Traitor*. 3–5 players → 1 traitor. 6–8 → 2 traitors (they see each other).
3. **Trap draft (phone only, 20 s).** Each phone shows a mini-map and 3 random cards. Each player secretly places ONE card. Cards include helpful ones (boost pad) so placing something is never proof of guilt.
   - Launch cards: Oil slick (spin out), Crab wall (blocks a lane), Coconut bomb (knock back), Fake boost (slows), Boost pad (speeds up), Ramp (jump).
4. **Race (big screen, ~90 s).** Traps are invisible until a car touches one. Then the big screen shows a banner ("OIL SLICK! Kai spun out on Turn 4") — never who placed it.
5. **Traitor power.** Once per race, a traitor may tap **Glitch**: one chosen rival's steering reverses for 2 s. Big screen shows a static flash but not who did it.
6. **Vote (phones, 20 s)** after races 2 and 3. Phone shows short clues from the last race. Caught traitor loses points; a wrongly accused racer gets a small bonus.
7. **Score.** Racers: finishing position. Traitors: each crash caused by their trap + surviving votes. Podium on the big screen.

**Modes:** Traitors (main), Classic Race (no roles, visible items), Daily Track (solo vs ghost cars, later), Hotspot Party (app only).

**Design rules**
- Steering = two big buttons (left/right). Gas is automatic. Brake optional. Drift button later. Tilt is optional, never required.
- Every phone screen readable in 2 seconds. One decision at a time.
- No gap between races longer than 20 s.
- Cartoon style, no blood, no free chat → broad age rating.

---

## 2b. Tracks (launch set: 6, plus 2 later)

All tracks are original island/beach locations. Target lap time ~30 s, so a 3-lap race is ~90 s. Every track also has a Mirror version (flipped left↔right), which doubles the track list for free.

| # | Track | Shape | Difficulty | Special feature | Best trap spots | Arrives in |
|---|---|---|---|---|---|---|
| 1 | Sunny Cove | Wide rounded loop along the sand | Easy | None. Tutorial and first-race track | Exit of the long final bend | Phase 1 |
| 2 | Coconut Harbor | Loop over wooden docks and two narrow bridges | Easy–Medium | Narrow bridges: one car wide, so traps there are deadly | Bridge entries | Phase 2 |
| 3 | Lagoon Figure-8 | Figure-8 with a crossing in the middle | Medium | Cars can collide at the crossing; shallow water patch slows you | Just before the crossing | Phase 2 |
| 4 | Jungle Switchback | Tight hairpins up and down a hill | Medium | Risky shortcut through a hollow log (one car fits) | Hairpin apexes, log exit | Phase 3 |
| 5 | Volcano Rim | Loop around a crater | Hard | Lava cracks open on a fixed rhythm; ash patches have low grip | Next to lava cracks | Phase 3 |
| 6 | Boardwalk Night Market | City-style loop with 90° corners, at night | Medium–Hard | Crab crowds cross the road at set moments; limited view ahead | Blind corners | Phase 3 |
| 7 | Lighthouse Cliffs | Cliffside road with open edges | Hard | Wind gusts push cars sideways (shown by flags) | Cliff-edge straights | Phase 7 |
| 8 | Sandbar Sprint | Short, straight-heavy loop | Easy | Very fast; good for 8 players | Middle of straights | Phase 7 |

### Track file format (public/assets/tracks/<id>.json)
Fields: id, name, version, world ({w,h} in px, the area the background covers), centerline (closed loop of [x,y], ~40–120 points, smoothed in game), width, checkpoints (indexes into centerline; laps count only in order), startGrid (8 × [x,y,angle]), surfaces (sand/water polygons), hazards (bridge, lava with period, etc.), trapZones ([fromIndex,toIndex] where traps may be placed), racingLine (for bots), background (one pre-made image, also used for the phone view), minimap image.
Images are generated from the JSON with `npm run tracks` (SVG for now; hand-drawn art can replace them in Phase 4). Format types + validator: `shared/track-format.ts`. Tests check every file in the folder against the rules below.
Rules: no traps within 2 seconds of the start line; every track must be finishable by bots; every track has a minimap image.

---

## 3. Architecture

```
Phones (controllers)  ──WebSocket──►  Room server (Cloudflare Durable Object, PartyServer)  ◄──WebSocket──  Host screen (runs the game)
                                              │
                                     API Worker ── D1 (database), R2 (files), KV (config)

Website (/host, /play, landing, privacy) on Vercel
Hotspot mode: the host app runs a local WebSocket server; phones connect over the hotspot. Same messages.
```

**Rule: the host is the referee.** Only the host runs physics and decides crashes, laps, scores. Phones send intentions ("steering left"), never results. The room server keeps secrets the host must not show: roles, who placed which trap, votes.

### Tech stack

| Part | Tech |
|---|---|
| Web app | Next.js (App Router, TypeScript), Tailwind |
| Host game (Phase 1–3) | Phaser 4 for drawing, 2D top-down. Physics is our own small deterministic sim in `game/sim.ts` (not Arcade), so the same code can run in tests and later on the server to re-simulate laps for leaderboards (section 8) |
| Host game (Phase 4 visual upgrade) | Either pre-rendered 3D car sprites (16 angles) in Phaser, OR Three.js/Babylon.js + Rapier with a tilted camera. Decide by benchmark |
| Realtime | `partyserver` on Cloudflare Workers + Durable Objects (own Cloudflare account); client `partysocket` |
| API | Cloudflare Worker (Hono) |
| Storage | D1 (SQLite), R2 (track files, replays), KV (config, feature flags) |
| Apps | Capacitor (Android, iOS) + native plugins: haptics, keep-awake, screen-orientation, status-bar, local WebSocket server, zeroconf |
| Hosting | Vercel (website) — or Cloudflare Pages if simpler |
| Ads (Phase 3+) | Web: Google ads for H5 games (needs approval). Apps: AdMob. Family-safe, non-personalized |

### Repo layout (target)

```
track-traitors/
├─ app/                 Next.js pages: / , /host , /play
├─ game/                Phaser scenes, car physics, track loading, bots
├─ shared/              protocol types, constants, track format (used by host, phone, server)
├─ controller/          phone UI: buttons, role card, trap draft, vote, my-screen view
├─ party/               PartyServer room (Durable Object)
├─ scripts/             build tools (track images)
├─ api/                 API Worker (later phases)
├─ public/assets/       sprites, tracks (JSON), sounds
├─ PLAN.md  CLAUDE.md
```

---

## 4. Real-time design

### Who knows what

| Secret | Room server | Host screen | Each phone |
|---|---|---|---|
| Roles | all | none | own role only (traitors see each other) |
| Trap positions | all, with owners | positions at race start, **no owners**; draws a trap only when triggered | only the trap it placed |
| Votes | all, tallied | final result only | own vote only |

### Rates

| Stream | Path | Rate | Size | Delivery |
|---|---|---|---|---|
| Input `in` | phone → room → host | only on change + 1/s heartbeat | ~20 bytes | latest wins |
| Snapshot `snap` | host → room → phones with My screen ON | 15/s | ~12 bytes per car | latest wins |
| Events (`role`, `draft`, `place`, `traps`, `hit`, `glitch`, `vote`, `result`) | both ways | when they happen | small | must arrive, in order |
| Physics | host only | 60/s fixed timestep | — | — |

If no phone has My screen ON, the host sends **no** snapshots.

### Messages (JSON, every message has `v` version and `t` type)

```json
{"v":1,"t":"join","pid":"p7","seat":"<token>","name":"Atal","color":"#4DA3FF"}
{"v":1,"t":"lobby","players":[...],"vip":"p7"}
{"v":1,"t":"start","mode":"traitors","track":"harbor"}
{"v":1,"t":"role","role":"traitor","mates":["p3"]}          // room → one phone
{"v":1,"t":"draft","cards":["oil","ramp","boost"],"ms":20000} // room → one phone
{"v":1,"t":"place","card":"oil","x":412,"y":96}               // phone → room
{"v":1,"t":"traps","list":[["oil",412,96],["ramp",120,300]]}  // room → host, no owners
{"v":1,"t":"in","s":-1,"b":0,"g":0}                           // steer -1/0/1, brake, glitch
{"v":1,"t":"snap","k":881,"cars":[[x,y,angle,speed],...]}     // host → viewers
{"v":1,"t":"hit","trap":4,"car":"p2"}                         // host → room
{"v":1,"t":"glitch","target":"p5"}                            // traitor phone → room
{"v":1,"t":"vote","who":"p3"}                                 // phone → room
{"v":1,"t":"result","caught":["p3"],"scores":{...}}           // room → all
{"v":1,"t":"view","on":true}                                  // My screen toggle
```

Phase 1 also uses these (see `shared/protocol.ts` for the exact types):

```json
{"v":1,"t":"welcome","pid":"p7","seat":"<token>","name":"Zippy Crab","color":"#4DA3FF"} // room → one phone, after join
{"v":1,"t":"hosthello","seat":"<token>"}                      // host → room, claims or rejoins the room
{"v":1,"t":"phase","phase":"countdown","laps":2,"ms":3000}    // host → room → phones (lobby|countdown|race|results)
{"v":1,"t":"startreq"}                                        // VIP phone → room → host ("start")
{"v":1,"t":"ping","k":12,"r":45} / {"v":1,"t":"pong","k":12,"h":1} // phone ↔ host round trip (h:0 = room answered, host offline); r = phone's median RTT, shown on the host overlay
{"v":1,"t":"ack","k":31}                                      // host → one phone: input 31 is applied and drawn
{"v":1,"t":"stat","tt":42}                                    // phone → host: measured touch → TV ms
{"v":1,"t":"lap","p":"p7","lap":1,"laps":2}                   // host → room → that phone only
{"v":1,"t":"error","code":"full","msg":"..."}                 // room → one connection
```

**Touch → TV measurement:** the phone numbers each input (`k`) and remembers when the finger touched. The host acks `k` right after drawing the frame that used it. Phone computes `ack arrival − touch time − RTT/2` and reports it with `stat`. The host debug panel (key **D**) shows p50/p95.

Switch to binary (MessagePack) only if size becomes a measured problem.

### Reconnects
Each phone stores `pid` + random `seat` token (localStorage). If a phone drops, the room holds its seat for 60 s and its car drives straight. On reconnect with the token, the room re-sends its role and trap card. If the host drops, show "Host disconnected — waiting" on phones; host can rejoin with its own token within 60 s.

### Transport plan
1. **Now:** WebSocket through the room (simple, works everywhere).
2. **Later, only if playtests show stutter:** WebRTC data channels phone↔host (`ordered:false, maxRetransmits:0` for `in`/`snap`; a second reliable channel for events). Room does the handshake. WebSocket stays as fallback.
3. **Hotspot mode:** WebSocket to the host app's local server.

---

## 5. Performance rules (the main focus)

### Response time targets (measure, don't assume)
| Step | Target |
|---|---|
| Touch → message sent | < 16 ms |
| Phone → host, online, same region | < 80 ms |
| Phone → host, hotspot | < 20 ms |
| Host physics + draw | < 17 ms |
| **Touch → TV, total** | **< 120 ms online, < 60 ms hotspot** |

### Controller (phone) rules
- React on `pointerdown` / `touchstart`, **never `click`**.
- Instant local feedback: button lights up + haptic before the message reaches the host.
- Send input only when it changes. No 60/s spam.
- `touch-action: none; user-select: none;` on the controller. Viewport `maximum-scale=1`. Block pinch zoom and pull-to-refresh.
- Show a small connection dot (green/yellow/red) from measured round-trip time.
- Request Screen Wake Lock during a match.

### My screen (phone's own view, behind the buttons)
- **Never stream video.** The phone draws its own light view from `snap` data.
- Track = one pre-made image; phone pans/rotates it to follow its car and draws nearby cars as sprites.
- Render at half resolution, darkened + slightly blurred so buttons stay readable.
- Cap at 30 fps. If frame time stays high, drop to 15 fps, then to a still picture with just position/lap.
- Stop drawing when My screen is off, the page is hidden, or the screen dims.
- Crash/trap moments: play a short pre-made local animation (splash, spin, "BONK!") instead of anything streamed.

### Host rules
- Fixed 60 Hz physics step; render with interpolation.
- Apply each player's latest input on the next physics tick; smooth late inputs.
- Auto-lower render resolution if frame rate drops.
- First load target: < 10–15 MB. Load each track only when chosen.
- No real-time shadows; blob shadows under cars. Baked lighting. Texture atlases.

### Ads must never hurt speed
- Ad code loads only between matches, never during a race.
- No ad code on phones.

---

## 5b. Host screen layout and camera (Phase 2)

Fill the whole window
- The game canvas fills the full browser window at any size and aspect ratio (Phaser scale mode RESIZE, redraw on resize). No letterbox bars, no fixed-size box.
- Test at 1280×720, 1440×900, 1920×1080 and 2560×1080.
- Overlays (positions, banners, room code) stay pinned to screen edges and scale with window height so they're readable from a sofa.
- Fullscreen button on the host (and the F key); hide the mouse cursor after 3 s without movement.

Broadcast camera (instead of showing the whole map)
- Follows the PACK: centers on the average position of all cars and zooms so all cars stay in view with a margin.
- Zoom limits: never closer than about 3 car-lengths across the screen's short side, never further than the whole track. All changes smoothed (lerp), never jerky.
- Leader bias: center pulled slightly ahead of the leader so players see what's coming.
- If one car falls very far behind, keep the leading group in frame and show the straggler in a small corner window instead of zooming all the way out.
- Trap-hit cut: YES. When a trap triggers, zoom toward the crash for ~1.5 s with 0.5x slow motion on the host display only (physics keeps running normally), then return to the pack. Max one cut every 5 s. **After the cut, jump straight back to live** (decided 2026-11-21) — no fast-forward; the replay is drawn from the last 3 s of recorded poses.
- Race start: brief wide shot of the whole track, then zoom to the starting grid for the countdown.
- Finish: zoom on the finish line for a photo finish.
- A minimap in a corner always shows the full track and all cars.

Rest of the screen
- Right edge: live positions tower. Top center: event banners (trap hits, laps). Bottom left: room code. Bottom right: "traps still hidden" counter. A corner: minimap. Phone reactions float up from the bottom.

Performance: camera math runs once per frame on the host only; no extra network messages; must hold 60 fps.

**Built (2026-11-21):** `game/camera.ts` (pure math + Director, unit-tested), `game/hud.ts` (shared layout), `game/scene.ts` (three Phaser cameras: broadcast, minimap from the track's minimap image, straggler window). Details settled while testing:
- Shots are framed inside the screen area the positions tower leaves free; the view may run past the map edge only under the tower.
- A car goes to the straggler window only when framing everyone would need ~the whole-track zoom (1.15×), and the window shows only while that car is really off screen.
- The track background is rasterized at 2× so close-ups stay sharp.
- Dev: key **T** on the host fakes a trap hit on the leader (until real traps exist). The "traps still hidden" counter appears with traps.

Later (Phase 4): tilted 2.5D/3D host camera, and a pseudo-3D "behind your car" view on phones made by tilting the track image into perspective (Mode 7 style).

---

## 6. Ads rule (exact)

- Count **completed matches** per host device (localStorage in web, Preferences in app).
- Matches 1–20: no ads.
- After match 20: show one short ad on the big screen between matches (start with every match; tune later).
- Optional rewarded ad: watch to unlock a car skin for the session.
- Hotspot/offline: no ads.
- Families: non-personalized, family-safe ad settings.
- Ad blocked or failed to load → just continue. Never block play.

---

## 7. Backend and data (Phase 3+)

Play never waits for the backend. Guest-first.

**Tables (D1):** `players`, `tracks`, `track_reports`, `blocks`, `lap_records`, `daily_runs`, `matches`, `crews`, `ad_counters` (optional server copy).

**API:** `POST /v1/guest`, `POST /v1/rooms`, `GET/POST /v1/tracks`, `POST /v1/tracks/:id/report`, `POST /v1/laps`, `GET /v1/leaderboards/:track`.

**Files (R2):** `tracks/{id}.json`, `replays/{id}.bin` (inputs per tick, for re-simulation), clips expire after 30 days.

---

## 8. Security, safety, privacy

- Roles, trap owners and votes are only on the room server, sent one-to-one, never broadcast.
- Room codes: 4 letters, no confusing letters (O/0, I/1), expire when the room empties, rate-limited creation and joining. (Phase 1: codes and expiry done; rate limiting is added before the public deploy in Phase 3.)
- Leaderboards (later): accept a lap only if the server re-simulates the submitted inputs and gets the same time.
- Names: pick from a word list by default, or pass a profanity filter. **No free text chat.**
- Shared tracks (later): filter names, Report button, block author, contact email in app. (Apple guideline 1.2.)
- Collect almost nothing: random id, chosen name, scores. Privacy policy page on the website before any store submission.
- Do not target under-13s without legal advice (COPPA etc.).

---

## 9. Phases and gates

Do not start a phase until the previous gate passes.

| Phase | Build | Gate |
|---|---|---|
| **0. Paper test** | Printed track, toy cars, folded trap cards, secret role cards | Groups ask for another round. **Skipped by decision on 2026-11-19** — validate fun in Phase 2 playtests instead |
| **1. Core loop (web, 2D)** | Next.js `/host` + `/play`, PartyServer room, room code + QR, join, 1 track, left/right controls, laps, finish screen, reconnects, latency dot | Touch→TV < 120 ms on home Wi-Fi with 4 real phones (2 iPhone, 2 Android); 4 players race without disconnects |
| **2. Traitors** | Full-window host screen + broadcast camera (section 5b), Coconut Harbor + Lagoon Figure-8, roles, trap draft (3 cards), hidden traps, hit banner, Glitch, voting, scoring, 3-race match, bots | 7 of 10 test groups play 3+ matches in a row |
| **3. Polish + launch web** | All 6 launch tracks + Mirror versions, 6 cards, sounds, My screen view (state-drawn), ads after 20 matches, privacy page, deploy | 30% of test groups play again within 7 days |
| **4. Look upgrade** | Beach/island art, tilted 2.5D camera (benchmark sprites vs Three.js first), drift button, juicier effects, Mode 7 behind-the-car view on phones; speed lines, shake, sparks, engine sound on phone | Still 60 fps on a mid-range laptop; phones < 5% battery per 30 min |
| **5. Android app** | Capacitor, haptics, landscape lock, hotspot mode (2-phone spike first), AdMob, Play closed test (12 testers × 14 days) | Approved on Google Play |
| **6. iPhone + Discord** | iOS build (Codemagic), local-network permission text, Game Center, Discord Activity | Approved on App Store |
| **7. Community** | Track editor, weekly track, Daily Track, leaderboards with anti-cheat, moderation | Weekly track played by 20%+ of active players |

---

## 10. Numbers to track from day one

- QR scan → joined lobby (target 90%+)
- Matches per party night (3+)
- Groups back within 7 days (30%+)
- New players brought per party (1+)
- Measured touch → TV latency (p50 and p95)
- Host fps, phone fps and battery drain
- Disconnects per match

---

## 11. Known risks (watch list)

- Not fun / unbalanced → playtest weekly with real groups.
- iPhone Safari quirks (no fullscreen, no vibration, audio after first tap, sleep) → test on a real iPhone every week.
- Lag on busy Wi-Fi → measure early; WebRTC later only if needed.
- In-app browsers (WhatsApp/Instagram/Discord) → detect and show "Open in browser".
- Weak laptops/TVs → low-graphics mode.
- Hotspot plugins are immature → spike before committing.
- Apple "just a website" rejection → native features (haptics, offline, Game Center).
- Scope creep → one game, one phase at a time.
- Original art only → no copying other games' cars, characters, names or sounds. Keep a list of asset licenses (CC0 preferred, e.g. Kenney).

---

## 12. Extras to build in from the start

| Extra | What | Phase |
|---|---|---|
| Dev tools | /dev page that opens 1–7 fake phone controllers (bots sending inputs) so one person can test an 8-player race; latency/packet-loss simulator; overlay with fps, ping per player, messages per second. **Done:** fake phones speak the real phone protocol over the room server; the host tab (same browser) computes each bot's button with `game/bot.ts` and hands it over a BroadcastChannel, never the network. Bots hold a button ≥ 100 ms like a thumb. Simulator: sliders on /dev, or `?lag=&jitter=&loss=` on a real phone's /play URL (loss drops only `in`). Host overlay: key D. /dev is off in production builds | 1 |
| Track loader | Tracks load only from the JSON format, never hard-coded. **Done** (section 2b) | 1 |
| Strings file | All on-screen text in strings/en.json, used via `t("key", {vars})` from `shared/strings.ts` (room-server error texts too). Dev-only screens (/dev, host D overlay) are exempt | 1 |
| Analytics events | Log room created, player joined, match started/finished, vote result, disconnect, latency, fps. `shared/analytics.ts`; host logs game events (it is the referee), phones log `join_opened` (QR vs typed code) for the scan→join funnel. No names or personal data. Phase 1 sink = last 200 events in localStorage `tt-events` (+ console in dev); Phase 3 swaps in the API Worker | 1 |
| Host settings | Races (1/3/5), traitors (auto/1/2), trap cards per player (1/2), items on/off, bots on/off | 2 |
| Reactions | 6 fixed emoji-style buttons on phones (no text), floating on the big screen | 2 |
| Catch-up | Last place gets slightly higher top speed | 2 |
| First-race tutorial | 30-second guided first race on Sunny Cove | 3 |
| Accessibility | Pattern/number on each car color; one-thumb option; large text; blue/orange palette | 3 |
| Photo finish + highlight | Slow-motion replay from recorded positions (not video) | 3 |
| Name word list | Safe fun default names, editable through a filter | 3 |
| Spectators | Players 9+ vote on one bonus hazard per race | 7 |
| Weather/time variants | Rain or sunset versions of tracks | 7 |

Not now: track editor, leaderboards, accounts, Discord, second game.
