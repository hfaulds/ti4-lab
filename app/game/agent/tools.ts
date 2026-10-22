/**
 * Tools the agent can call, their JSON schemas, and local validation of the
 * arguments a model sends. Validation happens here rather than relying on
 * the provider to enforce schemas.
 */
import { FactionId } from "~/types";
import { factions } from "~/data/factionData";
import {
  abilitiesById,
  factionSetupFor,
  objectivesById,
  promissoryNotesById,
  strategyCardsById,
  technologiesById,
  unitFor,
  unitsById,
  UNIT_NAMES,
} from "../data";
import { GameState, UnitType } from "../types";
import { planetInfo } from "../engine/board";
import { systemRef } from "./describe";

export type ToolSchema = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export const LOOKUP_KINDS = [
  "faction",
  "unit",
  "technology",
  "objective",
  "strategy_card",
  "planet",
] as const;
export type LookupKind = (typeof LOOKUP_KINDS)[number];

export const TOOLS: ToolSchema[] = [
  {
    name: "lookup",
    description:
      "Exact game data. kind faction: id is a faction id or player label like P2. " +
      "unit: id is '<faction or P#>:<unit type>', for example 'P2:dreadnought'. " +
      "technology, objective: id or name. strategy_card: name. planet: name.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...LOOKUP_KINDS] },
        id: { type: "string" },
      },
      required: ["kind", "id"],
      additionalProperties: false,
    },
  },
  {
    name: "choose",
    description: "Choose your move. Ends the decision.",
    parameters: {
      type: "object",
      properties: {
        candidate: { type: "string", description: "Label of a menu candidate, e.g. 'C'." },
        rationale: { type: "string" },
        plan_note: { type: "string" },
        citations: {
          type: "array",
          items: { type: "string" },
          description: "Ids of guide passages or lessons that informed the choice, e.g. ['118-21', 'L3'].",
        },
      },
      required: ["candidate", "rationale", "plan_note"],
      additionalProperties: false,
    },
  },
];

/** Offered only when a knowledge base is available. */
export const SEARCH_GUIDES_TOOL: ToolSchema = {
  name: "search_guides",
  description:
    "Search the Space Cats Peace Turtles podcast's strategy guides (one episode per base-game faction) " +
    "for advice. Returns short passages with ids like [118-21] you can cite. query: what you want " +
    "advice on, e.g. 'round one Politics' or 'defending the home system'. faction (optional): prefer " +
    "advice about one faction, by name or player label like P2.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      faction: { type: "string" },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

/** Offered only when the knowledge base has active lessons. */
export const SEARCH_LESSONS_TOOL: ToolSchema = {
  name: "search_lessons",
  description:
    "Search lessons learned from reviews of your own past games: short heuristics a human has " +
    "checked, with ids like [L3] you can cite. query: the situation, e.g. 'leaving home undefended' " +
    "or 'spending before the status phase'.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};

export type ChooseArgs = {
  candidate: string;
  rationale: string;
  plan_note: string;
  citations: string[];
};
export type SearchArgs = { query: string; faction?: string };
export type LessonSearchArgs = { query: string };
export type LookupArgs = { kind: LookupKind; id: string };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseObject(raw: string): Parsed<Record<string, unknown>> {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ok: true, value };
    }
    return { ok: false, error: "Arguments must be a JSON object." };
  } catch {
    return { ok: false, error: "Arguments are not valid JSON." };
  }
}

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function parseChoose(raw: string, labels: string[]): Parsed<ChooseArgs> {
  const parsed = parseObject(raw);
  if (!parsed.ok) return parsed;
  const { candidate, rationale, plan_note, citations } = parsed.value;
  if (!isString(candidate)) return { ok: false, error: "candidate is required." };
  const label = candidate.trim().toUpperCase();
  if (!labels.includes(label)) {
    return { ok: false, error: `candidate must be one of ${labels.join(", ")}.` };
  }
  if (!isString(rationale)) return { ok: false, error: "rationale is required." };
  return {
    ok: true,
    value: {
      candidate: label,
      rationale: rationale.trim(),
      plan_note: typeof plan_note === "string" ? plan_note.trim() : "",
      citations: Array.isArray(citations)
        ? [...new Set(citations.filter(isString).map((c) => c.trim().replace(/^\[|\]$/g, "")))]
        : [],
    },
  };
}

export function parseSearch(raw: string): Parsed<SearchArgs> {
  const parsed = parseObject(raw);
  if (!parsed.ok) return parsed;
  const { query, faction } = parsed.value;
  if (!isString(query)) return { ok: false, error: "query is required." };
  return {
    ok: true,
    value: { query: query.trim(), faction: isString(faction) ? faction.trim() : undefined },
  };
}

export function parseLessonSearch(raw: string): Parsed<LessonSearchArgs> {
  const parsed = parseObject(raw);
  if (!parsed.ok) return parsed;
  const { query } = parsed.value;
  if (!isString(query)) return { ok: false, error: "query is required." };
  return { ok: true, value: { query: query.trim() } };
}

export function parseLookup(raw: string): Parsed<LookupArgs> {
  const parsed = parseObject(raw);
  if (!parsed.ok) return parsed;
  const { kind, id } = parsed.value;
  if (!LOOKUP_KINDS.includes(kind as LookupKind)) {
    return { ok: false, error: `kind must be one of ${LOOKUP_KINDS.join(", ")}.` };
  }
  if (!isString(id)) return { ok: false, error: "id is required." };
  return { ok: true, value: { kind: kind as LookupKind, id: id.trim() } };
}

