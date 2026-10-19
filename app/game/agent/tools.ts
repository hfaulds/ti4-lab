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
  strategyCardsById,
  technologiesById,
  unitFor,
  UNIT_NAMES,
} from "../data";
import { GameState, UnitType } from "../types";
import { planetInfo } from "../engine/board";

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
      },
      required: ["candidate", "rationale", "plan_note"],
      additionalProperties: false,
    },
  },
];

export type ChooseArgs = { candidate: string; rationale: string; plan_note: string };
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
  const { candidate, rationale, plan_note } = parsed.value;
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
    },
  };
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
        `Faction technologies: ${setup.factionTech.map((t) => technologiesById[t]?.name ?? t).join(", ")}.`,
        `Abilities:`,
        ...abilities.map((a) => `- ${a}`),
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
        `tech specialty ${info.tech?.join(", ") || "none"}${info.legendary ? ", legendary" : ""}. In system #${state.planets[name].system}.`;
    }
  }
}
