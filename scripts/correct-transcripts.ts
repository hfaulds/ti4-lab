/**
 * Applies knowledge/glossary.json to the raw transcripts, fixing game names
 * the transcription mishears, and writes knowledge/corrected/scpt-NNN.json.gz.
 * Raw transcripts are never changed, so a glossary fix only re-runs this.
 *
 *   tsx scripts/correct-transcripts.ts
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Transcript } from "./transcribe";

type Alias = { from: string; to: string; after?: string };
type Glossary = { version: number; aliases: Alias[] };

export type CorrectedTranscript = Transcript & {
  glossaryVersion: number;
  /** How often each alias was applied, keyed "from -> to". */
  corrections: Record<string, number>;
};

/** Punctuation a word may carry that is not part of the name. */
const TRAILING = /[.,!?;:"')\]]+$/;
const LEADING = /^["'([]+/;

const split = (word: string) => {
  const lead = word.match(LEADING)?.[0] ?? "";
  const trail = word.slice(lead.length).match(TRAILING)?.[0] ?? "";
  return { lead, core: word.slice(lead.length, word.length - trail.length), trail };
};

/** Applies every alias, longest first, left to right. */
export function correct(words: Transcript["words"], aliases: Alias[]) {
  const ordered = aliases
    .map((alias) => ({ ...alias, tokens: alias.from.split(" ") }))
    .sort((a, b) => b.tokens.length - a.tokens.length);
  const out: Transcript["words"] = [];
  const counts: Record<string, number> = {};

  for (let i = 0; i < words.length; ) {
    const match = ordered.find((alias) => {
      if (i + alias.tokens.length > words.length) return false;
      // A name broken by punctuation (a sentence end) is not one name.
      for (let k = 0; k < alias.tokens.length; k++) {
        const { core, trail } = split(words[i + k][2]);
        if (core !== alias.tokens[k]) return false;
        if (trail && k < alias.tokens.length - 1) return false;
      }
      if (alias.after) {
        const previous = out[out.length - 1];
        if (!previous || split(previous[2]).core !== alias.after) return false;
      }
      return true;
    });
    if (!match) {
      out.push(words[i]);
      i++;
      continue;
    }
    const span = words.slice(i, i + match.tokens.length);
    const { lead } = split(span[0][2]);
    const { trail } = split(span[span.length - 1][2]);
    out.push([
      span[0][0],
      span[span.length - 1][1],
      `${lead}${match.to}${trail}`,
      Math.min(...span.map((w) => w[3])),
    ]);
    const key = `${match.from} -> ${match.to}`;
    counts[key] = (counts[key] ?? 0) + 1;
    i += match.tokens.length;
  }
  return { words: out, counts };
}

// Run only as a script, so the matcher can be imported by tests.
if (process.argv[1]?.endsWith("correct-transcripts.ts")) {
  const glossary = JSON.parse(readFileSync("knowledge/glossary.json", "utf8")) as Glossary;
  mkdirSync("knowledge/corrected", { recursive: true });
  const totals: Record<string, number> = {};
  for (const file of readdirSync("knowledge/transcripts").filter((f) => f.endsWith(".json.gz")).sort()) {
    const raw = JSON.parse(gunzipSync(readFileSync(`knowledge/transcripts/${file}`)).toString()) as Transcript;
    const { words, counts } = correct(raw.words, glossary.aliases);
    const corrected: CorrectedTranscript = {
      ...raw,
      text: words.map((w) => w[2]).join(" "),
      words,
      glossaryVersion: glossary.version,
      corrections: counts,
    };
    writeFileSync(`knowledge/corrected/${file}`, gzipSync(JSON.stringify(corrected)));
    const applied = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`${file}: ${applied} corrections`);
    for (const [key, n] of Object.entries(counts)) totals[key] = (totals[key] ?? 0) + n;
  }
  console.log("\nAll episodes:");
  for (const [key, n] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    console.log(`${String(n).padStart(5)}  ${key}`);
  }
}
