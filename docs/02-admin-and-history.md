# Cursor Composer Prompt — Part 2: Admin Panel & Match History

> Paste this **after** phases 1–8 from Part 1 are working. Adding persistence before the game is playable will tangle the engine with I/O.

---

## What this adds

1. **An admin panel** at `/admin` for editing the catalog — override Metacritic scores you disagree with, fix miscategorized games, ban shovelware, and hand-add games RAWG missed.
2. **Match history** — every completed match is saved, with a running head-to-head record and stats across all matches played.

---

## Architectural rule: overrides are a layer, never an edit

`catalog.json` is generated output and must stay disposable — you'll want to re-run the seed script later to pull in 2026 releases. So **nothing ever mutates `catalog.json`**.

Instead, overrides live separately, keyed by game id, and are applied on load:

```ts
// src/lib/catalog.ts
function applyOverrides(base: CatalogGame[], overrides: Override[]): CatalogGame[]
```

```ts
type Override = {
  gameId: string;
  metacritic?: number;        // replaces the RAWG score
  addCategories?: Category[];
  removeCategories?: Category[];
  exclusive?: boolean;
  banned?: boolean;           // excluded from all pools
  note?: string;              // "we both think this is overrated"
  updatedAt: string;
};

type CustomGame = CatalogGame & { custom: true }; // hand-added, merged into the pool
```

Re-seeding then never destroys your edits. Make this explicit in the seed script output: `Catalog rebuilt. 47 overrides preserved.`

