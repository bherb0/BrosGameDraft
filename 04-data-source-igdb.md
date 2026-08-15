# Addendum 04 — Data Source: IGDB

> **This replaces the "Data layer" section of `01-rules-and-data.md` in full.** RAWG is unreliable and is not to be used. Everything else in doc 01 — rules, eligibility, design tokens — is unchanged.
>
> Add to the precedence list in `00-INDEX.md`: *Part 1's RAWG seed script is void. Use doc 04.*

---

## Naming change

IGDB is not Metacritic. Its critic aggregate is compiled from its own set of review sources, and the two will not always agree.

**Call it `CRITIC SCORE` everywhere in the UI**, not "Metacritic". The field in the schema stays `score` (rename from `metacritic`). This matters because either of you can google a title mid-match, and the app claiming "Metacritic 84" when Metacritic says 91 is worse than the app just saying "Critic 84".

The admin override panel from doc 02 is the release valve for any score you disagree with. That's exactly what it's for.

---

## Auth

IGDB uses Twitch OAuth, not a simple API key.

1. Create a Twitch account, go to the Twitch developer console, register an application.
2. Set OAuth Redirect URL to `http://localhost` (unused by IGDB, but required).
3. **Client Type must be Confidential** or you can't generate a secret.
4. You get a Client ID and Client Secret. Put both in `.env.local` as `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET`.

The seed script exchanges these for a bearer token:

```
POST https://id.twitch.tv/oauth2/token
  ?client_id=...&client_secret=...&grant_type=client_credentials
```

Returns `{ access_token, expires_in, token_type }`. Every subsequent request needs both:
```
Client-ID: <client id>
Authorization: Bearer <access_token>
```

Tokens last weeks, so a single fetch at script start is fine. No refresh logic needed.

---

## Querying

IGDB is **not REST with query params.** It's `POST` to `https://api.igdb.com/v4/games` with a plain-text body in its own query language (APIcalypse). Composer will get this wrong if you let it pattern-match to RAWG.

Body format — note the semicolons, they're required:

```
fields name, first_release_date, aggregated_rating, aggregated_rating_count,
       cover.image_id, genres.name, themes.name, platforms.name, platforms.id;
where aggregated_rating != null
  & aggregated_rating_count >= 8
  & first_release_date >= 883612800
  & first_release_date < 1798761600
  & category = 0
  & version_parent = null;
sort aggregated_rating desc;
limit 500;
offset 0;
```

Details that matter:
- `limit` maxes out at **500**. Paginate with `offset`, incrementing by 500.
- Rate limit is **4 requests/second**. Throttle, or you'll get 429s partway through and end up with a truncated catalog.
- `883612800` is 1998-01-01 UTC; `1798761600` is 2027-01-01 UTC. `first_release_date` is a Unix timestamp in seconds.
- `category = 0` restricts to main games — this excludes DLC, expansions, bundles, ports, and remasters. Without it your pool fills with "Season Pass" entries.
- `version_parent = null` drops alternate editions.
- **`aggregated_rating_count >= 8` is the important one.** IGDB's critic scores are badly skewed by single-review entries from defunct sites — obscure games land at 100 while classics sit in the 80s. Eight reviews is roughly where it stabilizes. If the catalog still looks wrong after seeding, raise it to 12 rather than lowering the score floor.
- `aggregated_rating` is a float. Round to an integer on write.

Stop paginating at 2,500 games or when a page returns fewer than 500 results.

---

## Cover art

IGDB returns `cover.image_id`, not a URL. Build it yourself:

```
https://images.igdb.com/igdb/image/upload/t_cover_big/{image_id}.jpg
```

Use `t_cover_big` (264×374) — `t_thumb` is far too small for a full-width mobile card. There's also `t_720p` and `t_1080p` if the cards look soft on a 3x display; test on an actual phone before deciding.

Add `images.igdb.com` to `next.config.ts` under `images.remotePatterns`.

---

## Category mapping

IGDB's genre taxonomy is different from RAWG's and there is **no "Action" genre** — action games are spread across themes and other genres. Map genre *and* theme names to our nine categories:

| Our category | IGDB genres | IGDB themes |
|---|---|---|
| Action/Adventure | Adventure, Hack and slash/Beat 'em up, Point-and-click | Action |
| Shooter | Shooter | — |
| Platformer | Platform | — |
| RPG | Role-playing (RPG), Turn-based strategy (TBS) *only if also RPG* | — |
| Strategy | Strategy, Real Time Strategy (RTS), Turn-based strategy (TBS), Tactical, Card & Board Game | — |
| Fighting | Fighting | — |
| Racing/Sports | Racing, Sport | — |

