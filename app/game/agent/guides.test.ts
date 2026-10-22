import { describe, expect, test } from "vitest";
import { factions } from "~/data/factionData";
import { GuideHit, KnowledgeBase, LessonHit } from "~/knowledge/search";
import { testGame } from "../engine/testing";
import { guideSearch } from "./guides";
import { setupFor } from "./setups";

const hit = (id: string, title: string): GuideHit => ({
  id,
  episode: 118,
  episodeTitle: "Ep 118: Hacan",
  start: 2592,
  title,
  summary: "Hacan wants Trade.",
  advice: [{ stance: "recommended", point: "Take Trade round one.", subjects: ["Trade"] }],
  factions: ["Emirates of Hacan"],
  requires: [],
  section: { title: "Round one", summary: "Opening picks." },
});

const garrison: LessonHit = {
  id: "L3",
  text: "A planet with no ground forces falls to anyone who lands.",
  why: "Lost Lodor to one carrier.",
  topics: ["combat"],
  source: "review 2026-10",
};

/** A knowledge base that returns fixed hits and records the searches. */
function stubKnowledge(hits: GuideHit[], lessons: LessonHit[] = []) {
  const searches: { query: string; faction?: string }[] = [];
  const knowledge: KnowledgeBase = {
    version: "test",
    searchGuides: (options) => {
      searches.push({ query: options.query, faction: options.faction });
      return hits;
    },
    searchConcepts: () => [
      { name: "X-1 trade", aliases: [], definition: "Trading one for one.", explained: false },
    ],
    searchLessons: () => lessons,
    activeLessons: lessons.length,
    close: () => {},
  };
  return { knowledge, searches };
}

describe("guide search", () => {
  test("formats passages with ids, sections and a concept", () => {
    const { knowledge } = stubKnowledge([hit("118-3", "Trade first"), hit("118-4", "Then Politics")]);
    const { text, ids } = guideSearch(knowledge, testGame({ seed: 1, ...setupFor(1) })).search({
      query: "trade",
    });
    expect(ids).toEqual(["118-3", "118-4"]);
    expect(text).toContain("[118-3] Ep 118: Hacan, 0:43:12: Trade first");
    // The section summary is shown once, for its first passage.
    expect(text.match(/Section "Round one"/g)).toHaveLength(1);
    expect(text).toContain("- recommended: Take Trade round one.");
    expect(text).toContain('Concept "X-1 trade": Trading one for one.');
  });

  test("reads a player label as that player's faction, and labels citations", () => {
    const state = testGame({ seed: 1, ...setupFor(1) });
    const { knowledge, searches } = stubKnowledge([hit("118-3", "Trade first")]);
    const guides = guideSearch(knowledge, state);
    guides.search({ query: "opening", faction: "P1" });
    expect(searches[0].faction).toBe(factions[state.players[1].faction].name);
    expect(guides.label("118-3")).toBe("SCPT ep 118 at 0:43:12: Trade first");
    expect(guides.label("unseen")).toBe("unseen");
  });

  test("brief a round one strategy pick on every faction's opening", () => {
    const state = testGame({ seed: 1, ...setupFor(1) });
    const { knowledge, searches } = stubKnowledge([hit("118-3", "Trade first")]);
    const guides = guideSearch(knowledge, state);
    const briefing = guides.briefing(0, "strategy");
    expect(searches.map((s) => s.faction)).toEqual(
      state.seating.map((id) => factions[state.players[id].faction].name),
    );
    expect(briefing.text.match(/^### /gm)).toHaveLength(state.seating.length);
    expect(briefing.text).toContain("(P0, you)");
    // What a briefing shows can be cited.
    expect(guides.label("118-3")).toBe("SCPT ep 118 at 0:43:12: Trade first");
  });

  test("searches lessons, labels them, and offers no search without any", () => {
    const state = testGame({ seed: 1, ...setupFor(1) });
    expect(guideSearch(stubKnowledge([]).knowledge, state).searchLessons).toBe(undefined);
    const guides = guideSearch(stubKnowledge([], [garrison]).knowledge, state);
    const found = guides.searchLessons!({ query: "undefended planets" });
    expect(found.ids).toEqual(["L3"]);
    expect(found.text).toContain("[L3] A planet with no ground forces falls to anyone who lands.\nWhy: Lost Lodor");
    expect(guides.label("L3")).toBe("Lesson L3: A planet with no ground forces falls to anyone who lands.");
  });

  test("a briefing adds the lessons that match, citable by id", () => {
    const state = testGame({ seed: 1, ...setupFor(1) });
    const guides = guideSearch(stubKnowledge([hit("118-3", "Trade first")], [garrison]).knowledge, state);
    const briefing = guides.briefing(0, "action");
    expect(briefing.ids).toEqual(["118-3", "L3"]);
    expect(briefing.text).toContain("### Lessons from your past games\nLessons from reviews");
  });
});