The original RAWG score is always retained and displayed alongside the override — in the admin panel, and optionally as a small `MC 84 → 91` annotation on results screens (behind a toggle, off by default so it doesn't clutter gameplay).

---

## Storage

Define one interface with two implementations, selected by `NEXT_PUBLIC_STORAGE_MODE`:

```ts
// src/lib/store/types.ts
interface Store {
  getOverrides(): Promise<Override[]>;
  saveOverride(o: Override): Promise<void>;
  deleteOverride(gameId: string): Promise<void>;
  getCustomGames(): Promise<CustomGame[]>;
  saveCustomGame(g: CustomGame): Promise<void>;
  getMatches(): Promise<MatchRecord[]>;
  saveMatch(m: MatchRecord): Promise<void>;
  deleteMatch(id: string): Promise<void>;
}
```

### Mode `local` (default — build this first)
- Overrides and custom games → `src/data/overrides.json`, written by a **route handler that only runs in development** (`if (process.env.NODE_ENV === 'production') return new Response(null, { status: 404 })`). Vercel's filesystem is read-only, so this is a dev-machine-only path by design — and because the file is in the repo, every score edit becomes a git commit you can review and revert.
- Match history → `localStorage` under key `highscore:matches:v1`, with a JSON export/import button so you don't lose the record.

This mode needs zero infrastructure. If you and your brother always play on the same laptop, **stop here — it's genuinely enough**, and skip the Supabase section entirely.

### Mode `supabase` (only if you want to play and edit from different machines)
Two tables. All access goes through Next.js route handlers using the **service role key server-side** — never ship the key to the client, and never let the browser talk to Supabase directly, since there's no auth on this app.

```sql
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
  exclusive boolean default false,
  created_at timestamptz default now()
);

create table matches (
  id uuid primary key default gen_random_uuid(),
  played_at timestamptz default now(),
  seed bigint not null,
  difficulty text not null,
  p1_name text not null,
  p2_name text not null,
  p1_avg numeric(5,2) not null,
  p2_avg numeric(5,2) not null,
  winner text not null,               -- 'p1' | 'p2' | 'draw'
  tiebreak text,                      -- null | 'highest' | 'count90'
  picks jsonb not null                -- full pick log, see below
);
```

RLS on, no public policies — the service role key bypasses RLS and the anon key can do nothing. Gate the route handlers behind a shared secret in `ADMIN_TOKEN` so a stranger who finds the URL can't rewrite your scores.

Add `scripts/export-overrides.ts` that pulls overrides from Supabase into `src/data/overrides.json`. Run it before deploying so gameplay reads from a local file with no runtime fetch, and the game still works if Supabase is down.

---

## Match records: denormalize everything

This is the part that's easy to get wrong. If a match record only stores game ids, then editing an override later silently rewrites your history — a match you won 84.2 to 83.9 could flip months afterward.

**Store the score as it was at the time of the match.** Each pick in the `picks` array:

```ts
type PickRecord = {
  round: number;
  player: 'p1' | 'p2';
  gameId: string;
  title: string;          // snapshot
  year: number;           // snapshot
  coverUrl: string;       // snapshot
  category: Category;     // where it was placed
  score: number;          // snapshot, override applied at match time
  wasReplace: boolean;
  replacedTitle?: string;
  replacedScore?: number;
};
```

Match records are append-only history. The only mutation allowed is deleting a match outright (misclick, abandoned game).

---

## Admin panel (`/admin`)

Not linked from the game UI — you navigate there directly. In `local` mode, show a banner: `Dev only. Changes write to overrides.json.`

### Catalog browser
- Virtualized table (react-window or similar — 1,500+ rows).
- Columns: cover thumb, title, year, RAWG score, override score, categories, exclusive, banned, note.
- Search by title, filter by category / year range / score range / `has override` / `banned`.
- Sort by any column.
- Rows with an active override get a left border in the `good` accent so edits are scannable.

### Inline editing
- Click the score cell → number input, 0–100, Enter to commit, Esc to cancel. Show `84 → 91` with the delta colored.
- Category cell → multi-select chips for the 9 categories. Adding/removing writes to `addCategories`/`removeCategories` rather than replacing the whole array, so a re-seed that fixes RAWG's genres doesn't get clobbered.
- Exclusive → toggle.
- Ban → toggle, with the row dimming immediately.
- Note → free text, shown on hover in the browser.
- Every edit saves optimistically with a toast: `Saved — Hollow Knight 90 → 94`. Include an undo action in the toast.

### Add a custom game
Form: title, year, Metacritic score, cover image URL, categories, exclusive. Validate year 1998–2026 and score 0–100. Generates id `custom:{slug}`. Useful for anything RAWG is missing or scored oddly.

### Overrides summary
A separate tab listing only active overrides and custom games, with revert buttons and a `Revert all` with confirm. Export/import as JSON.

### Pool health
A small panel showing eligible game count per category after overrides and bans are applied, with a warning below 80. Banning aggressively is the easiest way to accidentally starve a pool — surface it before a match breaks.

---

## History & stats (`/history`)

Linked from the start screen and the results screen.

### Head-to-head banner
Large, in the two player accent colors: `BEN 7 — 4 [BROTHER]`, plus draws if any. Beneath it: matches played, average margin, current streak.

### Match list
Reverse chronological. Each row: date, both averages with the winner's in their accent, margin, difficulty, and the winner's best pick. Click to expand into the full 9-slot board comparison from that match, rendered with the same slot component as the live game.

### Stats
- **Category win rate** — for each of the 9 categories, how often each player's slot beat the other's. This is the interesting one; it'll show you who reliably reads RPGs and who keeps whiffing on Wild Card.
- **Average score by category**, per player, as a small grouped bar chart.
- **Best board ever** — highest single-match average, with the lineup.
- **Best and worst single picks** across all matches.
- **Most drafted games** — the ones that keep showing up.
- **Shuffle and Replace effectiveness** — average score gained/lost when Replace was used. Worth knowing whether the gamble is actually paying off.

### Seed replay
Every match stores its seed. Add a `Replay this seed` button that starts a new match with the identical deal sequence — so you can re-run a match and see if different picks would have won it.

---

## Build phases

9. **Store interface + local mode** — `overrides.json` read path, dev-only write route, `applyOverrides` wired into `getPool`. Verify a manually edited JSON changes what the game deals.
10. **Admin catalog browser** — read-only table with search and filters first.
11. **Admin editing** — inline edits, custom games, overrides summary, pool health.
12. **Match recording** — build `MatchRecord` at game end, save to localStorage, confirm it survives a reload.
13. **History & stats screens.**
14. **Supabase mode** — only if you actually need cross-machine. Route handlers, `ADMIN_TOKEN` gate, export script.

---

## Definition of done

- Editing a score in `/admin` changes that game's score in the very next match, without touching `catalog.json`.
- Re-running the seed script preserves every override and custom game, and says so in its output.
- A completed match appears in `/history` immediately, and still shows its original scores after you later override one of those games.
- Pool health warns before any category drops below 80 eligible games.
- The admin write route returns 404 in production when running in `local` mode.