// --- Lookup -------------------------------------------------------------------

const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A faction id from "P2", "hacan" or "Emirates of Hacan". */
function factionOf(state: GameState, id: string): FactionId | undefined {
  const seat = /^p(\d+)$/i.exec(id.trim());
  if (seat) return state.players[Number(seat[1])]?.faction;
  const wanted = normalise(id);
  return (Object.keys(factions) as FactionId[]).find(
    (f) => normalise(f) === wanted || normalise(factions[f].name) === wanted,
  );
}

const byIdOrName = <T extends { id: string; name: string }>(
  items: Record<string, T>,
  id: string,
) =>
  items[id] ??
  Object.values(items).find((item) => normalise(item.name) === normalise(id));

/** Runs a lookup; returns text for the model, including "not found" errors. */
export function lookup(state: GameState, args: LookupArgs): string {
  switch (args.kind) {
    case "faction": {
      const faction = factionOf(state, args.id);
      const setup = faction && factionSetupFor(faction);
      if (!faction || !setup) return `No faction matches "${args.id}".`;
      const abilities = setup.abilities
        .map((a) => abilitiesById[a])
        .filter(Boolean)
        .map((a) => `${a.name}: ${a.text}`);
      return [
        `${factions[faction].name} (${faction}). Commodities ${setup.commodities}.`,
        `Starting technologies: ${setup.startingTech.map((t) => technologiesById[t]?.name ?? t).join(", ") || "none"}.`,
        `Abilities:`,
        ...abilities.map((a) => `- ${a}`),
        `Faction technologies:`,
        ...setup.factionTech.map((t) => `- ${technologiesById[t]?.name ?? t}: ${technologiesById[t]?.text ?? ""}`),
        `Promissory notes:`,
        ...setup.promissoryNotes.map((n) => `- ${promissoryNotesById[n]?.name ?? n}: ${promissoryNotesById[n]?.text ?? ""}`),
        `Faction units:`,
        ...setup.units
          .map((u) => unitsById[u])
          // The faction's own units, in this game's content, before upgrades.
          .filter(
            (u) =>
              u?.faction &&
              !u.requiredTechId &&
              (u.source === "base" || state.options.expansions.some((e) => e === u.source)),
          )
          .map((u) => `- ${u!.name} (${u!.type})${u!.ability ? `: ${u!.ability.replace(/\n/g, " ")}` : ""}`),
      ].join("\n");
    }
    case "unit": {
      const [owner, type] = args.id.split(":").map((part) => part.trim());
      const faction = factionOf(state, owner ?? "");
      const unitType = (Object.keys(UNIT_NAMES) as UnitType[]).find(
        (t) => normalise(t) === normalise(type ?? "") || normalise(UNIT_NAMES[t]) === normalise(type ?? ""),
      );
      if (!faction || !unitType) return `Use "<faction or P#>:<unit type>", e.g. "P2:dreadnought".`;
      const player = Object.values(state.players).find((p) => p.faction === faction);
      const unit = unitFor(faction, unitType, player?.technologies ?? [], state.options.expansions);
      if (!unit) return `${factions[faction].name} cannot field a ${UNIT_NAMES[unitType]}.`;
      const stats = Object.entries(unit)
        .filter(([key]) => !["id", "source", "faction", "upgradesFromUnitId", "upgradesToUnitId"].includes(key))
        .map(([key, value]) => `${key}: ${value}`);
      return `${unit.name}: ${stats.join(", ")}`;
    }
    case "technology": {
      const tech = byIdOrName(technologiesById, args.id);
      if (!tech) return `No technology matches "${args.id}".`;
      return `${tech.name} (${tech.color ?? "unit upgrade"}; needs ${tech.prerequisites?.join(", ") || "nothing"}): ${tech.text}`;
    }
    case "objective": {
      const objective = byIdOrName(objectivesById, args.id);
      if (!objective) return `No objective matches "${args.id}".`;
      return `${objective.name} (${objective.kind}, ${objective.points} VP, scored in the ${objective.phase} phase): ${objective.text}`;
    }
    case "strategy_card": {
      // The printing in this game, which may come from any content set.
      const wanted = normalise(args.id.replace(/\(.*\)\s*$/, ""));
      const card = state.strategyCards
        .map((id) => strategyCardsById[id])
        .find((c) => c && (normalise(c.name) === wanted || normalise(c.id) === wanted));
      if (!card) {
        return `No strategy card matches "${args.id}". Cards in this game: ${state.strategyCards
          .map((id) => strategyCardsById[id]?.name ?? id)
          .join(", ")}.`;
      }
      return [
        `${card.name} (initiative ${card.initiative}).`,
        `Primary: ${card.primary.join(" ")}`,
        `Secondary: ${card.secondary.join(" ")}`,
      ].join("\n");
    }
    case "planet": {
      const name = Object.keys(state.planets).find((p) => normalise(p) === normalise(args.id));
      const info = name && planetInfo(state, name);
      if (!name || !info) return `No planet matches "${args.id}".`;
      return `${name}: ${info.resources} resources, ${info.influence} influence, traits ${info.trait?.join(", ") || "none"}, ` +
        `tech specialty ${info.tech?.join(", ") || "none"}${info.legendary ? ", legendary" : ""}. In system ${systemRef(state, state.planets[name].system)}.`;
    }
  }
}
