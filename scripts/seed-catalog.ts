/**
 * IGDB catalog seed script.
 *
 * Usage:
 *   npm i -D tsx
 *   npx tsx scripts/seed-catalog.ts
 *
 * Reads IGDB_CLIENT_ID and IGDB_CLIENT_SECRET from .env.local (or from
 * process.env, so it also works on Replit Secrets / CI).
 *
 * Writes src/data/catalog.json and prints a summary.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

// ---------------------------------------------------------------- config

const MIN_REVIEW_COUNT = 8; // raise to 12 if the top 20 looks obscure
const START_UNIX = 883612800; // 1998-01-01 UTC
const END_UNIX = 1798761600; // 2027-01-01 UTC
const PAGE_SIZE = 500; // IGDB max
const THROTTLE_MS = 260; // ~4 req/sec
const OUT_PATH = "src/data/catalog.json";

const CATEGORIES = [
  "Action/Adventure",
  "Shooter",
  "Platformer",
  "RPG",
  "Strategy",
  "Fighting",
  "Racing/Sports",
  "Console Exclusive",
  "Wild Card",
] as const;

type Category = (typeof CATEGORIES)[number];

// IGDB genre name -> our categories
const GENRE_MAP: Record<string, Category[]> = {
  "Adventure": ["Action/Adventure"],
  "Hack and slash/Beat 'em up": ["Action/Adventure"],
  "Point-and-click": ["Action/Adventure"],
  "Shooter": ["Shooter"],
  "Platform": ["Platformer"],
  "Role-playing (RPG)": ["RPG"],
  "Strategy": ["Strategy"],
  "Real Time Strategy (RTS)": ["Strategy"],
  "Turn-based strategy (TBS)": ["Strategy"],
  "Tactical": ["Strategy"],
  "Card & Board Game": ["Strategy"],
  "Fighting": ["Fighting"],
  "Racing": ["Racing/Sports"],
  "Sport": ["Racing/Sports"],
};

// IGDB theme name -> our categories
const THEME_MAP: Record<string, Category[]> = {
  "Action": ["Action/Adventure"],
};

// Platform family detection. Order matters: PC is checked independently.
const PLATFORM_FAMILIES: Record<string, string[]> = {
  PlayStation: [
    "PlayStation", "PlayStation 2", "PlayStation 3", "PlayStation 4",
    "PlayStation 5", "PlayStation Portable", "PlayStation Vita", "PSP",
  ],
  Xbox: ["Xbox", "Xbox 360", "Xbox One", "Xbox Series X|S", "Xbox Series X"],
  Nintendo: [
    "Nintendo Switch", "Nintendo Switch 2", "Wii", "Wii U", "Nintendo 64",
    "Nintendo GameCube", "Nintendo DS", "Nintendo 3DS", "New Nintendo 3DS",
    "Game Boy Advance", "Game Boy Color",
  ],
  PC: ["PC (Microsoft Windows)", "Mac", "Linux"],
};

// ---------------------------------------------------------------- types

type CatalogGame = {
  id: string;
  title: string;
  year: number;
  score: number;
  reviewCount: number;
  coverUrl: string;
  platforms: string[];
  genres: Category[];
  exclusive: boolean;
  eligibleCategories: Category[];
};

type IgdbGame = {
  id: number;
  name: string;
  first_release_date?: number;
  aggregated_rating?: number;
  aggregated_rating_count?: number;
  cover?: { image_id: string };
  genres?: { name: string }[];
  themes?: { name: string }[];
  platforms?: { name: string }[];
};

// ---------------------------------------------------------------- env

function loadEnv(): { id: string; secret: string } {
  let id = process.env.IGDB_CLIENT_ID;
  let secret = process.env.IGDB_CLIENT_SECRET;

  const envPath = resolve(process.cwd(), ".env.local");
  if ((!id || !secret) && existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, "");
      if (m[1] === "IGDB_CLIENT_ID" && !id) id = value;
      if (m[1] === "IGDB_CLIENT_SECRET" && !secret) secret = value;
    }
  }

  if (!id || !secret) {
    console.error(
      "Missing IGDB_CLIENT_ID or IGDB_CLIENT_SECRET.\n" +
        "Set them in .env.local or as environment variables."
    );
    process.exit(1);
  }
  return { id, secret };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getToken(id: string, secret: string): Promise<string> {
  const url =
    `https://id.twitch.tv/oauth2/token?client_id=${id}` +
    `&client_secret=${secret}&grant_type=client_credentials`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

// ---------------------------------------------------------------- fetch

async function fetchAll(clientId: string, token: string): Promise<IgdbGame[]> {
  const all: IgdbGame[] = [];
  let lastId = 0;
  let page = 0;

  // Keyset pagination on id — stable, and avoids IGDB's offset ceiling.
  for (;;) {
    const body = `
fields name, first_release_date, aggregated_rating, aggregated_rating_count,
       cover.image_id, genres.name, themes.name, platforms.name;
where aggregated_rating != null
  & aggregated_rating_count >= ${MIN_REVIEW_COUNT}
  & first_release_date != null
  & first_release_date >= ${START_UNIX}
  & first_release_date < ${END_UNIX}
  & category = 0
  & version_parent = null
  & id > ${lastId};
sort id asc;
limit ${PAGE_SIZE};`.trim();

    const res = await fetch("https://api.igdb.com/v4/games", {
      method: "POST",
      headers: {
        "Client-ID": clientId,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      body,
    });

    if (res.status === 429) {
      console.log("  rate limited, backing off 2s...");
      await sleep(2000);
      continue;
    }
    if (!res.ok) {
      throw new Error(`IGDB query failed (${res.status}): ${await res.text()}`);
    }

    const batch = (await res.json()) as IgdbGame[];
    if (batch.length === 0) break;

    all.push(...batch);
    lastId = batch[batch.length - 1].id;
    page++;
    process.stdout.write(`\r  page ${page} — ${all.length} games fetched`);

    if (batch.length < PAGE_SIZE) break;
    await sleep(THROTTLE_MS);
  }

  process.stdout.write("\n");
  return all;
}

// ---------------------------------------------------------------- mapping

function collapsePlatforms(names: string[]): string[] {
  const families = new Set<string>();
  for (const name of names) {
    for (const [family, members] of Object.entries(PLATFORM_FAMILIES)) {
      if (members.includes(name)) families.add(family);
    }
  }
  return [...families];
}

function mapCategories(game: IgdbGame): Category[] {
  const out = new Set<Category>();
  const genreNames = (game.genres ?? []).map((g) => g.name);
  const themeNames = (game.themes ?? []).map((t) => t.name);

  for (const name of genreNames) {
    for (const c of GENRE_MAP[name] ?? []) out.add(c);
  }
  for (const name of themeNames) {
    for (const c of THEME_MAP[name] ?? []) out.add(c);
  }

  // TBS counts as RPG only when the game is also tagged RPG.
  if (
    genreNames.includes("Turn-based strategy (TBS)") &&
    genreNames.includes("Role-playing (RPG)")
  ) {
    out.add("RPG");
  }

  return [...out];
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(
      /\b(game of the year|goty|definitive|complete|remastered|remaster|enhanced|anniversary|deluxe|ultimate|special)\s*(edition)?\b/g,
      ""
    )
    .replace(/\bhd\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function transform(game: IgdbGame): CatalogGame | null {
  if (!game.first_release_date || game.aggregated_rating == null) return null;

  const platforms = collapsePlatforms((game.platforms ?? []).map((p) => p.name));
  const consoleFamilies = platforms.filter((p) => p !== "PC");
  const exclusive = consoleFamilies.length === 1 && !platforms.includes("PC");

  const genres = mapCategories(game);
  const eligible = new Set<Category>(genres);
  if (exclusive) eligible.add("Console Exclusive");
  eligible.add("Wild Card");

  return {
    id: String(game.id),
    title: game.name,
    year: new Date(game.first_release_date * 1000).getUTCFullYear(),
    score: Math.round(game.aggregated_rating),
    reviewCount: game.aggregated_rating_count ?? 0,
    coverUrl: game.cover
      ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`
      : "",
    platforms,
    genres,
    exclusive,
    eligibleCategories: [...eligible],
  };
}

function dedupe(games: CatalogGame[]): CatalogGame[] {
  const best = new Map<string, CatalogGame>();
  for (const g of games) {
    const key = normalizeTitle(g.title);
    const existing = best.get(key);
    // Keep the entry with the most reviews — the canonical release.
    if (!existing || g.reviewCount > existing.reviewCount) best.set(key, g);
  }
  return [...best.values()];
}

// ---------------------------------------------------------------- summary

function printSummary(games: CatalogGame[]) {
  console.log(`\n=== CATALOG SUMMARY ===\n`);
  console.log(`Total games retained: ${games.length}\n`);

  console.log("Per category (eligible):");
  for (const cat of CATEGORIES) {
    const n = games.filter((g) => g.eligibleCategories.includes(cat)).length;
    const warn = n < 80 ? "  <-- THIN" : "";
    console.log(`  ${cat.padEnd(20)} ${String(n).padStart(5)}${warn}`);
  }

  console.log("\nPer year:");
  const years = [...new Set(games.map((g) => g.year))].sort();
  for (const y of years) {
    const n = games.filter((g) => g.year === y).length;
    console.log(`  ${y}  ${"#".repeat(Math.ceil(n / 5))} ${n}`);
  }

  console.log("\nScore distribution:");
  for (let lo = 40; lo < 100; lo += 5) {
    const n = games.filter((g) => g.score >= lo && g.score < lo + 5).length;
    if (n > 0) console.log(`  ${lo}-${lo + 4}  ${String(n).padStart(5)}`);
  }

  console.log("\nTop 20 by score:");
  const top = [...games].sort((a, b) => b.score - a.score).slice(0, 20);
  for (const g of top) {
    console.log(
      `  ${String(g.score).padStart(3)}  ${g.title} (${g.year})  [${g.reviewCount} reviews]`
    );
  }

  const noCover = games.filter((g) => !g.coverUrl).length;
  if (noCover > 0) console.log(`\nWarning: ${noCover} games have no cover art.`);

  console.log(
    "\nIf you don't recognize most of the top 20, raise MIN_REVIEW_COUNT and re-run.\n"
  );
}

// ---------------------------------------------------------------- main

async function main() {
  const { id, secret } = loadEnv();

  console.log("Requesting Twitch token...");
  const token = await getToken(id, secret);

  console.log(`Fetching games (review floor: ${MIN_REVIEW_COUNT})...`);
  const raw = await fetchAll(id, token);

  console.log(`Transforming ${raw.length} entries...`);
  const transformed = raw
    .map(transform)
    .filter((g): g is CatalogGame => g !== null);

  const deduped = dedupe(transformed).sort((a, b) =>
    a.title.localeCompare(b.title)
  );

  const outPath = resolve(process.cwd(), OUT_PATH);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(deduped, null, 2));

  console.log(
    `\nWrote ${deduped.length} games to ${OUT_PATH} ` +
      `(${(JSON.stringify(deduped).length / 1024 / 1024).toFixed(1)} MB)`
  );

  printSummary(deduped);
}

main().catch((err) => {
  console.error("\nSeed failed:", err.message);
  process.exit(1);
});
