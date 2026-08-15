# Cursor Composer Prompt — "HIGH SCORE" (Metacritic Draft Game)

> Paste everything below the line into Cursor Composer in a new empty repo. Build it in the phases listed — don't let Composer one-shot the whole thing, it will hallucinate the data layer.

---

## Project brief

Build a local two-player (hot-seat) video game drafting game called **HIGH SCORE**. It's modeled on the "Impact Monster" mode from databallr.com, but instead of drafting NBA players by hidden impact metrics, players draft **video games by hidden Metacritic score**.

**Stack:** Next.js 15 (App Router) + TypeScript + Tailwind CSS + Framer Motion. No backend, no auth, no database — all state is client-side React state, and the game catalog is a static JSON file committed to the repo. Deploy target is Vercel.

---

## Core game rules (implement exactly)

### Setup
- Two players: **P1** and **P2**. Both are on the same screen, taking alternating turns.
- Each player has a **board of 9 category slots**:
  1. Action/Adventure
  2. Shooter
  3. Platformer
  4. RPG
  5. Strategy
  6. Fighting
  7. Racing/Sports
  8. Console Exclusive
  9. Wild Card
- The game runs **9 rounds**. Each round, one batch of **5 candidate games** is dealt face-up showing **title, cover art, and release year — but NOT the Metacritic score**.
- Each round, both players make exactly one pick from that same batch of 5. After both have picked, a new batch of 5 is dealt.
- **Snake order:** Round 1 → P1 picks first. Round 2 → P2 picks first. Round 3 → P1. Alternating.
  - Because 9 is odd, P1 gets first pick 5 times and P2 gets 4. Compensate: **P2 starts with 4 Shuffles instead of 3.** Make this a constant (`P2_SHUFFLE_BONUS = 1`) so it's easy to tune.

### Dealing a batch
- At the start of each round, pick a **draw category** at random from the 9 (without replacement across the game, so all 9 draw categories are used once).
- Deal 5 games at random from the pool of games eligible for that draw category. No repeats — a game that has ever appeared in any batch this match cannot appear again.
- Display the draw category as a round header (e.g. `ROUND 3 · RPG POOL`).

### Making a pick
- The active player clicks a game, then chooses **which open slot on their board** to put it in.
- A game can only go into a slot it's **eligible** for (see eligibility rules below). Eligible open slots are highlighted; ineligible ones are dimmed and unclickable.
- On confirm, the **score reveals** with an animation, the card flies to the slot, and the turn passes.
- The picked game is removed from the batch, so the second player picks from the remaining 4.

### Category eligibility
Every game in the catalog carries a `genres[]` array, an `exclusive` boolean, and a derived `eligibleCategories[]`. Rules:
- A game is eligible for a genre category if that genre is in its `genres[]`.
- A game is eligible for **Console Exclusive** if `exclusive === true`.
- **Every game is eligible for Wild Card.** Always.
- A game can be eligible for multiple categories (e.g. Bloodborne → RPG, Action/Adventure, Console Exclusive, Wild Card). The player chooses where to spend it. That choice is the actual strategy of the game — don't auto-place.

### Shuffle (3 uses per player, P2 gets 4)
- Only usable on the active player's turn, and **only if they are the first picker that round** (otherwise it would nuke the other player's read on the batch).
- Discards the current batch and deals 5 new games from the same draw category.
- If the pool for that category is exhausted, disable the button with tooltip `No games left in this pool`.

### Replace (3 uses per player)
- Usable on the active player's turn instead of a normal pick.
- The player selects a candidate game from the batch AND a **filled** slot on their board that the candidate is eligible for.
- On confirm: both scores are revealed side by side. **The higher score stays, the lower one is discarded.** The Replace charge is consumed either way — so it's a real gamble, not a free upgrade.
- Show the swap as a head-to-head animation: old score on the left, new score on the right, winner highlighted.

### End of game & scoring
- After 9 rounds, both boards are full (9 games each).
- Winner = higher **average Metacritic score** across their 9 slots.
- Tiebreakers, in order: (1) highest single score, (2) count of games scoring 90+, (3) declare a draw.
- Results screen shows both boards side by side, per-slot scores, per-slot winner highlight, category-by-category deltas, and the final averages counting up.

---

## Data layer — build this FIRST, before any UI

**Do not invent game data or hardcode a list of games from memory. Scores will be wrong.** Instead:

