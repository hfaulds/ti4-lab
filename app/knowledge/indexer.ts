/**
 * Builds the knowledge base's search index (knowledge/knowledge.db) from
 * assembled episodes and concepts, and the lessons from the agent's games.
 * Used by `tsx scripts/kb.ts index`, and by tests with made-up episodes.
 */
import type { Database } from "better-sqlite3";
import { factions } from "~/data/factionData";
import { Lesson, lessonsVersion } from "./lessons";
import { factionKeyOf } from "./search";
import { canonicalTerms, compileSynonyms, SynonymList } from "./synonyms";
import { Concept, EpisodeChunks } from "./types";

export const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE episodes (episode INTEGER PRIMARY KEY, title TEXT NOT NULL, faction_id TEXT NOT NULL,
    faction TEXT NOT NULL, faction_key TEXT NOT NULL);
  CREATE TABLE sections (id TEXT PRIMARY KEY, episode INTEGER NOT NULL, title TEXT NOT NULL,
    start REAL NOT NULL, end REAL NOT NULL, summary TEXT NOT NULL);
  CREATE TABLE chunks (id TEXT PRIMARY KEY, episode INTEGER NOT NULL, section TEXT NOT NULL,
    start REAL NOT NULL, end REAL NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
    advice TEXT NOT NULL, factions TEXT NOT NULL, phases TEXT NOT NULL, topics TEXT NOT NULL,
    requires TEXT NOT NULL, concepts TEXT NOT NULL, text TEXT NOT NULL,
    factions_key TEXT NOT NULL);
  CREATE VIRTUAL TABLE chunks_fts USING fts5(title, summary, advice, tags, text, tokenize = 'porter unicode61');
  CREATE TABLE concepts (name TEXT PRIMARY KEY, aliases TEXT NOT NULL, definition TEXT NOT NULL,
    explained INTEGER NOT NULL, chunks TEXT NOT NULL);
  CREATE VIRTUAL TABLE concepts_fts USING fts5(name, aliases, definition, tokenize = 'porter unicode61');
`;

/**
 * Lessons live apart from the guides, so they can be reloaded without
 * rebuilding the rest. Every lesson is stored; search shows only active ones.
 */
export const LESSONS_SCHEMA = `
  DROP TABLE IF EXISTS lessons;
  DROP TABLE IF EXISTS lessons_fts;
  CREATE TABLE lessons (id TEXT PRIMARY KEY, status TEXT NOT NULL, text TEXT NOT NULL,
    why TEXT NOT NULL, topics TEXT NOT NULL, data TEXT NOT NULL);
  CREATE VIRTUAL TABLE lessons_fts USING fts5(text, why, tags, tokenize = 'porter unicode61');
`;

/** Replaces the lessons in a built index, or one being built. */
export function loadLessons(db: Database, lessons: Lesson[], synonymList: SynonymList) {
  const synonyms = compileSynonyms(synonymList);
  db.transaction(() => {
    db.exec(LESSONS_SCHEMA);
    const insert = db.prepare("INSERT INTO lessons VALUES (?, ?, ?, ?, ?, ?)");
    const insertText = db.prepare("INSERT INTO lessons_fts (rowid, text, why, tags) VALUES (?, ?, ?, ?)");
    for (const lesson of lessons) {
      const why = lesson.why ?? "";
      const result = insert.run(
        lesson.id, lesson.status, lesson.text, why, JSON.stringify(lesson.topics), JSON.stringify(lesson),
      );
      const tags = [...lesson.topics, ...canonicalTerms(`${lesson.text} ${why}`, synonyms)].join(" ");
      insertText.run(result.lastInsertRowid, lesson.text, why, tags);
    }
    db.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)").run("lessonsVersion", lessonsVersion(lessons));
  })();
}

/** Fills an empty database; returns how many chunks were indexed. */
export function buildIndex(
  db: Database,
  episodes: EpisodeChunks[],
  conceptList: Concept[],
  synonymList: SynonymList,
  lessons: Lesson[] = [],
): number {
  db.exec(SCHEMA);
  const synonyms = compileSynonyms(synonymList);
  const insert = {
    episode: db.prepare("INSERT INTO episodes VALUES (?, ?, ?, ?, ?)"),
    section: db.prepare("INSERT INTO sections VALUES (?, ?, ?, ?, ?, ?)"),
    chunk: db.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    chunkText: db.prepare(
      "INSERT INTO chunks_fts (rowid, title, summary, advice, tags, text) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    concept: db.prepare("INSERT INTO concepts VALUES (?, ?, ?, ?, ?)"),
    conceptText: db.prepare(
      "INSERT INTO concepts_fts (rowid, name, aliases, definition) VALUES (?, ?, ?, ?)",
    ),
    meta: db.prepare("INSERT INTO meta VALUES (?, ?)"),
  };

  let indexed = 0;
  db.transaction(() => {
    for (const episode of episodes) {
      const faction = factions[episode.factionId as keyof typeof factions]?.name ?? episode.factionId;
      insert.episode.run(episode.episode, episode.title, episode.factionId, faction, factionKeyOf(faction));
      for (const section of episode.sections) {
        insert.section.run(section.id, episode.episode, section.title, section.start, section.end, section.summary);
      }
      // Banter carries no advice, so it is not searchable.
      for (const chunk of episode.chunks.filter((c) => c.kind === "strategy")) {
        const result = insert.chunk.run(
          chunk.id, chunk.episode, chunk.section, chunk.start, chunk.end, chunk.title, chunk.summary,
          JSON.stringify(chunk.advice), JSON.stringify(chunk.factions), JSON.stringify(chunk.phases),
          JSON.stringify(chunk.topics), JSON.stringify(chunk.requires), JSON.stringify(chunk.concepts),
          chunk.text,
          // "|a|b|", so a faction can be matched exactly with LIKE.
          `|${chunk.factions.map(factionKeyOf).join("|")}|`,
        );
        const advice = chunk.advice.map((a) => `${a.point} ${a.subjects.join(" ")}`).join("\n");
        const everything = [chunk.title, chunk.summary, advice, chunk.text].join(" ");
        const tags = [
          faction,
          ...chunk.factions,
          ...chunk.phases,
          ...chunk.topics,
          ...chunk.requires,
          ...chunk.concepts,
          ...canonicalTerms(everything, synonyms),
        ].join(" ");
        insert.chunkText.run(result.lastInsertRowid, chunk.title, chunk.summary, advice, tags, chunk.text);
        indexed++;
      }
    }
    for (const concept of conceptList) {
      const result = insert.concept.run(
        concept.name, JSON.stringify(concept.aliases), concept.definition,
        concept.explained ? 1 : 0, JSON.stringify(concept.chunks),
      );
      insert.conceptText.run(result.lastInsertRowid, concept.name, concept.aliases.join(" "), concept.definition);
    }
    insert.meta.run("builtAt", new Date().toISOString());
    insert.meta.run("chunkerVersions", JSON.stringify([...new Set(episodes.map((e) => e.chunkerVersion))]));
    insert.meta.run("synonymsVersion", String(synonymList.version));
  })();
  loadLessons(db, lessons, synonymList);
  return indexed;
}
