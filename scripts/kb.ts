/**
 * The mechanical half of building the knowledge base. Claude Code agents do
 * the reading and writing; these commands prepare their input and check and
 * assemble what they write.
 *
 *   tsx scripts/kb.ts prepare            sentences for each corrected transcript
 *   tsx scripts/kb.ts assemble [NNN]     check drafts, write knowledge/chunks/
 *   tsx scripts/kb.ts mentions           concept names across all chunks
 *   tsx scripts/kb.ts concepts           check the concepts draft, write concepts.json
 *
 * Files:
 *   knowledge/work/scpt-NNN.sentences.txt   "s412 [0:43:02] text", for agents to read
 *   knowledge/work/scpt-NNN.sentences.json  the same with exact times
 *   knowledge/drafts/scpt-NNN.json          an agent's EpisodeDraft
 *   knowledge/drafts/concepts.json          an agent's ConceptDraft[]
 *   knowledge/chunks/scpt-NNN.json          assembled EpisodeChunks
 *   knowledge/chunks/concepts.json          assembled Concept[]
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  Chunk,
  ChunkDraft,
  Concept,
  ConceptDraft,
  EpisodeChunks,
  EpisodeDraft,
  PHASES,
  Section,
  STANCES,
  TOPICS,
  MECHANICS,
} from "~/knowledge/types";
import type { CorrectedTranscript } from "./correct-transcripts";

/** Bumped whenever the drafting instructions or the checks change. */
const CHUNKER_VERSION = 1;
const MODEL = "claude (Claude Code agent)";

type Sentence = { start: number; end: number; text: string };

