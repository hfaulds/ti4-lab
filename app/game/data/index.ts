import { FactionId } from "~/types";
import { abilities } from "./generated/abilities";
import { actionCards } from "./generated/actionCards";
import { agendas } from "./generated/agendas";
import { attachments } from "./generated/attachments";
import { breakthroughs } from "./generated/breakthroughs";
import { explorations } from "./generated/explorations";
import { factionSetups } from "./generated/factionSetups";
import { galacticEvents } from "./generated/galacticEvents";
import { leaders } from "./generated/leaders";
import { objectives } from "./generated/objectives";
import { promissoryNotes } from "./generated/promissoryNotes";
import { relics } from "./generated/relics";
import { strategyCards } from "./generated/strategyCards";
import { technologies } from "./generated/technologies";
import { units } from "./generated/units";
import {
  ContentSource,
  Expansion,
  FactionSetupData,
  StrategyCardData,
  TechnologyData,
  UnitData,
  UnitType,
} from "./types";

export * from "./types";
export {
  abilities,
  actionCards,
  agendas,
  attachments,
  breakthroughs,
  explorations,
  factionSetups,
  galacticEvents,
  leaders,
  objectives,
  promissoryNotes,
  relics,
  strategyCards,
  technologies,
  units,
};

export const EXPANSIONS: { id: Expansion; name: string; description: string }[] =
  [
    {
      id: "pok",
      name: "Prophecy of Kings",
      description:
        "Mechs, leaders, exploration, relics, legendary planets and the wormhole nexus.",
    },
    {
      id: "te",
      name: "Thunder's Edge",
      description: "Breakthroughs, new factions, action cards and relics.",
    },
    {
      id: "codex1",
      name: "Codex I: Ordinian",
      description: "Revised technologies, promissory notes and 20 action cards.",
    },
    {
      id: "codex2",
      name: "Codex II: Affinity",
      description: "Three additional relics. Requires Prophecy of Kings.",
    },
    {
      id: "codex3",
      name: "Codex III: Vigil",
      description:
        "Council Keleres and frontier exploration cards. Requires Prophecy of Kings.",
    },
    {
      id: "codex4",
      name: "Codex IV: Liberation",
      description: "Revised technologies and three relics.",
    },
  ];

/** Later sources supersede earlier printings of the same component. */
const SOURCE_RANK: Record<ContentSource, number> = {
  base: 0,
  pok: 1,
  codex1: 2,
  codex2: 3,
  codex3: 4,
  codex4: 5,
  te: 6,
};

export const isEnabled = (source: ContentSource, expansions: Expansion[]) =>
  source === "base" || expansions.includes(source);

const byId = <T extends { id: string }>(items: T[]) =>
  Object.fromEntries(items.map((item) => [item.id, item])) as Record<string, T>;

export const unitsById = byId(units);
export const technologiesById = byId(technologies);
export const actionCardsById = byId(actionCards);
export const agendasById = byId(agendas);
export const objectivesById = byId(objectives);
export const strategyCardsById = byId(strategyCards);
export const explorationsById = byId(explorations);
export const attachmentsById = byId(attachments);
export const relicsById = byId(relics);
export const leadersById = byId(leaders);
export const promissoryNotesById = byId(promissoryNotes);
export const abilitiesById = byId(abilities);
export const breakthroughsById = byId(breakthroughs);

/** "Magen Defense Grid ΩΩ" and "Magen Defense Grid" are the same card. */
const printingKey = (item: { name: string; faction?: FactionId }) =>
  `${item.faction ?? ""}:${item.name.replace(/\s*Ω+$/, "")}`;

/**
 * Filters to the enabled content, keeping only the newest enabled printing
 * of components that a codex reissued.
 */
export function enabledContent<
  T extends { id: string; name: string; source: ContentSource },
>(items: T[], expansions: Expansion[]): T[] {
  const newest = new Map<string, T>();
  for (const item of items) {
    if (!isEnabled(item.source, expansions)) continue;
    const key = printingKey(item);
    const current = newest.get(key);
    if (!current || SOURCE_RANK[item.source] > SOURCE_RANK[current.source]) {
      newest.set(key, item);
    }
  }
  const kept = new Set([...newest.values()].map((item) => item.id));
  return items.filter((item) => kept.has(item.id));
}

/** Maps a technology id to the printing in use for these expansions. */
export function resolveTechnology(
  id: string,
  expansions: Expansion[],
): TechnologyData | undefined {
  const tech = technologiesById[id];
  if (!tech) return undefined;
  const key = printingKey(tech);
  return enabledContent(
    technologies.filter((t) => printingKey(t) === key),
    expansions,
  )[0];
}

