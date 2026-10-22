import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { buildIndex, loadLessons } from "./indexer";
import {
  activateLesson,
  addDraft,
  decisionAt,
  formatLessons,
  Lesson,
  lessonsVersion,
  parseLessons,
  retireLesson,
} from "./lessons";
import { openKnowledgeBase } from "./search";
import { SynonymList } from "./synonyms";

const synonyms = JSON.parse(readFileSync("knowledge/synonyms.json", "utf8")) as SynonymList;

const lesson = (id: string, fields: Partial<Lesson> = {}): Lesson => ({
  id,
  status: "active",
  text: "A planet with no ground forces falls to anyone who lands.",
  topics: ["combat"],
  source: "review 2026-10",
  learnedWith: [],
  added: "2026-10-22",
  activated: "2026-10-22",
  ...fields,
});

describe("lessons file", () => {
  test("the tracked lessons file is valid", () => {
    const lessons = parseLessons(readFileSync("knowledge/lessons.jsonl", "utf8"));
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons.every((l) => l.status === "active")).toBe(true);
  });

  test("reads lessons back as they were written", () => {
    const lessons = [lesson("L2"), lesson("L1", { why: "Lost Lodor to one carrier." })];
    const text = formatLessons(lessons);
    expect(text.split("\n")[0]).toContain('"id":"L1"');
    expect(parseLessons(text)).toEqual([lessons[1], lessons[0]]);
  });

  test("reports every problem with its line", () => {
    const text = [
      JSON.stringify(lesson("L1")),
      "not json",
      JSON.stringify(lesson("L1")),
      JSON.stringify({ ...lesson("L3"), status: "maybe", topics: ["vibes"] }),
      JSON.stringify(lesson("L4", { activated: undefined })),
    ].join("\n");
    expect(() => parseLessons(text)).toThrow(
      /line 2: not valid JSON\n- line 3: L1 is used twice\n- line 4: status must be.*topics must be.*\n- line 5: an active lesson needs activated/,
    );
  });

  test("drafts take the next id, and only drafts can be activated", () => {
    const { lessons, lesson: draft } = addDraft(
      [lesson("L1"), lesson("L7", { status: "retired", retired: "2026-10-22" })],
      { text: " Keep a ship at home. ", topics: ["combat"], source: "review of a Claude game", learnedWith: [], game: "games/g.json", move: 412 },
      "2026-10-23",
    );
    expect(draft).toEqual({
      id: "L8",
      status: "draft",
      text: "Keep a ship at home.",
      topics: ["combat"],
      source: "review of a Claude game",
      learnedWith: [],
      game: "games/g.json",
      move: 412,
      added: "2026-10-23",
    });
    const active = activateLesson(lessons, "l8", "2026-10-24");
    expect(active.find((l) => l.id === "L8")).toMatchObject({ status: "active", activated: "2026-10-24" });
    expect(() => activateLesson(active, "L8", "2026-10-24")).toThrow("L8 is active, not a draft.");
    expect(() => activateLesson(active, "L99", "2026-10-24")).toThrow("No lesson L99.");
    expect(() => addDraft(lessons, { text: "", topics: [], source: "x", learnedWith: [] }, "2026-10-23")).toThrow(/text is required/);
    expect(() =>
      addDraft(lessons, { text: "A", topics: ["combat"], source: "x", learnedWith: ["thunder" as "te"] }, "2026-10-23"),
    ).toThrow(/learnedWith must be a list of pok/);
    expect(() =>
      addDraft(
        lessons,
        { text: "A", topics: ["combat"], source: "x", learnedWith: [], scope: { needs: ["te"], voidedBy: ["te"] } },
        "2026-10-23",
      ),
    ).toThrow(/both needs and is voided by te/);
  });

  test("retiring keeps the lesson and says why", () => {
    const retired = retireLesson([lesson("L1")], "L1", "The engine now garrisons planets.", "2026-11-01");
    expect(retired).toEqual([
      lesson("L1", { status: "retired", retired: "2026-11-01", retiredBecause: "The engine now garrisons planets." }),
    ]);
    expect(() => retireLesson(retired, "L1", "again", "2026-11-01")).toThrow("already retired");
    expect(() => retireLesson([lesson("L1")], "L1", " ", "2026-11-01")).toThrow("Say why");
  });

  test("the version changes with the active lessons only", () => {
    const base = lessonsVersion([lesson("L1")]);
    expect(lessonsVersion([lesson("L1"), lesson("L2", { status: "draft", activated: undefined })])).toBe(base);
    expect(lessonsVersion([lesson("L1", { text: "Something else." })])).not.toBe(base);
  });

  test("finds a reviewed decision in either kind of replay log", () => {
    const decision = { move: 12, round: 1, phase: "action", player: 0, chosen: "B", menu: [], rationale: "Why not." };
    const other = { ...decision, move: 3 };
    expect(decisionAt("g.json", JSON.stringify({ decisions: [other, decision] }, null, 2), 12)).toEqual(decision);
    expect(decisionAt("g.decisions.jsonl", `${JSON.stringify(other)}\n${JSON.stringify(decision)}\n`, 12)).toEqual(decision);
    expect(decisionAt("g.decisions.jsonl", JSON.stringify(other), 12)).toBe(undefined);
  });
});

