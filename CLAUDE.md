# CLAUDE.md — Track Traitors

Read PLAN.md before any task. It is the source of truth for game rules, architecture, protocol and phases.

## How to work
- Work on ONE phase at a time (PLAN.md section 9). Don't build features from later phases unless asked.
- Before writing code for a new feature, give a short plan (files to touch, approach) and wait for "go".
- Keep changes small. After each step, tell me exactly how to test it on my phone and laptop.
- If something in PLAN.md is unclear or seems wrong, ask instead of guessing.
- When a decision changes, update PLAN.md in the same change.
- Commit after each working step with a clear message.

## Non-negotiable rules
- The host screen is the referee. Phones send inputs only, never results.
- Secrets (roles, trap owners, votes) live only on the room server. Never broadcast them.
- Phone buttons react on pointerdown/touchstart, never click. Instant local feedback.
- Phones send input only when it changes (+1/s heartbeat).
- Never stream video to phones. "My screen" is drawn from small state snapshots, half resolution, max 30 fps, stops when hidden.
- No snapshots sent when no phone has My screen on.
- Ads: none in matches 1–20; after that only between matches on the big screen. Never on phones, never during a race.
- Every network message has `v` and `t` fields. Shared types live in `shared/`.
- No free text chat. Original art and names only; record every asset's license.

## Commands (fill in as the project grows)
- Dev web: `npm run dev -- -H 0.0.0.0`
- Dev room server: `npm run dev:party` (wrangler dev on port 1999, all interfaces)
- Both at once: `npm run dev:all`
- Tests: `npm test` · Typecheck: `npm run typecheck`

## Testing checklist for every controller change
- Real iPhone (Safari) and real Android (Chrome)
- No zoom, scroll or text selection while mashing buttons
- Latency dot shows a sane value
- Phone lock → unlock reconnects to the same car
