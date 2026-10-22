/**
 * Lessons: short, checkable heuristics learned from the agent's own games,
 * such as "don't leave home without ships while an enemy carrier is two
 * moves away". knowledge/lessons.jsonl is the source of truth, one lesson
 * per line; the index build copies it into the search index.
 *
 * A model may draft a lesson from a review note; only a human makes it
 * active, and only active lessons reach the agent. Lessons are retired,
 * never deleted, so ids stay stable and old citations still resolve.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Expansion } from "~/game/data/types";
import { expansionListProblems, Scope, scopeProblems } from "./scope";
import { Topic, TOPICS } from "./types";

export const LESSON_STATUSES = ["draft", "active", "retired"] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

export type Lesson = {
  /** "L3": stable, never reused. */
  id: string;
  status: LessonStatus;
  /** The heuristic, short enough to check against a board. */
  text: string;
  /** Why it holds, or what went wrong when it was learned. */
  why?: string;
  topics: Topic[];
  /** Where it came from, e.g. "review 2026-10" or "review of a Claude game". */
  source: string;
  /** The content of the games it was learned from; [] is the base game alone. */
  learnedWith: Expansion[];
  /** The content it holds for, when that is narrower than every game: left out, it holds everywhere. */
  scope?: Scope;
  /** The replay log (a file name in games/) and decision move it was learned from, when there is one. */
  game?: string;
  move?: number;
  /** Dates, as YYYY-MM-DD. */
  added: string;
  activated?: string;
  retired?: string;
  retiredBecause?: string;
};

/** What a draft needs; the rest is filled in when it is added. */
export type LessonDraft = Pick<Lesson, "text" | "why" | "topics" | "source" | "learnedWith" | "scope" | "game" | "move">;

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What is wrong with one lesson, if anything. */
function lessonProblems(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["not a JSON object"];
  const lesson = value as Record<string, unknown>;
  const problems: string[] = [];
  if (!isText(lesson.id) || !/^L\d+$/.test(lesson.id)) problems.push('id must look like "L3"');
  if (!LESSON_STATUSES.includes(lesson.status as LessonStatus)) {
    problems.push(`status must be one of ${LESSON_STATUSES.join(", ")}`);
  }
  if (!isText(lesson.text)) problems.push("text is required");
  if (lesson.why !== undefined && typeof lesson.why !== "string") problems.push("why must be text");
  if (
    !Array.isArray(lesson.topics) ||
    lesson.topics.length === 0 ||
    lesson.topics.some((t) => !TOPICS.includes(t as Topic))
  ) {
    problems.push(`topics must be a list of one or more of: ${TOPICS.join(", ")}`);
  }
  if (!isText(lesson.source)) problems.push("source is required");
  problems.push(...expansionListProblems(lesson.learnedWith, "learnedWith"));
  if (lesson.scope !== undefined) problems.push(...scopeProblems(lesson.scope, "scope").map((p) => p.slice("scope: ".length)));
  if (lesson.game !== undefined && !isText(lesson.game)) problems.push("game must be a file name");
  if (lesson.move !== undefined && !Number.isInteger(lesson.move)) problems.push("move must be a whole number");
  for (const key of ["added", "activated", "retired"] as const) {
    if (lesson[key] !== undefined && !(typeof lesson[key] === "string" && DATE.test(lesson[key]))) {
      problems.push(`${key} must be a date like 2026-10-22`);
    }
  }
  if (lesson.added === undefined) problems.push("added is required");
  if (lesson.status === "active" && lesson.activated === undefined) problems.push("an active lesson needs activated");
  if (lesson.status === "retired" && lesson.retired === undefined) problems.push("a retired lesson needs retired");
  return problems;
}

/** Reads lessons.jsonl, throwing with every problem found, by line. */
export function parseLessons(text: string): Lesson[] {
  const problems: string[] = [];
  const lessons: Lesson[] = [];
  const ids = new Set<string>();
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      problems.push(`line ${i + 1}: not valid JSON`);
      return;
    }
    const found = lessonProblems(value);
    const lesson = value as Lesson;
    if (found.length === 0 && ids.has(lesson.id)) found.push(`${lesson.id} is used twice`);
    if (found.length > 0) {
      problems.push(`line ${i + 1}: ${found.join("; ")}`);
      return;
    }
    ids.add(lesson.id);
    lessons.push(lesson);
  });
  if (problems.length > 0) throw new Error(`lessons have problems:\n- ${problems.join("\n- ")}`);
  return lessons;
}