const pad = (episode: number | string) => String(episode).padStart(3, "0");
const clock = (seconds: number) => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** Groups words into sentences, splitting run-ons so none is too long. */
export function sentences(transcript: CorrectedTranscript): Sentence[] {
  const out: Sentence[] = [];
  let words: CorrectedTranscript["words"] = [];
  const flush = () => {
    if (words.length === 0) return;
    out.push({
      start: words[0][0],
      end: words[words.length - 1][1],
      text: words.map((w) => w[2]).join(" "),
    });
    words = [];
  };
  for (const word of transcript.words) {
    words.push(word);
    const ends = /[.!?]["')]?$/.test(word[2]);
    if ((ends && words.length >= 6) || words.length >= 45) flush();
  }
  flush();
  return out;
}

const readCorrected = (name: string) =>
  JSON.parse(gunzipSync(readFileSync(`knowledge/corrected/${name}.json.gz`)).toString()) as CorrectedTranscript;

function prepare() {
  mkdirSync("knowledge/work", { recursive: true });
  for (const file of readdirSync("knowledge/corrected").filter((f) => f.endsWith(".json.gz")).sort()) {
    const name = file.replace(".json.gz", "");
    const transcript = readCorrected(name);
    const list = sentences(transcript);
    writeFileSync(`knowledge/work/${name}.sentences.json`, JSON.stringify(list));
    writeFileSync(
      `knowledge/work/${name}.sentences.txt`,
      `${transcript.title} (${Math.round(transcript.durationSeconds / 60)} minutes, ${list.length} sentences)\n\n` +
        list.map((s, i) => `s${i} [${clock(s.start)}] ${s.text}`).join("\n") + "\n",
    );
    console.log(`${name}: ${list.length} sentences`);
  }
}

// --- Checking drafts --------------------------------------------------------------

const isStringList = (value: unknown) =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/** Problems with a chunk draft's fields, as readable messages. */
function chunkProblems(chunk: ChunkDraft, where: string): string[] {
  const problems: string[] = [];
  const oneOf = (field: string, values: unknown, allowed: readonly string[]) => {
    if (!isStringList(values)) problems.push(`${where}: ${field} must be a list of strings.`);
    else {
      for (const v of values as string[]) {
        if (!allowed.includes(v)) problems.push(`${where}: ${field} "${v}" is not one of ${allowed.join(", ")}.`);
      }
    }
  };
  if (typeof chunk.title !== "string" || !chunk.title) problems.push(`${where}: title is required.`);
  if (chunk.kind !== "strategy" && chunk.kind !== "banter") problems.push(`${where}: kind must be "strategy" or "banter".`);
  if (typeof chunk.summary !== "string") problems.push(`${where}: summary must be a string.`);
  if (chunk.kind === "strategy" && !chunk.summary) problems.push(`${where}: a strategy chunk needs a summary.`);
  if (!Array.isArray(chunk.advice)) problems.push(`${where}: advice must be a list.`);
  for (const [i, a] of (chunk.advice ?? []).entries()) {
    if (typeof a?.point !== "string" || !a.point) problems.push(`${where}: advice ${i} needs a point.`);
    if (!STANCES.includes(a?.stance)) problems.push(`${where}: advice ${i} stance "${a?.stance}" is not one of ${STANCES.join(", ")}.`);
    if (!isStringList(a?.subjects)) problems.push(`${where}: advice ${i} subjects must be a list of strings.`);
  }
  if (!isStringList(chunk.factions)) problems.push(`${where}: factions must be a list of strings.`);
  oneOf("phases", chunk.phases, PHASES);
  oneOf("topics", chunk.topics, TOPICS);
  oneOf("requires", chunk.requires, MECHANICS);
  if (!isStringList(chunk.concepts)) problems.push(`${where}: concepts must be a list of strings.`);
  return problems;
}

/** Turns a checked draft into chunks with ids, times and text. */
function assembleEpisode(name: string): EpisodeChunks {
  const draft = JSON.parse(readFileSync(`knowledge/drafts/${name}.json`, "utf8")) as EpisodeDraft;
  const transcript = readCorrected(name);
  const list = JSON.parse(readFileSync(`knowledge/work/${name}.sentences.json`, "utf8")) as Sentence[];
  const problems: string[] = [];
  if (draft.episode !== transcript.episode) {
    problems.push(`episode is ${draft.episode}, but the transcript is episode ${transcript.episode}.`);
  }

  // Chunk starts must run from the first sentence, strictly in order.
  const flat = draft.sections.flatMap((section, s) =>
    section.chunks.map((chunk, c) => ({ chunk, s, where: `section ${s + 1} "${section.title}", chunk ${c + 1}` })),
  );
  let previous = -1;
  for (const { chunk, where } of flat) {
    problems.push(...chunkProblems(chunk, where));
    const start = /^s(\d+)$/.exec(String(chunk.start));
    if (!start) {
      problems.push(`${where}: start must be a sentence id like "s412".`);
      continue;
    }
    const index = Number(start[1]);
    if (previous === -1 && index !== 0) problems.push(`${where}: the first chunk must start at s0.`);
    if (index <= previous) problems.push(`${where}: starts at s${index}, not after the previous chunk (s${previous}).`);
    if (index >= list.length) problems.push(`${where}: s${index} is past the last sentence (s${list.length - 1}).`);
    previous = index;
  }
  if (problems.length > 0) {
    throw new Error(`${name} draft has problems:\n- ${problems.join("\n- ")}`);
  }

  const prefix = pad(transcript.episode);
  const chunks: Chunk[] = flat.map(({ chunk, s }, i) => {
    const from = Number(chunk.start.slice(1));
    const to = (flat[i + 1] ? Number(flat[i + 1].chunk.start.slice(1)) : list.length) - 1;
    const span = list.slice(from, to + 1);
    return {
      id: `${prefix}-${String(i + 1).padStart(2, "0")}`,
      episode: transcript.episode,
      section: `${prefix}-s${s + 1}`,
      start: span[0].start,
      end: span[span.length - 1].end,
      title: chunk.title,
      kind: chunk.kind,
      summary: chunk.summary,
      advice: chunk.advice,
      factions: chunk.factions,
      phases: chunk.phases,
      topics: chunk.topics,
      requires: chunk.requires,
      concepts: chunk.concepts,
      text: span.map((x) => x.text).join(" "),
    };
  });
  const sections: Section[] = draft.sections.map((section, s) => {
    const id = `${prefix}-s${s + 1}`;
    const members = chunks.filter((c) => c.section === id);
    return {
      id,
      title: section.title,
      start: members[0].start,
      end: members[members.length - 1].end,
      summary: section.summary ?? "",
      chunks: members.map((c) => c.id),
    };
  });
  return {
    episode: transcript.episode,
    title: transcript.title,
    factionId: transcript.factionId,
    glossaryVersion: transcript.glossaryVersion,
    chunkerVersion: CHUNKER_VERSION,
    model: MODEL,
    builtAt: new Date().toISOString(),
    sections,
    chunks,
    nameFixes: draft.nameFixes ?? {},
  };
}

function assemble(only?: string) {
  mkdirSync("knowledge/chunks", { recursive: true });
  const drafts = readdirSync("knowledge/drafts")
    .filter((f) => /^scpt-\d+\.json$/.test(f))
    .filter((f) => !only || f === `scpt-${pad(only)}.json`)
    .sort();
  let failed = false;
  for (const file of drafts) {
    const name = file.replace(".json", "");
    try {
      const episode = assembleEpisode(name);
      writeFileSync(`knowledge/chunks/${file}`, JSON.stringify(episode, null, 2));
      const strategy = episode.chunks.filter((c) => c.kind === "strategy");
      const minutes = episode.chunks.map((c) => (c.end - c.start) / 60).sort((a, b) => a - b);
      console.log(
        `${name}: ${episode.sections.length} sections, ${episode.chunks.length} chunks ` +
          `(${strategy.length} with advice, ${strategy.filter((c) => c.requires.length === 0).length} using only the core rules); ` +
          `median ${minutes[Math.floor(minutes.length / 2)].toFixed(1)} min, longest ${minutes[minutes.length - 1].toFixed(1)} min`,
      );
    } catch (error) {
      failed = true;
      console.error(error instanceof Error ? error.message : error);
    }
  }
  if (failed) process.exit(1);
}

// --- Concepts -------------------------------------------------------------------------

const readEpisodes = () =>
  readdirSync("knowledge/chunks")
    .filter((f) => /^scpt-\d+\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(`knowledge/chunks/${f}`, "utf8")) as EpisodeChunks);

