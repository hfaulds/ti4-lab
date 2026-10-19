/**
 * Transcribes the SCPT Strategy Guide episodes in knowledge/manifest.json
 * with Parakeet TDT 0.6B v2 through FluidAudio's command-line tool, keeping
 * word-level timings. Writes knowledge/transcripts/scpt-NNN.json.gz.
 *
 *   tsx scripts/transcribe.ts --cli <path to fluidaudiocli> [--episode 97] [--force]
 *
 * The CLI can also come from FLUIDAUDIO_CLI. Build it from
 * https://github.com/FluidInference/FluidAudio with
 *   swift build -c release --product fluidaudiocli
 * (with only the Command Line Tools installed, add
 *   -Xcxx -isystem -Xcxx "$(xcrun --show-sdk-path)/usr/include/c++/v1").
 *
 * No vocabulary boosting: in tests it replaced ordinary words with game
 * names ("start" became "Saar"). Names are fixed in a later text pass.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const MODEL = "v2";

type ManifestEpisode = {
  episode: number;
  title: string;
  factionId: string;
  durationSeconds: number;
  audio: string;
};

type CliOutput = {
  text: string;
  durationSeconds: number;
  processingTimeSeconds: number;
  confidence: number;
  wordTimings: { word: string; startTime: number; endTime: number; confidence: number }[];
};

export type Transcript = {
  episode: number;
  title: string;
  factionId: string;
  model: string;
  transcribedAt: string;
  durationSeconds: number;
  confidence: number;
  text: string;
  /** [start seconds, end seconds, word, confidence], in order. */
  words: [number, number, string, number][];
};

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const cli = option("cli") ?? process.env.FLUIDAUDIO_CLI;
if (!cli || !existsSync(cli)) {
  console.error("Pass --cli <path to fluidaudiocli> or set FLUIDAUDIO_CLI.");
  process.exit(1);
}
const only = option("episode");
const force = process.argv.includes("--force");

const manifest = JSON.parse(readFileSync("knowledge/manifest.json", "utf8")) as {
  episodes: ManifestEpisode[];
};
const episodes = manifest.episodes.filter((e) => !only || e.episode === Number(only));
mkdirSync("knowledge/transcripts", { recursive: true });

const round = (n: number, places: number) => Number(n.toFixed(places));

for (const episode of episodes) {
  const name = `scpt-${String(episode.episode).padStart(3, "0")}`;
  const out = `knowledge/transcripts/${name}.json.gz`;
  if (existsSync(out) && !force) {
    console.log(`${name}: already transcribed`);
    continue;
  }
  const work = mkdtempSync(join(tmpdir(), "scpt-asr-"));
  try {
    const started = Date.now();
    const wav = join(work, `${name}.wav`);
    const json = join(work, `${name}.json`);
    // 16 kHz mono 16-bit, the input Parakeet expects.
    execFileSync("ffmpeg", [
      "-loglevel", "error", "-y",
      "-i", join("knowledge", episode.audio),
      "-ac", "1", "-ar", "16000", "-sample_fmt", "s16",
      wav,
    ]);
    execFileSync(cli, [
      "transcribe", wav,
      "--model-version", MODEL,
      "--word-timestamps",
      "--output-json", json,
    ], { stdio: ["ignore", "ignore", "pipe"], maxBuffer: 64 * 1024 * 1024 });

    const result = JSON.parse(readFileSync(json, "utf8")) as CliOutput;
    const transcript: Transcript = {
      episode: episode.episode,
      title: episode.title,
      factionId: episode.factionId,
      model: `parakeet-tdt-0.6b-${MODEL} (FluidAudio)`,
      transcribedAt: new Date().toISOString(),
      durationSeconds: result.durationSeconds,
      confidence: round(result.confidence, 4),
      text: result.text,
      words: result.wordTimings.map((w) => [
        round(w.startTime, 2),
        round(w.endTime, 2),
        w.word,
        round(w.confidence, 3),
      ]),
    };
    writeFileSync(out, gzipSync(JSON.stringify(transcript)));
    console.log(
      `${name}: ${transcript.words.length} words, ${Math.round(result.durationSeconds / 60)} min of audio, ` +
        `confidence ${transcript.confidence}, ${Math.round((Date.now() - started) / 1000)} s`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
