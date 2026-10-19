/**
 * The agent's view of the strategy guides: search results formatted for the
 * model, and readable labels for the passages it cites.
 */
import { PlayerId } from "~/types";
import { factions } from "~/data/factionData";
import { GuideHit, KnowledgeBase } from "~/knowledge/search";
import { GameState } from "../types";
import { SearchArgs } from "./tools";

const RESULTS = 4;

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

/**
 * A search function for one decision. Every passage it shows is
 * remembered, so the passages the agent cites can be labelled afterwards.
 */
export function guideSearch(knowledge: KnowledgeBase, state: GameState) {
  const shown = new Map<string, GuideHit>();
  return {
    search(args: SearchArgs) {
      const hits = knowledge.searchGuides({
        query: args.query,
        faction: args.faction ? factionName(state, args.faction) : undefined,
        limit: RESULTS,
      });
      for (const hit of hits) shown.set(hit.id, hit);
      const [concept] = knowledge.searchConcepts(args.query, 1);
      return { text: formatGuideHits(hits, concept), ids: hits.map((h) => h.id) };
    },
    label: (id: string) => {
      const hit = shown.get(id);
      return hit ? citationLabel(hit) : id;
    },
  };
}