export function availableTechnologies(
  faction: FactionId,
  expansions: Expansion[],
): TechnologyData[] {
  return enabledContent(technologies, expansions).filter(
    (tech) => !tech.faction || tech.faction === faction,
  );
}

/** One strategy card per initiative number, preferring the newest printing. */
export function strategyCardsFor(expansions: Expansion[]): StrategyCardData[] {
  const cards = new Map<number, StrategyCardData>();
  for (const card of strategyCards) {
    // The errata'd base cards ship in every box, so they are always usable.
    const usable = card.source !== "te" || expansions.includes("te");
    if (!usable) continue;
    const current = cards.get(card.initiative);
    if (!current || SOURCE_RANK[card.source] > SOURCE_RANK[current.source]) {
      cards.set(card.initiative, card);
    }
  }
  return [...cards.values()].sort((a, b) => a.initiative - b.initiative);
}

export function factionSetupFor(
  faction: FactionId,
  variant?: FactionId,
): FactionSetupData | undefined {
  const setups = factionSetups.filter((s) => s.faction === faction);
  return setups.find((s) => s.variant === variant) ?? setups[0];
}

const genericUnit = (type: UnitType, expansions: Expansion[]) =>
  units.find(
    (u) =>
      u.type === type &&
      !u.faction &&
      !u.requiredTechId &&
      isEnabled(u.source, expansions),
  );

/**
 * The version of a unit type a player is currently fielding, taking their
 * faction's unique units and the unit upgrades they own into account.
 * Returns undefined when the unit is unavailable (a war sun without the
 * technology, or a mech without Prophecy of Kings).
 */
export function unitFor(
  faction: FactionId,
  type: UnitType,
  ownedTechnologies: string[],
  expansions: Expansion[],
): UnitData | undefined {
  const setup = factionSetupFor(faction);
  const printed = (setup?.units ?? [])
    .map((id) => unitsById[id])
    .filter((u): u is UnitData => !!u && u.type === type);

  // A faction's sheet may name a printing from content that is switched off.
  const enabled = printed.find((u) => isEnabled(u.source, expansions));
  const fallback = enabledContent(
    units.filter(
      (u) => u.type === type && u.faction === faction && !u.requiredTechId,
    ),
    expansions,
  ).find((u) => !u.id.endsWith("_space"));
  let unit =
    enabled ?? (printed.length > 0 ? fallback : undefined) ??
    genericUnit(type, expansions);

  if (!unit) {
    // War suns exist only as an upgrade for most factions.
    unit = units.find(
      (u) =>
        u.type === type &&
        !u.faction &&
        !!u.requiredTechId &&
        !u.upgradesFromUnitId &&
        isEnabled(u.source, expansions),
    );
    if (!unit || !ownedTechnologies.includes(unit.requiredTechId!)) {
      return undefined;
    }
    return unit;
  }

  if (unit.requiredTechId && !ownedTechnologies.includes(unit.requiredTechId)) {
    return undefined;
  }

  while (unit.upgradesToUnitId) {
    const upgrade: UnitData | undefined = unitsById[unit.upgradesToUnitId];
    if (
      !upgrade ||
      !upgrade.requiredTechId ||
      !ownedTechnologies.includes(upgrade.requiredTechId)
    ) {
      break;
    }
    unit = upgrade;
  }
  return unit;
}

/** Plastic available to each player (Living Rules Reference 96.2). */
export const UNIT_LIMITS: Record<UnitType, number> = {
  spacedock: 3,
  pds: 6,
  destroyer: 8,
  cruiser: 8,
  warsun: 2,
  // Fighters and infantry are backed by tokens and are not limited.
  infantry: Infinity,
  fighter: Infinity,
  carrier: 4,
  dreadnought: 5,
  flagship: 1,
  mech: 4,
};

export const SHIP_TYPES: UnitType[] = [
  "warsun",
  "flagship",
  "dreadnought",
  "carrier",
  "cruiser",
  "destroyer",
  "fighter",
];
export const GROUND_FORCE_TYPES: UnitType[] = ["mech", "infantry"];
export const STRUCTURE_TYPES: UnitType[] = ["spacedock", "pds"];

export const isShip = (type: UnitType) => SHIP_TYPES.includes(type);
export const isGroundForce = (type: UnitType) =>
  GROUND_FORCE_TYPES.includes(type);
export const isStructure = (type: UnitType) => STRUCTURE_TYPES.includes(type);

export const UNIT_NAMES: Record<UnitType, string> = {
  carrier: "Carrier",
  cruiser: "Cruiser",
  destroyer: "Destroyer",
  dreadnought: "Dreadnought",
  fighter: "Fighter",
  flagship: "Flagship",
  infantry: "Infantry",
  mech: "Mech",
  pds: "PDS",
  spacedock: "Space Dock",
  warsun: "War Sun",
};
