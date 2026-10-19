/**
 * Search over the knowledge base in knowledge/knowledge.db, built by
 * `tsx scripts/kb.ts index`. Chunks are ranked by SQLite full-text search,
 * weighting titles, summaries and advice above the raw transcript, with
 * game shorthand expanded on both sides.
 */
import Database from "better-sqlite3";
import { factions } from "~/data/factionData";
import { Advice, Concept, Mechanic } from "./types";
import { compileSynonyms, SynonymList } from "./synonyms";

/** Relative weight of each indexed field: title, summary, advice, tags, text. */
export const FIELD_WEIGHTS = [5, 3, 3, 2, 1] as const;

export type GuideHit = {
  id: string;
  episode: number;
  episodeTitle: string;
  /** Seconds into the episode. */
  start: number;
  title: string;
  summary: string;
  advice: Advice[];
  factions: string[];
  requires: Mechanic[];
  section: { title: string; summary: string };
};

export type ConceptHit = Pick<Concept, "name" | "aliases" | "definition" | "explained">;

/** Common words that would only add noise to a full-text query. */
const STOPWORDS = new Set(
  "a an and are as at be but by do does for from how i if in into is it its of on or should so than that the their them then there these this to was we what when where which who why will with you your".split(
    " ",
  ),
);

type Compiled = ReturnType<typeof compileSynonyms>;

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/'s\b/g, "")
    .split(/[^a-z0-9-]+/)
    .filter(Boolean);

/** A term as FTS5 needs it: hyphenated words become phrases ("x-1" is "x 1"). */
const term = (word: string) => `"${word.replace(/-/g, " ").trim()}"`;

const meaningful = (word: string) =>
  !STOPWORDS.has(word) && (word.length > 1 || /\d/.test(word));

/**
 * Two full-text queries for free text. `all` requires every meaningful
 * word, with shorthand and its canonical term as alternatives ("diplo" or
 * "diplomacy"); `any` accepts any of them, to fill out results when `all`
 * finds too few. Both are undefined if the text has nothing to search for.
 */
