import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { buildIndex } from "./indexer";
import { openKnowledgeBase } from "./search";
import { compileSynonyms, SynonymList } from "./synonyms";
import { ftsQueries } from "./search";
import { Chunk, Concept, EpisodeChunks } from "./types";

const synonyms = JSON.parse(readFileSync("knowledge/synonyms.json", "utf8")) as SynonymList;

const chunk = (id: string, episode: number, fields: Partial<Chunk>): Chunk => ({
  id,
  episode,
  section: `${episode}-s1`,
  start: 60,
  end: 120,
  title: "",
  kind: "strategy",
  summary: "",
  advice: [],
  factions: [],
  phases: ["round 1"],
  topics: ["strategy cards"],
  requires: [],
  concepts: [],
  text: "",
  ...fields,
});

const episode = (number: number, factionId: string, chunks: Chunk[]): EpisodeChunks => ({
  episode: number,
  title: `Ep ${number}`,
  factionId,
  glossaryVersion: 2,
  chunkerVersion: 1,
  model: "test",
  builtAt: "",
  sections: [{ id: `${number}-s1`, title: "Round one", start: 0, end: 600, summary: "Round one picks.", chunks: chunks.map((c) => c.id) }],
  chunks,
  nameFixes: {},
});

const concepts: Concept[] = [
  { name: "X-1 trade", aliases: ["X minus one"], definition: "Trading X commodities for X-1 trade goods.", explained: false, chunks: [] },
  { name: "trade ship", aliases: [], definition: "A ship parked to trade with a neighbour.", explained: true, chunks: [] },
];

function knowledgeBase() {
  const db = new Database(":memory:");
  buildIndex(
    db,
    [
      episode(118, "hacan", [
        chunk("118-01", 118, { title: "Round one: Diplomacy", summary: "Diplomacy is bad for Hacan round one.", factions: ["Emirates of Hacan"] }),
        chunk("118-02", 118, { title: "Round one: Construction", summary: "Construction is good; Diplo is not.", factions: ["Emirates of Hacan"] }),
        chunk("118-03", 118, { title: "Intro", kind: "banter", text: "Diplo diplomacy round one" }),
      ]),
      episode(132, "xxcha", [
        chunk("132-01", 132, { title: "Round one: Diplomacy", summary: "Diplomacy is the Xxcha pick round one.", factions: ["Xxcha Kingdom", "Emirates of Hacan"] }),
      ]),
    ],
    concepts,
    synonyms,
  );
  return openKnowledgeBase(db, synonyms);
}

describe("knowledge base search", () => {
  test("shorthand finds chunks written with the full name", () => {
    const hits = knowledgeBase().searchGuides({ query: "Diplo round one" });
    expect(hits.map((h) => h.id)).toContain("132-01");
    expect(hits[0].title).toBe("Round one: Diplomacy");
  });

  test("a faction's own guide comes first, and banter is never returned", () => {
    const hits = knowledgeBase().searchGuides({ query: "Diplo round one", faction: "hacan" });
    expect(hits.map((h) => h.id)).toEqual(["118-01", "118-02", "132-01"]);
    expect(hits[0].section).toEqual({ title: "Round one", summary: "Round one picks." });
  });

  test("a concept named outright comes first", () => {
    const kb = knowledgeBase();
    expect(kb.searchConcepts("X-1 trade")[0].name).toBe("X-1 trade");
    expect(kb.searchConcepts("x minus one")[0].name).toBe("X-1 trade");
  });

  test("queries keep hyphenated terms and treat shorthand as alternatives", () => {
    const queries = ftsQueries("Diplo or X-1?", compileSynonyms(synonyms))!;
    expect(queries.all).toBe('("diplo" OR "diplomacy") AND "x 1"');
    expect(ftsQueries("the and of", compileSynonyms(synonyms))).toBe(undefined);
  });
});
