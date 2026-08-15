# Cursor Composer Prompt — Part 3: Two-Phone Play & Mobile PWA

> This **supersedes** the storage section of Part 2. Drop `STORAGE_MODE` and the `local` implementation entirely — Supabase is now mandatory, not optional. Everything in Part 1 (rules, engine, seed script, catalog schema) still stands; the desktop three-column layout in Part 1 is replaced by the mobile layout below.

---

## What changed and why

Two players on two phones means the game can no longer live in one browser's React state. Turn order, the deal sequence, and the hidden scores all have to live somewhere neither client controls. That makes this a small client-server app:

- **Next.js route handlers on Vercel are the authority.** They own the rules.
- **Supabase Postgres is the state store.** One row per match.
- **Supabase Realtime pushes public state changes** to both phones.
- **`engine.ts` from Part 1 runs server-side.** This is why it was built as a pure reducer — the exact same tested code now validates every action. Don't rewrite it.

---

## The one thing that will leak if you're not careful

`catalog.json` contains every Metacritic score. **Never import it into a client component.** Next.js will happily bundle a 3MB file of answers into the browser, and the hidden-score mechanic dies instantly.

Import `catalog.json` only in route handlers and server components. Add a check to the build: grep the client bundle for a known score string and fail if found.

Batches sent to clients contain `{ id, title, year, coverUrl, eligibleCategories }` and nothing else. The score arrives only in the reveal response, after a pick is committed.

Be realistic about what this buys you, though: Metacritic scores are public and either of you could google a title mid-turn. Keeping scores off the wire prevents *lazy* peeking — someone opening devtools or noticing a score in a network payload. It is not a cheat-proof system, and it doesn't need to be. Don't spend effort past this point on anti-cheat.

---

## Schema

```sql
-- Public match state. Realtime is enabled on THIS TABLE ONLY.
create table matches (
  id uuid primary key default gen_random_uuid(),
  room_code text unique not null,          -- 4 chars, unambiguous alphabet
  status text not null default 'lobby',    -- lobby | active | complete | abandoned
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  difficulty text not null default 'wide',
  p1_device text,                          -- device id claiming slot 1
  p2_device text,
  p1_name text not null default 'Player 1',
  p2_name text not null default 'Player 2',
  round int not null default 0,            -- 0-9
  draw_category text,                      -- current round's pool
  active_player text,                      -- 'p1' | 'p2'
  first_picker text,                       -- 'p1' | 'p2', snakes each round
  batch jsonb not null default '[]',       -- SCORES STRIPPED
  boards jsonb not null default '{}',      -- { p1: {category: PlacedGame}, p2: {...} }
  charges jsonb not null default '{}',     -- { p1: {shuffle, replace}, p2: {...} }
  last_event jsonb,                        -- for reveal animations on the other phone
  winner text,
  tiebreak text
);

-- Hidden state. Realtime DISABLED. RLS denies everything. Service role only.
create table match_secrets (
  match_id uuid primary key references matches(id) on delete cascade,
  seed bigint not null,
  deal_sequence jsonb not null,   -- all 9 batches pre-generated at match creation
  scores jsonb not null           -- { gameId: metacritic } for every dealt game
);

-- Completed matches, append-only. Scores denormalized (see Part 2).
create table match_history (
  id uuid primary key,
  played_at timestamptz default now(),
  seed bigint not null,
  difficulty text not null,
  p1_name text not null,
  p2_name text not null,
  p1_avg numeric(5,2) not null,
  p2_avg numeric(5,2) not null,
  winner text not null,
  tiebreak text,
  picks jsonb not null
);

create table overrides (
  game_id text primary key,
  metacritic int,
  add_categories text[],
  remove_categories text[],
  exclusive boolean,
  banned boolean default false,
  note text,
  updated_at timestamptz default now()
);

create table custom_games (
  id text primary key,
  title text not null,
  year int not null,
  metacritic int not null,
  cover_url text,
  genres text[] not null default '{}',
  exclusive boolean default false
);
```

**Enable Realtime on `matches` only.** If you enable it on `match_secrets`, every score in the match gets broadcast to both phones and the game is over. Verify this in the Supabase dashboard before playing a real match.

RLS: enabled on every table, with **no public policies**. All access is server-side via the service role key. The anon key is never used and never shipped.

---

## Match lifecycle