export function ftsQueries(text: string, synonyms: Compiled) {
  const groups: string[][] = [];
  let rest = text;
  for (const { pattern, means } of synonyms) {
    pattern.lastIndex = 0;
    const match = rest.match(pattern);
    if (!match) continue;
    // The shorthand and its meaning are one requirement.
    const shorthand = words(match[0]).filter(meaningful);
    const canonical = words(means).filter(meaningful);
    groups.push([...new Set([...shorthand, ...canonical].map(term))]);
    rest = rest.replace(pattern, " ");
  }
  for (const word of new Set(words(rest).filter(meaningful))) groups.push([term(word)]);
  if (groups.length === 0) return undefined;
  const group = (g: string[]) => (g.length > 1 ? `(${g.join(" OR ")})` : g[0]);
  return {
    all: groups.map(group).join(" AND "),
    any: [...new Set(groups.flat())].join(" OR "),
    /** Each requirement's alternatives, unquoted, for re-ranking. */
    groups: groups.map((g) => g.map((t) => t.slice(1, -1))),
  };
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The key a faction is stored under: its normalised name, found from an id,
 * a full name or a short one ("hacan", "Emirates of Hacan", "Hacan").
 */
export function factionKeyOf(faction: string) {
  const wanted = normalise(faction);
  const match = Object.entries(factions).find(
    ([id, data]) =>
      normalise(id) === wanted ||
      normalise(data.name) === wanted ||
      normalise(data.name).endsWith(wanted),
  );
  return match ? normalise(match[1].name) : wanted;
}

/**
 * Moves rows whose titles name more of the query's requirements ahead,
 * keeping the faction's own guide first and full-text order otherwise.
 */
function reRank<T extends Record<string, string | number>>(
  rows: T[],
  groups: string[][],
  factionKey: string | null,
) {
  const titleMatches = (row: T) => {
    const title = ` ${words(String(row.title)).join(" ")} `;
    return groups.filter((g) => g.some((t) => title.includes(` ${t} `))).length;
  };
  return rows
    .map((row, order) => ({
      row,
      order,
      own: factionKey !== null && row.faction_key === factionKey ? 1 : 0,
      title: titleMatches(row),
    }))
    .sort((a, b) => b.own - a.own || b.title - a.title || a.order - b.order)
    .map((x) => x.row);
}

export type KnowledgeBase = {
  /** Identifies the index build, for agent versions in replay logs. */
  version: string;
  searchGuides(options: { query: string; faction?: string; limit?: number }): GuideHit[];
  searchConcepts(query: string, limit?: number): ConceptHit[];
  close(): void;
};

/** Opens the index at a path, or uses an open database (e.g. in tests). */
export function openKnowledgeBase(
  source: string | Database.Database,
  synonymList: SynonymList,
): KnowledgeBase {
  const db =
    typeof source === "string"
      ? new Database(source, { readonly: true, fileMustExist: true })
      : source;
  const synonyms = compileSynonyms(synonymList);
  const weights = FIELD_WEIGHTS.join(", ");

  const chunkQuery = db.prepare(`
    SELECT c.*, e.title AS episode_title, e.faction_key, s.title AS section_title, s.summary AS section_summary
    FROM chunks_fts f
    JOIN chunks c ON c.rowid = f.rowid
    JOIN episodes e ON e.episode = c.episode
    JOIN sections s ON s.id = c.section
    WHERE chunks_fts MATCH @match
      AND (@faction IS NULL OR e.faction_key = @faction OR c.factions_key LIKE '%|' || @faction || '|%')
    -- The faction's own guide first, then by relevance.
    ORDER BY (@faction IS NOT NULL AND e.faction_key = @faction) DESC, bm25(chunks_fts, ${weights})
    LIMIT @limit`);
  const conceptQuery = db.prepare(`
    SELECT c.* FROM concepts_fts f JOIN concepts c ON c.rowid = f.rowid
    WHERE concepts_fts MATCH ? ORDER BY bm25(concepts_fts, 5, 3, 1) LIMIT ?`);
  const allConcepts = db.prepare("SELECT * FROM concepts").all() as Record<string, string | number>[];

  type Row = Record<string, string | number>;
  const toHit = (row: Row): GuideHit => ({
    id: String(row.id),
    episode: Number(row.episode),
    episodeTitle: String(row.episode_title),
    start: Number(row.start),
    title: String(row.title),
    summary: String(row.summary),
    advice: JSON.parse(String(row.advice)) as Advice[],
    factions: JSON.parse(String(row.factions)) as string[],
    requires: JSON.parse(String(row.requires)) as Mechanic[],
    section: { title: String(row.section_title), summary: String(row.section_summary) },
  });
  const toConcept = (row: Row): ConceptHit => ({
    name: String(row.name),
    aliases: JSON.parse(String(row.aliases)) as string[],
    definition: String(row.definition),
    explained: row.explained === 1,
  });

  const meta = Object.fromEntries(
    (db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map(
      (row) => [row.key, row.value],
    ),
  );

  return {
    version: `${meta.builtAt ?? "unknown"} synonyms ${meta.synonymsVersion ?? "?"}`,
    searchGuides({ query, faction, limit = 5 }) {
      const queries = ftsQueries(query, synonyms);
      if (!queries) return [];
      const factionKey = faction ? factionKeyOf(faction) : null;
      const hits: Row[] = [];
      const seen = new Set<string>();
      for (const match of [queries.all, queries.any]) {
        // A few spare rows, so re-ranking by title has something to choose from.
        const rows = chunkQuery.all({ match, faction: factionKey, limit: limit * 3 }) as Row[];
        for (const row of reRank(rows, queries.groups, factionKey)) {
          if (seen.has(String(row.id)) || hits.length >= limit) continue;
          seen.add(String(row.id));
          hits.push(row);
        }
        if (hits.length >= limit) break;
      }
      return hits.map(toHit);
    },
    searchConcepts(query, limit = 3) {
      // A concept named outright comes first.
      const named = normalise(query);
      const exact = allConcepts.filter((row) =>
        [String(row.name), ...(JSON.parse(String(row.aliases)) as string[])].some(
          (name) => normalise(name) === named,
        ),
      );
      const queries = ftsQueries(query, synonyms);
      const ranked = queries ? (conceptQuery.all(queries.any, limit) as Row[]) : [];
      const rows = [...exact, ...ranked.filter((r) => !exact.some((e) => e.name === r.name))];
      return rows.slice(0, limit).map(toConcept);
    },
    close: () => db.close(),
  };
}