describe("lesson search", () => {
  const lessons = [
    lesson("L1"),
    lesson("L2", { text: "Never let the Mecatol Rex holder take Imperial.", topics: ["strategy cards", "mecatol"] }),
    lesson("L3", { text: "Leave ground forces on planets near enemy carriers.", status: "draft", activated: undefined }),
    lesson("L4", { text: "Diplomacy is no use in round one.", status: "retired", retired: "2026-10-22", topics: ["strategy cards"] }),
    lesson("L5", {
      text: "Warfare frees a carrier to expand twice.",
      topics: ["strategy cards"],
      scope: { needs: [], voidedBy: ["te"], note: "about the base Warfare card" },
    }),
  ];

  function knowledgeBase() {
    const db = new Database(":memory:");
    buildIndex(db, [], [], synonyms, lessons);
    return openKnowledgeBase(db, synonyms);
  }

  test("returns active lessons only", () => {
    const kb = knowledgeBase();
    expect(kb.activeLessons).toBe(3);
    expect(kb.searchLessons("ground forces planets").map((l) => l.id)).toEqual(["L1"]);
    expect(kb.searchLessons("Diplo round one")).toEqual([]);
  });

  test("matches topics and shorthand, and fills out with any word", () => {
    const kb = knowledgeBase();
    expect(kb.searchLessons("Rex strategy cards")[0]).toEqual({
      id: "L2",
      text: "Never let the Mecatol Rex holder take Imperial.",
      why: undefined,
      topics: ["strategy cards", "mecatol"],
      source: "review 2026-10",
      learnedWith: [],
      scope: undefined,
    });
    expect(kb.searchLessons("imperial or a planet", 5).map((l) => l.id).sort()).toEqual(["L1", "L2"]);
  });

  test("only lessons that hold for the content in play are found", () => {
    const kb = knowledgeBase();
    expect(kb.searchLessons("Warfare carrier").map((l) => l.id)).toEqual(["L5"]);
    expect(kb.searchLessons("Warfare carrier", 3, ["pok"]).map((l) => l.id)).toEqual(["L5"]);
    expect(kb.searchLessons("Warfare carrier", 3, ["pok", "te"])).toEqual([]);
  });

  test("lessons can be reloaded without rebuilding, and change the version", () => {
    const db = new Database(":memory:");
    buildIndex(db, [], [], synonyms);
    const before = openKnowledgeBase(db, synonyms);
    expect(before.activeLessons).toBe(0);
    loadLessons(db, lessons, synonyms);
    const after = openKnowledgeBase(db, synonyms);
    expect(after.activeLessons).toBe(3);
    expect(after.version).not.toBe(before.version);
  });

  test("an index built before lessons existed has none", () => {
    const db = new Database(":memory:");
    buildIndex(db, [], [], synonyms);
    db.exec("DROP TABLE lessons; DROP TABLE lessons_fts; DELETE FROM meta WHERE key = 'lessonsVersion'");
    const kb = openKnowledgeBase(db, synonyms);
    expect(kb.activeLessons).toBe(0);
    expect(kb.searchLessons("anything")).toEqual([]);
  });
});
