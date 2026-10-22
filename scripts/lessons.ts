/**
 * Keeps knowledge/lessons.jsonl, the lessons the agent learns from reviews
 * of its own games.
 *
 *   tsx scripts/lessons.ts list [draft|active|retired]
 *   tsx scripts/lessons.ts decision <game file> <move>
 *   tsx scripts/lessons.ts draft --text "..." --topics combat,expansion --source "review of ..."
 *                                [--why "..."] [--game <game file> --move <move>]
 *                                [--learned-with base|pok,codex1,...] [--needs te] [--voided-by te] [--scope-note "..."]
 *   tsx scripts/lessons.ts activate L3
 *   tsx scripts/lessons.ts retire L3 --because "..."
 *
 * Drafting from a review: read the reviewed decision with `decision`, then
 * add a draft that names the game and move. Models may draft; only a human
 * runs `activate`. Lessons are retired, never deleted.
 *
 * Every lesson records the content of the games it was learned from: read
 * from the game file when one is named, otherwise given with --learned-with.
 * A lesson about something an expansion or codex changes says so with
 * --needs or --voided-by, so games with other content are not shown it.
 *
 * The agent reads lessons from knowledge/knowledge.db, so run
 * `tsx scripts/kb.ts lessons` (or `index`) after a change.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  activateLesson,
  addDraft,
  decisionAt,
  Lesson,
  LESSON_STATUSES,
  LessonStatus,
  readLessons,
  retireLesson,
  writeLessons,
} from "~/knowledge/lessons";
import type { Expansion } from "~/game/data/types";
import { contentLabel, EXPANSION_NAMES, Scope, scopeLabel } from "~/knowledge/scope";
import { Topic, TOPICS } from "~/knowledge/types";

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const today = () => new Date().toISOString().slice(0, 10);
const reindex = "Run tsx scripts/kb.ts lessons to give the agent the change.";

/** A list of expansion ids, "base" for none; undefined when the option is not given. */
function expansionsOption(name: string): Expansion[] | undefined {
  const value = option(name);
  if (value === undefined) return undefined;
  const list = value.split(",").map((e) => e.trim()).filter((e) => e && e !== "base");
  const unknown = list.filter((e) => !(e in EXPANSION_NAMES));
  if (unknown.length > 0) fail(`--${name}: unknown ${unknown.join(", ")}; use base or ${Object.keys(EXPANSION_NAMES).join(", ")}.`);
  return list as Expansion[];
}

function show(lesson: Lesson) {
  const from = lesson.game ? ` (${lesson.game} move ${lesson.move})` : "";
  console.log(`${lesson.id} [${lesson.status}] ${lesson.text}`);
  if (lesson.why) console.log(`   why: ${lesson.why}`);
  console.log(`   ${lesson.topics.join(", ")}; from ${lesson.source}${from}, added ${lesson.added}`);
  console.log(`   learned with ${contentLabel(lesson.learnedWith)}${lesson.scope ? `; ${scopeLabel(lesson.scope)}` : ""}`);
  if (lesson.retiredBecause) console.log(`   retired ${lesson.retired}: ${lesson.retiredBecause}`);
}

/** The content a finished game's replay log was played with. */
function gameExpansions(file: string): Expansion[] | undefined {
  const log = JSON.parse(readFileSync(file, "utf8")) as { initialState?: { options?: { expansions?: Expansion[] } } };
  return log.initialState?.options?.expansions;
}

/** A replay log's decision, read for a lesson drafter. */
function readDecision(file: string, move: number) {
  if (!existsSync(file)) fail(`No game file ${file}.`);
  const decision = decisionAt(file, readFileSync(file, "utf8"), move);
  if (!decision) fail(`${file} has no agent decision at move ${move}.`);
  return decision;
}

const [command, argument] = process.argv.slice(2);
const lessons = readLessons();

if (command === "list") {
  if (argument && !LESSON_STATUSES.includes(argument as LessonStatus)) {
    fail(`Status must be one of ${LESSON_STATUSES.join(", ")}.`);
  }
  for (const lesson of lessons.filter((l) => !argument || l.status === argument)) show(lesson);
} else if (command === "decision") {
  const decision = readDecision(argument ?? "", Number(process.argv[4]));
  console.log(`Move ${decision.move}: P${decision.player}, round ${decision.round} ${decision.phase}.`);
  for (const entry of decision.menu) {
    console.log(`${entry.label === decision.chosen ? "*" : " "} ${entry.label}. ${entry.text}`);
  }
  console.log(`Rationale: ${decision.rationale}`);
} else if (command === "draft") {
  const topics = (option("topics") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const unknown = topics.filter((t) => !TOPICS.includes(t as Topic));
  if (unknown.length > 0) fail(`Unknown topics ${unknown.join(", ")}; use: ${TOPICS.join(", ")}.`);
  const game = option("game");
  const move = option("move") === undefined ? undefined : Number(option("move"));
  if (game && move === undefined) fail("Give the decision's --move with --game.");
  if (game) readDecision(game, move!);
  // A game file records its own content; without one, it must be given.
  const logged = game && !game.endsWith(".jsonl") ? gameExpansions(game) : undefined;
  const learnedWith = expansionsOption("learned-with") ?? logged;
  if (!learnedWith) fail("Give --learned-with (base, or e.g. pok,codex1): the content of the games it was learned from.");
  if (logged && option("learned-with") !== undefined && logged.join() !== learnedWith.join()) {
    fail(`${game} was played with ${contentLabel(logged)}, not ${contentLabel(learnedWith)}.`);
  }
  const needs = expansionsOption("needs") ?? [];
  const voidedBy = expansionsOption("voided-by") ?? [];
  const scope: Scope | undefined =
    needs.length > 0 || voidedBy.length > 0
      ? { needs, voidedBy, ...(option("scope-note") ? { note: option("scope-note") } : {}) }
      : undefined;
  try {
    const added = addDraft(
      lessons,
      {
        text: option("text") ?? "",
        why: option("why"),
        topics: topics as Topic[],
        source: option("source") ?? "",
        learnedWith,
        scope,
        // Replay logs live in games/, so the file name is enough to find one.
        game: game && basename(game),
        move,
      },
      today(),
    );
    writeLessons(added.lessons);
    show(added.lesson);
    console.log("Drafted. A human activates it with: tsx scripts/lessons.ts activate " + added.lesson.id);
  } catch (error) {
    fail(String(error instanceof Error ? error.message : error));
  }
} else if (command === "activate" || command === "retire") {
  try {
    const changed =
      command === "activate"
        ? activateLesson(lessons, argument ?? "", today())
        : retireLesson(lessons, argument ?? "", option("because") ?? "", today());
    writeLessons(changed);
    show(changed.find((l) => l.id.toLowerCase() === argument!.toLowerCase())!);
    console.log(reindex);
  } catch (error) {
    fail(String(error instanceof Error ? error.message : error));
  }
} else {
  fail("Usage: tsx scripts/lessons.ts list [status] | decision <game> <move> | draft ... | activate <id> | retire <id> --because ...");
}
