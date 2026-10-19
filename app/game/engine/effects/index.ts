import { AGENDA_EFFECTS } from "./agenda";
import { COMBAT_EFFECTS } from "./combat";
import { GENERAL_EFFECTS } from "./general";
import { EffectTable } from "./types";

export type EffectArea = {
  /** Action cards, by card name (copies of a card share one effect). */
  actionCards: EffectTable;
  /** Faction abilities, technologies, unit abilities and laws, by id. */
  abilities: EffectTable;
  /** Promissory notes, by id. */
  notes: EffectTable;
};

let merged: EffectArea | undefined;

/**
 * Every effect the engine resolves. Built on first use, since the effect
 * modules and the engine modules they call import each other.
 */
export function effects(): EffectArea {
  if (merged) return merged;
  const areas = [GENERAL_EFFECTS, COMBAT_EFFECTS, AGENDA_EFFECTS];
  const merge = (key: keyof EffectArea): EffectTable =>
    Object.assign({}, ...areas.map((area) => area[key]));
  merged = {
    actionCards: merge("actionCards"),
    abilities: merge("abilities"),
    notes: merge("notes"),
  };
  return merged;
}
