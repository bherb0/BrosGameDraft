# HIGH SCORE

Two-player video game drafting game. Players draft games by hidden critic score across 9 rounds, placing each into one of 9 category slots. Highest average wins. Played remotely on two phones.

## Specs

Full specs are in `docs/`. Read `docs/00-INDEX.md` first — it defines precedence and the phase order.

Where docs conflict, the higher-numbered document wins. Doc 04 replaces the data-source section of doc 01 entirely.

## Build discipline

- Work **one phase at a time**, per the merged build order in `docs/00-INDEX.md`.
- Do not start the next phase without being asked.
- Stop when the phase's stated stopping condition is met, then summarize what changed and what to verify.

## Non-negotiable constraints

These are the ones that break the game if violated:

- **Never import `src/data/catalog.json` into a client component.** It contains every critic score. Server components and route handlers only.
- **Supabase Realtime is ON for `matches`, OFF for `match_secrets`.** Broadcasting the secrets table leaks every score to both players.
- **Never trust the client about whose turn it is.** Route handlers verify the device id against `active_player` and reject with 403.
- **`catalog.json` is generated output.** Overrides live in a separate layer keyed by game id and are applied on load. Never mutate the catalog.
- **Match history stores snapshotted scores**, not references. Editing an override later must not rewrite past match results.

## Stack

- Next.js 15 App Router, TypeScript, **Tailwind v4** (theme tokens live in `src/app/globals.css` under `@theme`, there is no `tailwind.config.ts`)
- Framer Motion for animation
- Vitest for tests
- Supabase (Postgres + Realtime) for state, accessed only through server route handlers using the service role key
- Deploy: Vercel

## Commands

- `npm run dev` — dev server
- `npm test` — vitest
- `npm run build` — production build
- `npx tsx scripts/seed-catalog.ts` — rebuild the game catalog from IGDB

## Conventions

- The rules engine in `src/lib/engine.ts` is a **pure reducer** with a seeded PRNG. It runs server-side. Keep all randomness and rule logic there, not in components.
- Design target is a 390×844 phone viewport. Desktop is a responsive widening, built last.
- The score field is called `score` and is labeled **CRITIC SCORE** in the UI — it comes from IGDB, not Metacritic. Do not call it Metacritic anywhere user-facing.

## Secrets

`.env.local` holds `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET`. It is gitignored. The repo is public — never write a secret into a tracked file, and never echo one into the terminal.
