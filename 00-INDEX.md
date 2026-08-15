# HIGH SCORE — Build Spec Index

Read this first. It resolves conflicts between the three spec documents and defines the authoritative build order.

## Documents

| File | Covers |
|---|---|
| `01-rules-and-data.md` | Game rules, category eligibility, catalog schema, RAWG seed script, design tokens |
| `02-admin-and-history.md` | Override layer, admin panel, match records, stats |
| `03-mobile-and-multiplayer.md` | Server authority, Supabase schema, realtime, mobile layout, PWA |

## Precedence

**Where documents conflict, the higher-numbered document wins.** Specifically:

- **Part 1's three-column desktop layout is void.** The app is mobile-first per Part 3. Desktop is a responsive widening of the mobile layout, built last, not a separate design.
- **Part 1's build phases 4–8 are void.** They put UI before the server. Use the merged phase order below.
- **Part 2's `STORAGE_MODE` and `local` implementation are void.** There is no local mode. Supabase is the only store. Do not build a `Store` interface with two implementations — write directly against Supabase through server route handlers.
- **Part 2's dev-only admin write route is void.** Admin is Supabase-backed and token-gated, reachable from a phone.
- Part 1's rules, eligibility logic, catalog schema, seed script, and design tokens are **unchanged and authoritative**.
- Part 1's RAWG seed script is void. Use 04-data-source-igdb.md for the data layer.

## Merged build order

Build one phase at a time. Do not start a phase until the previous one runs.

**Foundation**
1. Scaffold — Next.js 15 App Router, TypeScript, Tailwind, Framer Motion, fonts, palette tokens
2. Seed script → `catalog.json`; verify 1,500+ entries and 80+ per category
3. `engine.ts` pure reducer + vitest suite, seeded PRNG, no UI

**Server**
4. Supabase project, schema, RLS. Realtime ON for `matches`, OFF for `match_secrets` — verify by watching a live payload
5. Route handlers wrapping `engine.ts`. Catalog imported server-side only. Score-stripped batch payloads
6. Lobby — room codes, join links, slot claiming, rejoin handling
7. Realtime subscription, refetch on `visibilitychange`, polling fallback, presence, connection indicator

Test phases 5–7 with two browser windows before touching a phone.

**Client**
8. Mobile shell — three tabs, sticky header, safe-area insets
9. Draft tab — candidate cards, pick sheet, turn flow, waiting state
10. Reveal choreography, on both phones, driven by `last_event`
11. Shuffle and Replace, including the head-to-head replace comparison
12. Board tabs — yours and theirs
13. Results screen + write to `match_history`

**Ship**
14. PWA — manifest, iOS meta tags, icons, install hint, minimal service worker

**Then**
15. Override layer — `applyOverrides` in the server-side catalog load
16. Admin panel, mobile-first
17. History and stats screens
18. Web push (optional)
19. Desktop responsive layout (optional)

## How to prompt Composer

One phase per session. Start each with:

> Read `@docs/00-INDEX.md`, `@docs/01-rules-and-data.md`, `@docs/02-admin-and-history.md`, `@docs/03-mobile-and-multiplayer.md`. Respect the precedence rules in the index. Build **Phase N only** — do not start Phase N+1. When done, list what you changed and what I should test.

Commit after every green phase. If Composer starts touching files outside the phase's scope, stop it and re-scope.

## Standing constraints

These apply to every phase and are worth restating in the prompt if Composer drifts:

- `catalog.json` must never be imported into a client component
- Never trust the client about whose turn it is — verify device id against `active_player` server-side
- `catalog.json` is generated output; overrides are a separate layer and never mutate it
- Match history stores snapshotted scores, not lookups
- Target 390×844 first