### Seed script
Write `scripts/seed-catalog.ts`, run manually with `npx tsx scripts/seed-catalog.ts`. It:
1. Reads `RAWG_API_KEY` from `.env.local` (free key from rawg.io/apidocs — add `.env.local` to `.gitignore`).
2. Pages through the RAWG `/games` endpoint with `dates=1998-01-01,2026-12-31`, `ordering=-metacritic`, `page_size=40`, `metacritic=60,100`, iterating until it has collected **at least 1,500 games** or runs out of results.
3. For each result, keeps only entries where `metacritic` is a non-null number and `released` is a valid date.
4. Maps each to the schema below.
5. Dedupes by normalized slug (strip subtitles like "Game of the Year Edition", "Remastered", "Definitive Edition" — keep the highest-scoring version of each franchise entry).
6. Writes `src/data/catalog.json`, pretty-printed, sorted by title.
7. Prints a summary to stdout: total count, count per category, count per year bucket, and a warning for any category with fewer than 80 entries.

### Schema
```ts
type CatalogGame = {
  id: string;              // rawg slug
  title: string;
  year: number;            // from `released`
  metacritic: number;      // 0-100
  coverUrl: string;        // rawg background_image
  platforms: string[];     // parent platform names
  genres: Category[];      // mapped, see below
  exclusive: boolean;
  eligibleCategories: Category[]; // computed at seed time
};
```

### RAWG genre/tag → our category mapping
Do this mapping in the seed script, not at runtime:
- `Action` + `Adventure` → **Action/Adventure**
- `Shooter` → **Shooter**
- `Platformer` → **Platformer**
- `RPG` → **RPG**
- `Strategy`, `Board Games`, `Card`, `Educational` (only if also strategy) → **Strategy**
- `Fighting` → **Fighting**
- `Racing`, `Sports` → **Racing/Sports**
- **Console Exclusive:** `exclusive = true` when the game's parent platforms list contains exactly one of {PlayStation, Xbox, Nintendo} and does NOT contain PC. Treat PC-inclusive releases as non-exclusive.
- **Wild Card:** every game.

If a game maps to zero genre categories, it still enters the catalog — it's Wild-Card-only (and Console-Exclusive-only if applicable).

### Runtime data access
- `src/lib/catalog.ts` imports the JSON once and exposes `getPool(category: Category): CatalogGame[]`, memoized.
- Add a **quality floor filter** so the game isn't full of obscure shovelware: default to `metacritic >= 65`, exposed as a constant `MIN_SCORE`. Add a difficulty toggle on the start screen: *Classics* (`>= 80`, tighter score spread, harder reads) / *Wide Open* (`>= 65`).
- Guard the whole app: if `catalog.json` is missing or has under 200 entries, render a clear setup screen explaining how to run the seed script. Do not crash.

---

## Architecture

Keep the rules engine pure and separate from React so it's testable and Composer doesn't tangle state into components.

```
src/
  data/catalog.json
  lib/
    catalog.ts        // load, filter, pool access
    types.ts          // Category, CatalogGame, GameState, Action
    engine.ts         // pure reducer: (state, action) => state
    engine.test.ts    // vitest
  components/
    StartScreen.tsx
    RoundHeader.tsx   // round number, draw category, turn indicator
    CandidateCard.tsx // cover, title, year, hidden/revealed score
    CandidateRow.tsx  // the 5 dealt games
    PlayerBoard.tsx   // 3x3 slot grid
    Slot.tsx
    PowerBar.tsx      // shuffle + replace charges
    RevealOverlay.tsx // the score reveal moment
    ResultsScreen.tsx
  app/page.tsx        // orchestrates, holds useReducer(engine)
```

`engine.ts` exports a single reducer handling: `START_GAME`, `DEAL_BATCH`, `SELECT_CANDIDATE`, `PLACE_IN_SLOT`, `USE_SHUFFLE`, `USE_REPLACE`, `CONFIRM_REPLACE`, `END_TURN`, `END_GAME`. All randomness goes through a seeded PRNG (`mulberry32`) stored in state, so a match is reproducible from a seed — this makes tests deterministic and lets you add a "share this seed" feature later.

Write vitest tests for: snake order across 9 rounds, no duplicate games dealt in a match, eligibility gating, shuffle exhaustion, replace keeping the higher score, and tiebreaker resolution.

---

## Design direction

The reference is a dark analytics dashboard, but this is about games — so the visual language is **an arcade scoreboard crossed with a cartridge shelf**, not a Bloomberg terminal.

### Palette
| Token | Hex | Use |
|---|---|---|
| `ink` | `#0D0F14` | page background |
| `panel` | `#171B24` | cards, boards |
| `edge` | `#252B38` | borders, dividers |
| `p1` | `#E8A33D` | Player 1 accent (amber) |
| `p2` | `#38BDD6` | Player 2 accent (cyan) |
| `good` | `#4ADE80` | reveal, positive delta |
| `bad` | `#F0555C` | negative delta, discard |
| `text` | `#E6E8EC` | primary text |
| `muted` | `#78829A` | labels, metadata |