### Identity without auth
On first load, generate a UUID and store it in `localStorage` as `highscore:device`. That's the player identity. No accounts, no email. If localStorage is evicted, the player re-claims their slot by re-entering the room code — handle the case where a device id doesn't match either slot on an active match by offering `Rejoin as Ben` / `Rejoin as [brother]`.

### Creating and joining
1. P1 taps `NEW MATCH`, picks difficulty, enters both names. Server creates the match, generates a 4-character room code from an unambiguous alphabet (no `0/O`, `1/I/L`), pre-generates all 9 batches from the seed, writes scores to `match_secrets`, sets `status = 'lobby'`.
2. Share sheet with a deep link: `https://…/join/ABCD`. On iOS this opens in the installed PWA if it's on the home screen.
3. P2 opens the link, claims slot 2, `status → 'active'`, round 1 deals.

### Every turn
Client POSTs to `/api/match/[id]/action` with `{ deviceId, type, payload }`. The handler:
1. Loads public state and secrets.
2. **Verifies the device id maps to `active_player`.** Reject with 403 otherwise. Never trust the client's claim about whose turn it is.
3. Runs `engine.ts` reducer.
4. Writes new public state (scores stripped from `batch`), sets `last_event` to describe what just happened so the other phone can animate it.
5. Returns the reveal payload to the acting player.

Realtime broadcasts the row update; the other phone re-renders and plays the reveal animation from `last_event`.

### Reconnection — do not skip this
Phones background constantly and iOS drops websockets when the app isn't foregrounded. Without this, you'll both be staring at stale boards.

- Refetch full state on mount, on `visibilitychange` → visible, and on Realtime reconnect.
- Treat Realtime as an optimization, not the source of truth. Poll every 15s as a fallback while it's your opponent's turn.
- Show a small connection dot in the header: connected / reconnecting / offline.
- Supabase Presence for `Ben is here` / `Waiting for Ben to open the app`.

---

## Mobile layout

Design for a 390×844 viewport first. Everything below assumes portrait; lock to portrait in the manifest.

### Three tabs, fixed bottom bar
`DRAFT` · `MY BOARD` · `THEIRS`. Bottom bar sits above the home indicator with `env(safe-area-inset-bottom)` padding. Badge the `THEIRS` tab when the opponent picks so you know to look.

### Header (sticky, compact)
```
┌────────────────────────────────┐
│ R3/9 · RPG POOL          ● 🔗  │
│ BEN 84.2          BROTHER 79.1 │
└────────────────────────────────┘
```
Your average in your accent, theirs muted. Two lines, ~72px tall. Nothing else.

### Draft tab
The 5 candidates as **full-width vertical cards**, scrolling. Not a carousel — you need to compare, and swipe carousels hide options.

Each card: cover art as the background with a dark gradient scrim, title in Chakra Petch over it, year in mono, and a row of small chips showing eligible categories. Minimum 96px tall, tappable anywhere.

Power buttons pinned above the tab bar as a two-up row: `⟳ SHUFFLE 3` and `⇄ REPLACE 3`. Disabled states are visibly dimmed with a reason on tap, not a hover tooltip.

### Picking → bottom sheet
Tapping a card raises a bottom sheet:
- The chosen game at the top, compact.
- Eligible open slots as a 3-column grid of chips. Ineligible and filled slots are shown but dimmed, so you can see what you're giving up.
- `LOCK IT IN` as a full-width primary button at the bottom, in your accent, 52px tall.
- Swipe down or tap the scrim to cancel.

This two-step commit matters on mobile — a single tap placing a game is a misclick waiting to happen.

### Reveal — full-screen takeover
On mobile this should own the whole screen for about 1.4 seconds:
1. Scrim fades in over everything.
2. Cover art scales up centered.
3. Score counts from 0 in JetBrains Mono at ~96px, easing out.
4. Band color flashes: 90+ gold, 80–89 green, 70–79 neutral, sub-70 red.
5. Card shrinks and flies into its slot; scrim clears; header average counts up.

The same sequence plays on the opponent's phone, driven by `last_event`, with their accent color and a `BEN PICKED` label. Watching their reveal land is most of the fun of remote play — don't reduce it to a quiet state change.

### Waiting state
When it's not your turn, the draft tab stays fully visible so you can plan, but cards are non-interactive with a subtle desaturation. A persistent strip above the tab bar reads `WAITING FOR BEN` with a pulse. Never blank the screen or block the UI.

