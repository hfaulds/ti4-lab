import { AGENDA_EFFECTS } from "./agenda";
import { COMBAT_EFFECTS } from "./combat";
import { EXPLORATION_EFFECTS } from "./exploration";
import { GENERAL_EFFECTS } from "./general";
import { LEADER_EFFECTS } from "./leaders";
import { POK_EFFECTS } from "./pok";
import { TE_EFFECTS } from "./te";
import { EffectTable } from "./types";

export type EffectArea = {
  /** Action cards, by card name (copies of a card share one effect). */
  actionCards: EffectTable;
  /** Faction abilities, technologies, unit abilities and laws, by id. */
  abilities: EffectTable;
  /** Promissory notes, by id. */
  notes: EffectTable;
  /** Agents, commanders and heroes, by leader id. */
  leaders?: EffectTable;
  /** Relics, by id. */
  relics?: EffectTable;
  /** Exploration cards and relic fragments, by card name. */
  explorations?: EffectTable;
  /** Legendary planet abilities, by planet name. */
  planets?: EffectTable;
};

let merged: Required<EffectArea> | undefined;

/**
 * Every effect the engine resolves. Built on first use, since the effect
 * modules and the engine modules they call import each other.
 */
export function effects(): Required<EffectArea> {
  if (merged) return merged;
  const areas = [
    GENERAL_EFFECTS,
    COMBAT_EFFECTS,
    AGENDA_EFFECTS,
    EXPLORATION_EFFECTS,
    POK_EFFECTS,
    LEADER_EFFECTS,
    TE_EFFECTS,
  ];
  const merge = (key: keyof EffectArea): EffectTable =>
    Object.assign({}, ...areas.map((area) => area[key] ?? {}));
  merged = {
    actionCards: merge("actionCards"),
    abilities: merge("abilities"),
    notes: merge("notes"),
    leaders: merge("leaders"),
    relics: merge("relics"),
    explorations: merge("explorations"),
    planets: merge("planets"),
  };
  return merged;
}