/** Up to `limit` items, taken evenly through the list so all episodes show. */
function spread<T>(items: T[], limit: number): T[] {
  const step = items.length / limit;
  return Array.from({ length: limit }, (_, i) => items[Math.floor(i * step)]);
}

/** Every concept name chunks used, with the chunks that used it. */
function mentions() {
  const byName = new Map<string, Chunk[]>();
  for (const chunk of readEpisodes().flatMap((e) => e.chunks)) {
    for (const name of chunk.concepts) byName.set(name, [...(byName.get(name) ?? []), chunk]);
  }
  const sorted = [...byName].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  /** Every mention, or at most `limit` per concept spread across episodes. */
  const render = (limit = Infinity) =>
    sorted
      .flatMap(([name, chunks]) => {
        const shown = limit < chunks.length ? spread(chunks, limit) : chunks;
        return [
          `## ${name} (${chunks.length} chunks${shown.length < chunks.length ? `, ${shown.length} shown` : ""})`,
          ...shown.map((c) => `- [${c.id}] ${c.title}: ${c.summary}`),
          "",
        ];
      })
      .join("\n");
  mkdirSync("knowledge/work", { recursive: true });
  writeFileSync("knowledge/work/concept-mentions.md", render());
  writeFileSync("knowledge/work/concept-mentions-brief.md", render(10));
  console.log(
    `${byName.size} concept names; written to knowledge/work/concept-mentions.md ` +
      "(and concept-mentions-brief.md, at most 10 per concept)",
  );
}

function concepts() {
  const drafts = JSON.parse(readFileSync("knowledge/drafts/concepts.json", "utf8")) as ConceptDraft[];
  const byName = new Map<string, string[]>();
  for (const chunk of readEpisodes().flatMap((e) => e.chunks)) {
    for (const name of chunk.concepts) byName.set(name, [...(byName.get(name) ?? []), chunk.id]);
  }
  const problems: string[] = [];
  const claimed = new Map<string, string>();
  const out: Concept[] = drafts.map((draft) => {
    if (!draft.name || !draft.definition) problems.push(`"${draft.name}": name and definition are required.`);
    const chunks = new Set<string>();
    for (const name of draft.covers ?? []) {
      if (!byName.has(name)) problems.push(`"${draft.name}" covers "${name}", which no chunk uses.`);
      if (claimed.has(name)) problems.push(`"${name}" is covered by both "${claimed.get(name)}" and "${draft.name}".`);
      claimed.set(name, draft.name);
      for (const id of byName.get(name) ?? []) chunks.add(id);
    }
    return {
      name: draft.name,
      aliases: draft.aliases ?? [],
      definition: draft.definition,
      explained: draft.explained === true,
      chunks: [...chunks].sort(),
    };
  });
  if (problems.length > 0) {
    console.error(`concepts draft has problems:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  writeFileSync("knowledge/chunks/concepts.json", JSON.stringify(out, null, 2));
  const unexplained = out.filter((c) => !c.explained).length;
  console.log(`${out.length} concepts (${unexplained} never explained in the episodes).`);
}

// --- Main -----------------------------------------------------------------------------

if (process.argv[1]?.endsWith("kb.ts")) {
  const [command, argument] = process.argv.slice(2);
  if (command === "prepare") prepare();
  else if (command === "assemble") assemble(argument);
  else if (command === "mentions") mentions();
  else if (command === "concepts") concepts();
  else {
    console.error("Usage: tsx scripts/kb.ts prepare | assemble [episode] | mentions | concepts");
    process.exit(1);
  }
}
