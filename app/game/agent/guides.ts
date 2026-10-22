/**
 * The agent's view of the strategy guides and its lessons: search results
 * formatted for the model, and readable labels for what it cites.
 */
import { PlayerId } from "~/types";
import { factions } from "~/data/factionData";
import { GuideHit, KnowledgeBase, LessonHit } from "~/knowledge/search";
import { GameState } from "../types";
import { LessonSearchArgs, SearchArgs } from "./tools";

const RESULTS = 4;
/** Lessons a search returns, and a briefing adds. */
const LESSON_RESULTS = 3;

const clock = (seconds: number) => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** How a cited passage reads to a spectator, e.g. "SCPT ep 118 at 0:43:12: Round one: Diplomacy". */
export const citationLabel = (hit: GuideHit) =>
  `SCPT ep ${hit.episode} at ${clock(hit.start)}: ${hit.title}`;

/** A faction name from a player label ("P2") or the name as given. */
function factionName(state: GameState, faction: string) {
  const seat = /^p(\d+)$/i.exec(faction.trim());
  if (!seat) return faction;
  const player = state.players[Number(seat[1]) as PlayerId];
  return player ? (factions[player.faction]?.name ?? player.faction) : faction;
}

export function formatGuideHits(
  hits: GuideHit[],
  concept?: { name: string; definition: string },
): string {
  if (hits.length === 0 && !concept) return "No guide passages matched. Try other words.";
  const lines = [
    "From the Space Cats Peace Turtles strategy guides. This is advice for human tables; weigh it against this board.",
  ];
  const sections = new Set<string>();
  for (const hit of hits) {
    lines.push("", `[${hit.id}] ${hit.episodeTitle}, ${clock(hit.start)}: ${hit.title}`);
    const section = `${hit.episode}:${hit.section.title}`;
    if (!sections.has(section) && hit.section.summary) {
      sections.add(section);
      lines.push(`Section "${hit.section.title}": ${hit.section.summary}`);
    }
    lines.push(hit.summary);
    for (const advice of hit.advice) lines.push(`- ${advice.stance}: ${advice.point}`);
    if (hit.requires.length > 0) lines.push(`Depends on: ${hit.requires.join(", ")}.`);
  }
  if (concept) lines.push("", `Concept "${concept.name}": ${concept.definition}`);
  return lines.join("\n");
}

/** How a cited lesson reads to a spectator, e.g. "Lesson L3: A planet with no ground forces...". */
export const lessonLabel = (lesson: LessonHit) => `Lesson ${lesson.id}: ${lesson.text}`;

export function formatLessonHits(lessons: LessonHit[]): string {
  if (lessons.length === 0) return "No lessons matched. Try other words.";
  return [
    "Lessons from reviews of your own past games, each checked by a human. Check that it applies on this board.",
    ...lessons.map((l) => `\n[${l.id}] ${l.text}${l.why ? `\nWhy: ${l.why}` : ""}`),
  ].join("\n");
}

/**
 * A search function for one decision. Every passage and lesson it shows is
 * remembered, so what the agent cites can be labelled afterwards.
 */
export function guideSearch(knowledge: KnowledgeBase, state: GameState) {
  const shown = new Map<string, GuideHit>();
  const shownLessons = new Map<string, LessonHit>();
  const findLessons = (query: string) => {
    const lessons = knowledge.searchLessons(query, LESSON_RESULTS);
    for (const lesson of lessons) shownLessons.set(lesson.id, lesson);
    return lessons;
  };
  const find = (args: SearchArgs, limit = RESULTS) => {
    const hits = knowledge.searchGuides({
      query: args.query,
      faction: args.faction ? factionName(state, args.faction) : undefined,
      limit,
    });
    for (const hit of hits) shown.set(hit.id, hit);
    return hits;
  };
  return {
    search(args: SearchArgs) {
      const hits = find(args);
      const [concept] = knowledge.searchConcepts(args.query, 1);
      return { text: formatGuideHits(hits, concept), ids: hits.map((h) => h.id) };
    },
    /** Searches the active lessons; undefined when there are none, so no tool is offered. */
    searchLessons:
      knowledge.activeLessons > 0
        ? (args: LessonSearchArgs) => {
            const lessons = findLessons(args.query);
            return { text: formatLessonHits(lessons), ids: lessons.map((l) => l.id) };
          }
        : undefined,
    /**
     * Guide passages for a decision, searched before the agent is asked:
     * every faction's opening for the round one strategy pick, otherwise
     * the seat's own faction on strategy cards or on the action phase.
     */
    briefing(seat: PlayerId, step: "strategy" | "action") {
      const own = factionName(state, `P${seat}`);
      const searches =
        step === "strategy" && state.round === 1
          ? state.seating.map((id) => ({
              heading: `${factionName(state, `P${id}`)} (P${id}${id === seat ? ", you" : ""})`,
              args: { query: "round one strategy card pick and opening expansion", faction: `P${id}` },
              limit: 2,
            }))
          : [
              {
                heading: `${own} (you)`,
                args:
                  step === "strategy"
                    ? { query: `round ${state.round} strategy card pick`, faction: `P${seat}` }
                    : { query: `round ${state.round} expansion building and scoring`, faction: `P${seat}` },
                limit: 3,
              },
            ];
      const ids: string[] = [];
      const sections = searches.map(({ heading, args, limit }) => {
        const hits = find(args, limit);
        ids.push(...hits.map((h) => h.id));
        return [`### ${heading}`, formatGuideHits(hits)].join("\n");
      });
      // The lessons that bear most on the same decision, if any match.
      const lessons = findLessons(
        step === "strategy" ? "strategy cards objectives mecatol" : "expansion combat objectives economy",
      );
      if (lessons.length > 0) {
        ids.push(...lessons.map((l) => l.id));
        sections.push(["### Lessons from your past games", formatLessonHits(lessons)].join("\n"));
      }
      return { text: sections.join("\n\n"), ids };
    },
    label: (id: string) => {
      const hit = shown.get(id);
      const lesson = shownLessons.get(id);
      return hit ? citationLabel(hit) : lesson ? lessonLabel(lesson) : id;
    },
  };
}