/** Lessons as lessons.jsonl holds them: one per line, in id order. */
export function formatLessons(lessons: Lesson[]): string {
  const number = (lesson: Lesson) => Number(lesson.id.slice(1));
  return [...lessons]
    .sort((a, b) => number(a) - number(b))
    .map((lesson) => `${JSON.stringify(lesson)}\n`)
    .join("");
}

const find = (lessons: Lesson[], id: string) => {
  const lesson = lessons.find((l) => l.id.toLowerCase() === id.trim().toLowerCase());
  if (!lesson) throw new Error(`No lesson ${id}.`);
  return lesson;
};

const replace = (lessons: Lesson[], lesson: Lesson) =>
  lessons.map((l) => (l.id === lesson.id ? lesson : l));

/** Adds a draft under the next free id; returns the new list and the draft. */
export function addDraft(lessons: Lesson[], draft: LessonDraft, today: string) {
  const next = Math.max(0, ...lessons.map((l) => Number(l.id.slice(1)))) + 1;
  const lesson: Lesson = {
    id: `L${next}`,
    status: "draft",
    text: draft.text.trim(),
    ...(draft.why?.trim() ? { why: draft.why.trim() } : {}),
    topics: draft.topics,
    source: draft.source.trim(),
    learnedWith: draft.learnedWith,
    ...(draft.scope ? { scope: draft.scope } : {}),
    ...(draft.game ? { game: draft.game } : {}),
    ...(draft.move !== undefined ? { move: draft.move } : {}),
    added: today,
  };
  const problems = lessonProblems(lesson);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return { lessons: [...lessons, lesson], lesson };
}

/** Makes a draft active. Only a human should call this. */
export function activateLesson(lessons: Lesson[], id: string, today: string) {
  const lesson = find(lessons, id);
  if (lesson.status !== "draft") throw new Error(`${lesson.id} is ${lesson.status}, not a draft.`);
  return replace(lessons, { ...lesson, status: "active", activated: today });
}

/** Retires a draft or an active lesson, saying why; it stays in the file. */
export function retireLesson(lessons: Lesson[], id: string, because: string, today: string) {
  const lesson = find(lessons, id);
  if (lesson.status === "retired") throw new Error(`${lesson.id} is already retired.`);
  if (!because.trim()) throw new Error("Say why the lesson is retired.");
  return replace(lessons, { ...lesson, status: "retired", retired: today, retiredBecause: because.trim() });
}

export const LESSONS_PATH = "knowledge/lessons.jsonl";

/** The lessons file's lessons; none if there is no file yet. */
export function readLessons(path = LESSONS_PATH): Lesson[] {
  return existsSync(path) ? parseLessons(readFileSync(path, "utf8")) : [];
}

export function writeLessons(lessons: Lesson[], path = LESSONS_PATH) {
  writeFileSync(path, formatLessons(lessons));
}

/** The parts of a replay log's decision a lesson drafter needs. */
export type ReviewedDecision = {
  move: number;
  round: number;
  phase: string;
  player: number;
  chosen: string;
  menu: { label: string; text: string }[];
  rationale: string;
};

/**
 * A decision from a replay log by move number. Reads either a finished
 * game's log (games/*.json) or the decisions written as it is played
 * (games/*.decisions.jsonl), told apart by the file name.
 */
export function decisionAt(file: string, logText: string, move: number): ReviewedDecision | undefined {
  const decisions: ReviewedDecision[] = file.endsWith(".jsonl")
    ? logText.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line))
    : ((JSON.parse(logText) as { decisions?: ReviewedDecision[] }).decisions ?? []);
  return decisions.find((d) => d.move === move);
}

/** Identifies the active lessons, for agent versions in replay logs. */
export function lessonsVersion(lessons: Lesson[]): string {
  const active = lessons.filter((l) => l.status === "active").map((l) => [l.id, l.text, l.why ?? ""]);
  return createHash("sha256").update(JSON.stringify(active)).digest("hex").slice(0, 8);
}