### Board tabs
3×3 grid of slots, each showing cover thumb, score in mono, category label, and year. Empty slots show the category name in muted display type. Tap a slot for a detail sheet. Your board is in your accent, theirs in theirs.

### Touch and iOS specifics
- Every tappable target ≥ 44×44pt.
- `touch-action: manipulation` on interactive elements to kill the 300ms double-tap-zoom delay.
- `user-select: none` on cards and buttons so long-press doesn't select text.
- `overscroll-behavior: none` on the body to stop rubber-band bounce.
- Use `100dvh`, never `100vh` — iOS Safari's address bar breaks `vh`.
- `:active` states on everything, since there is no hover. Cards depress 2px and brighten.
- Haptics via the Vibration API where supported — a short pulse on pick confirm. iOS Safari doesn't support it; degrade silently, don't feature-detect loudly.

---

## PWA setup

`app/manifest.ts`:
```ts
{
  name: 'HIGH SCORE',
  short_name: 'HIGH SCORE',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0D0F14',
  theme_color: '#0D0F14',
  start_url: '/',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
}
```

iOS also needs, in the root layout head:
- `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` — 180×180, no transparency, no rounded corners (iOS masks it itself)
- `<meta name="apple-mobile-web-app-capable" content="yes">`
- `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`
- `viewport` with `viewport-fit=cover, user-scalable=no`

Then pad the app shell with `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` so nothing hides under the notch or home indicator.

A service worker is not required for iOS home-screen install. Add a minimal one (via Serwist) that caches the app shell and shows a branded offline screen, and nothing more — do not try to cache match state.

Add an install hint on the start screen for first-time iOS visitors: `Tap Share → Add to Home Screen` with the share glyph, dismissible, hidden when `window.navigator.standalone` is true.

---

## Web push (build last, and only if you want it)

iOS 16.4+ supports Web Push in installed PWAs, which turns this into a play-across-the-day async game rather than something you both have to sit down for. Worth it, but genuinely optional.

Requirements: VAPID keypair in env, a `push_subscriptions` table keyed by device id, permission requested from a real button tap (never on load — iOS will hard-deny), and a send on turn change from the action route handler. Notification copy: `Your turn — Round 4, RPG pool`. Only notify when it's the recipient's turn and only if they haven't acted in 60 seconds.

---

## Admin and history on mobile

Both are now Supabase-backed and reachable from the phone.

**`/admin`** is gated by a token: prompt for `ADMIN_TOKEN` once, store the hash in localStorage, send it as a header on every admin route handler call. Handlers reject without it. Mobile layout is a search field plus a scrolling result list; tapping a game opens a bottom sheet with score, categories, exclusive, ban, and note. The 1,500-row virtualized table from Part 2 becomes desktop-only — on phone, search is the interface.

**`/history`** works as specced in Part 2, now reading from `match_history`. On mobile, the head-to-head banner is the hero, the match list is a scrolling list of rows, and stats live behind a segmented control rather than all on one screen.

---

## Build phases (replacing Part 2's phases 9–14)

9. **Supabase project + schema + RLS.** Confirm Realtime is on for `matches` and off for `match_secrets`. Do this manually in the dashboard and verify by subscribing and watching the payload.
10. **Server authority.** Route handlers wrapping `engine.ts`, catalog loaded server-side only, batch payloads score-stripped. Test with two browser windows before touching a phone.
11. **Realtime + reconnection.** Subscribe, refetch on visibility change, polling fallback, connection indicator, presence.
12. **Lobby.** Room codes, join links, slot claiming, rejoin handling.
13. **Mobile layout.** Three tabs, vertical candidate cards, pick sheet, board grids, safe areas.
14. **Reveal choreography** on both phones, driven by `last_event`.
15. **PWA shell.** Manifest, iOS meta tags, icons, install hint, minimal service worker.
16. **History + admin**, mobile layouts.
17. **Web push**, if you want it.

---

## Definition of done

- Both phones can run a full 9-round match from a shared link, with neither able to see a score before it's revealed.
- Backgrounding the app for five minutes and reopening restores correct state within a second.
- Killing the app entirely and relaunching from the home screen rejoins the match in progress.
- A POST from the non-active player's device is rejected with 403.
- Searching the client bundle for any Metacritic score returns nothing.
- Nothing is obscured by the notch or home indicator, in either Safari or standalone mode.
- Completed matches land in `match_history` and the head-to-head record updates.
