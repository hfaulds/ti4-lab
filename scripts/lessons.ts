/**
 * Keeps knowledge/lessons.jsonl, the lessons the agent learns from reviews
 * of its own games.
 *
 *   tsx scripts/lessons.ts list [draft|active|retired]
 *   tsx scripts/lessons.ts decision <game file> <move>
 *   tsx scripts/lessons.ts draft --text "..." --topics combat,expansion --source "review of ..."
 *                                [--why "..."] [--game <game file> --move <move>]
 *   tsx scripts/lessons.ts activate L3
 *   tsx scripts/lessons.ts retire L3 --because "..."
 *
 * Drafting from a review: read the reviewed decision with `decision`, then
 * add a draft that names the game and move. Models may draft; only a human
 * runs `activate`. Lessons are retired, never deleted.
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

function show(lesson: Lesson) {
  const from = lesson.game ? ` (${lesson.game} move ${lesson.move})` : "";
  console.log(`${lesson.id} [${lesson.status}] ${lesson.text}`);
  if (lesson.why) console.log(`   why: ${lesson.why}`);
  console.log(`   ${lesson.topics.join(", ")}; from ${lesson.source}${from}, added ${lesson.added}`);
  if (lesson.retiredBecause) console.log(`   retired ${lesson.retired}: ${lesson.retiredBecause}`);
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
  try {
    const added = addDraft(
      lessons,
      {
        text: option("text") ?? "",
        why: option("why"),
        topics: topics as Topic[],
        source: option("source") ?? "",
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