Notes:
- A game matching both `Adventure` and the `Action` theme is Action/Adventure. A game with the `Action` theme and nothing else still qualifies.
- `Turn-based strategy` maps to Strategy by default, and additionally to RPG when the game also carries `Role-playing (RPG)` — this is how Fire Emblem and XCOM-adjacent games land correctly.
- Genres we deliberately don't map: Indie, Simulator, Puzzle, Arcade, Music, Pinball, Quiz/Trivia, Visual Novel, MOBA. Games with only these are Wild-Card-only, which is fine and keeps that category interestingly weird.

### Console Exclusive

IGDB platform names are granular (`PlayStation 4`, `Xbox Series X|S`, `Nintendo Switch`, `PC (Microsoft Windows)`). Collapse to families first:

- **PlayStation** — any name starting `PlayStation`, plus `PSP`, `PS Vita`
- **Xbox** — any name containing `Xbox`
- **Nintendo** — `Nintendo Switch`, `Wii`, `Wii U`, `Nintendo 64`, `GameCube`, `Nintendo DS`, `Nintendo 3DS`, `Game Boy Advance`
- **PC** — `PC (Microsoft Windows)`, `Mac`, `Linux`
- Ignore everything else (mobile, arcade, legacy)

`exclusive = true` when the game touches exactly one of PlayStation/Xbox/Nintendo **and** does not touch PC. Everything else is false.

Build the family mapping as an explicit lookup table in the seed script, not a regex — IGDB platform names have inconsistent formatting and a regex will misfire on things like `Xbox 360 Games Store`.

---

## Schema

```ts
type CatalogGame = {
  id: string;            // igdb numeric id as string
  title: string;
  year: number;          // from first_release_date
  score: number;         // rounded aggregated_rating, 0-100
  reviewCount: number;   // aggregated_rating_count, kept for admin triage
  coverUrl: string;
  platforms: string[];   // collapsed families
  genres: Category[];
  exclusive: boolean;
  eligibleCategories: Category[];
};
```

`reviewCount` is worth keeping even though gameplay ignores it — when a score looks wrong in the admin panel, the first question is always how many reviews it's built on.

---

## Deduping

IGDB is cleaner than RAWG here, but still:
- Normalize titles for comparison: lowercase, strip punctuation, strip trailing edition markers (`Game of the Year Edition`, `Remastered`, `Definitive Edition`, `HD`, `Complete Edition`).
- Where duplicates remain after normalizing, keep the entry with the **highest `reviewCount`**, not the highest score — that's the canonical release rather than the lucky one.

---

## Seed script output

`npx tsx scripts/seed-catalog.ts` writes `src/data/catalog.json` and prints:
- Total games retained
- Count per category, with a warning under 80
- Count per year, so you can see if 2024–2026 coverage is thin
- Score distribution in 5-point buckets
- The 20 highest-scoring games in the catalog

**Read that last list before moving on.** It's the fastest sanity check there is — if the top 20 contains games neither of you has heard of, the review-count floor is too low. Raise it and re-run.

Preserve overrides across re-runs, per doc 02.

---

## If coverage disappoints

Two fallbacks, in order of preference:

1. **Raise the score floor, lower the review floor.** More reviews means safer scores but thinner recent-year coverage, since 2026 releases haven't accumulated them yet. There's a real tension here; tune it once you can see the year distribution.
2. **Backfill real Metacritic scores from a static CSV.** Public scraped datasets exist on GitHub covering games up to roughly 2020–2023. Matching them to IGDB entries by normalized title is fuzzy and will produce wrong matches, so if you go this route, treat the CSV as a *suggestion layer* surfaced in the admin panel for you to accept or reject — never as an automatic overwrite. I'd skip this for v1.

---

## Updated Phase 2

> Build **Phase 2 only**: the IGDB seed script per `@docs/04-data-source-igdb.md`. Twitch OAuth token exchange, paginated APIcalypse queries throttled to 4 req/sec, genre and platform mapping, dedupe, write `src/data/catalog.json`, print the full summary including the top 20. Do not build any UI or game logic. Stop when the script runs clean and the summary looks sane.