Player accents must be used consistently and everywhere — board borders, turn indicator, score numerals, results bars. At a glance you should always know whose turn it is.

### Type
- **Display:** Chakra Petch (600/700), uppercase, tracking `0.08em` — headers, player names, category labels.
- **Numerals:** JetBrains Mono (700), tabular figures — every Metacritic score, average, and delta. Scores should feel like scoreboard readouts.
- **Body/UI:** Inter Tight (400/500) — buttons, tooltips, helper text.

Load via `next/font/google`.

### Signature moment — the reveal
This is the one place to spend animation budget. When a pick is confirmed:
1. The card lifts and the cover art desaturates to ~30%.
2. A score plate slides up over the lower third of the card.
3. The number counts up from 0 to the real score over ~450ms with an ease-out curve, in JetBrains Mono.
4. The plate flashes the score-band color for 120ms, then settles: 90+ gold, 80–89 green, 70–79 neutral, below 70 red.
5. The card flies to its slot on the player's board and the board's running average recalculates with a count-up.

Everything else stays quiet: 150ms hover lifts on candidate cards, a soft pulse on eligible slots when a candidate is selected, no page transitions, no particles.

### Layout
```
┌──────────────────────────────────────────────────────────┐
│ HIGH SCORE          ROUND 3/9 · RPG POOL      P1 82.4  ▲ │
│                                               P2 79.1    │
├───────────────┬──────────────────────────┬───────────────┤
│  P1 BOARD     │   [5 candidate cards]    │  P2 BOARD     │
│  3x3 slots    │   in a horizontal row    │  3x3 slots    │
│               │                          │               │
│  ⟳⟳⟳ ⇄⇄⇄     │   ← P1'S TURN            │  ⟳⟳⟳⟳ ⇄⇄⇄    │
└───────────────┴──────────────────────────┴───────────────┘
```
The active player's board gets a lit accent border; the inactive one drops to ~50% opacity. Running averages update live in the header so there's constant tension.

Empty slots show the category name in muted display type. Filled slots show a small cover thumbnail, the score in mono, and the year.

Responsive: below 1024px, stack as candidates → active player's board → tap-to-view opponent board. Respect `prefers-reduced-motion` (skip count-ups, use instant state changes). Visible keyboard focus rings in the active player's accent color.

### Copy tone
Terse and scoreboard-like. `PICK`, `SHUFFLE`, `REPLACE`, `LOCK IT IN`, `3 LEFT`. Empty states are instructions, not apologies: *"Select a game, then choose a slot."* Errors are specific: *"Halo 3 can't go in RPG."*

---

## Build phases

Do these one at a time. Confirm each works before moving on.

1. **Scaffold** — Next.js + TS + Tailwind + Framer Motion, fonts wired, Tailwind theme extended with the palette tokens above.
2. **Seed script** — write it, run it, verify `catalog.json` has 1,500+ entries with sane category distribution. Print the summary. Do not proceed until every category has 80+ eligible games.
3. **Engine** — `types.ts`, `engine.ts`, `engine.test.ts`. All tests green, no UI yet.
4. **Static UI** — boards, candidate row, header, power bar, wired to engine state with placeholder data. No animation.
5. **Turn flow** — select → highlight eligible slots → place → reveal → pass turn → deal next batch. Basic reveal only.
6. **Shuffle + Replace** — including the head-to-head replace comparison.
7. **Results screen** — side-by-side boards, deltas, count-up averages, rematch button.
8. **Polish** — the full reveal choreography, hover states, reduced-motion, mobile layout, keyboard nav.

---

## Constraints & gotchas

- **Never expose a hidden score in the DOM before reveal.** Store scores in state, but don't render them into markup on face-down cards — a curious brother will open devtools.
- Cover art comes from `media.rawg.io`. Add it to `next.config.ts` `images.remotePatterns`. Every `<Image>` needs a fallback for broken/missing covers — a generated placeholder tile using the game's title initials on the panel color.
- No `localStorage` or `sessionStorage` needed; a match lives in React state. If you want a rematch to keep the running series score, hold it in state too.
- Don't scrape metacritic.com. RAWG is the sanctioned source for these scores and it's what the seed script uses.
- The catalog JSON will be a few MB. Import it in a client component only after confirming bundle size is acceptable; if it's too heavy, move it to `public/catalog.json` and fetch it on the start screen with a loading state.

---

## Definition of done

- `npm run dev` boots to a start screen with a difficulty toggle and a `START DRAFT` button.
- A full 9-round match is playable end to end by two people on one keyboard/mouse without a single console error.
- Shuffle and Replace both work, are correctly limited, and correctly disabled when unavailable.
- No game ever appears twice in a match.
- Every placement respects category eligibility.
- The results screen correctly names a winner, including on tiebreakers.
- All vitest tests pass.
