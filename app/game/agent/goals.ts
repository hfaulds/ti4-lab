/**
 * The objectives a player is working toward, and how much a planet,
 * technology or ship position moves them closer.
 */
import { PlayerId, PlanetTrait } from "~/types";
import { technologiesById } from "../data";
import { GameState, SystemKey } from "../types";
import {
  adjacentSystems,
  anomaliesOf,
  controlledPlanets,
  MECATOL_REX,
  planetTechSpecialties,
  planetTraits,
  wormholesOf,
} from "../engine/board";
import { objectiveStatus } from "../engine/objectives";
import { ownedColors } from "../engine/technology";

const cache = new WeakMap<GameState, Map<PlayerId, string[]>>();

/**
 * Revealed public objectives and the player's secrets that are not met yet.
 * Objectives the engine cannot check are left out; the bot never claims them.
 */
export function goalsOf(state: GameState, id: PlayerId): string[] {
  let byPlayer = cache.get(state);
  if (!byPlayer) cache.set(state, (byPlayer = new Map()));
  const cached = byPlayer.get(id);
  if (cached) return cached;

  const publics = state.publicObjectives
    .filter((o) => o.revealed && !o.scoredBy.includes(id))
    .map((o) => o.id);
  const goals = [...publics, ...state.players[id].secretObjectives].filter(
    (o) => objectiveStatus(state, id, o).met === false,
  );
  byPlayer.set(id, goals);
  return goals;
}

const TRAITS: PlanetTrait[] = ["CULTURAL", "HAZARDOUS", "INDUSTRIAL"];
const TRAIT_SECRETS: Record<string, PlanetTrait> = {
  faa: "CULTURAL",
  mrm: "HAZARDOUS",
  mp: "INDUSTRIAL",
};

function traitCounts(state: GameState, id: PlayerId) {
  const counts = new Map<PlanetTrait, number>(TRAITS.map((t) => [t, 0]));
  for (const planet of controlledPlanets(state, id)) {
    for (const trait of planetTraits(state, planet.name)) {
      counts.set(trait, (counts.get(trait) ?? 0) + 1);
    }
  }
  return counts;
}

/** Extra worth of a planet for the objectives the player is chasing. */
export function planetGoalBonus(state: GameState, id: PlayerId, name: string) {
  const goals = goalsOf(state, id);
  if (goals.length === 0) return 0;
  let bonus = 0;
  const traits = planetTraits(state, name);
  if (goals.includes("corner") || goals.includes("unify_colonies")) {
    const counts = traitCounts(state, id);
    const best = [...TRAITS].sort((a, b) => counts.get(b)! - counts.get(a)!)[0];
    if (traits.includes(best)) bonus += 1.5;
  }
  for (const [goal, trait] of Object.entries(TRAIT_SECRETS)) {
    if (goals.includes(goal) && traits.includes(trait)) bonus += 1.5;
  }
  const specialty = planetTechSpecialties(state, name).length > 0;
  if (
    specialty &&
    (goals.includes("research_outposts") || goals.includes("brain_trust"))
  ) {
    bonus += 1.5;
  }
  if (name === MECATOL_REX && goals.includes("ose")) bonus += 3;
  return bonus;
}

/** Extra worth of a technology for the objectives the player is chasing. */
export function techGoalBonus(state: GameState, id: PlayerId, tech: string) {
  const goals = goalsOf(state, id);
  const data = technologiesById[tech];
  if (!data || goals.length === 0) return 0;
  let bonus = 0;
  if (data.unitUpgrade) {
    if (goals.includes("develop") || goals.includes("revolutionize")) bonus += 2;
    return bonus;
  }
  if (!data.color) return bonus;
  const colors = ownedColors(state, id);
  const owned = colors[data.color] ?? 0;
  const pairs = Object.values(colors).filter((count) => (count ?? 0) >= 2).length;
  const wantsPairs =
    (goals.includes("diversify") && pairs < 2) ||
    (goals.includes("master_science") && pairs < 4);
  if (wantsPairs) bonus += owned === 1 ? 3 : owned === 0 ? 1 : 0;
  if (goals.includes("mlp")) {
    const most = Math.max(0, ...Object.values(colors).map((c) => c ?? 0));
    if (owned === most && owned < 4) bonus += 2;
  }
  if (goals.includes("ans") && data.faction) bonus += 3;
  return bonus;
}

// --- Positions ----------------------------------------------------------------

/** Objectives met by where a player's ships are, as progress from 0 to 1. */
const POSITION_GOALS: Record<
  string,
  (state: GameState, id: PlayerId, fleets: SystemKey[]) => number
> = {
  intimidate: (state, _id, fleets) => {
    const mecatol = state.planets[MECATOL_REX]?.system;
    if (mecatol === undefined) return 0;
    const adjacent = adjacentSystems(state, mecatol);
    return Math.min(2, fleets.filter((k) => adjacent.includes(k)).length) / 2;
  },
  ctr: (_state, _id, fleets) => Math.min(6, fleets.length) / 6,
  te: (state, id, fleets) =>
    fleets.some((key) =>
      adjacentSystems(state, key).some((k) => {
        const home = state.systems[k].homeOf;
        return home !== undefined && home !== id;
      }),
    )
      ? 1
      : 0,
  lsc: (state, _id, fleets) =>
    Math.min(
      3,
      fleets.filter((key) =>
        adjacentSystems(state, key).some(
          (k) => anomaliesOf(state.systems[k]).length > 0,
        ),
      ).length,
    ) / 3,
  btgk: (state, _id, fleets) => {
    const holes = fleets.flatMap((key) => wormholesOf(state.systems[key]));
    return (holes.includes("ALPHA") ? 0.5 : 0) + (holes.includes("BETA") ? 0.5 : 0);
  },
};

/** Worth of having ships in `fleets`, for the positional objectives chased. */
export function positionScore(state: GameState, id: PlayerId, fleets: SystemKey[]) {
  let score = 0;
  for (const goal of goalsOf(state, id)) {
    const progress = POSITION_GOALS[goal]?.(state, id, fleets);
    if (progress === undefined) continue;
    // Finishing an objective is worth much more than inching toward it.
    score += 4 * progress + (progress >= 1 ? 3 : 0);
  }
  return score;
}

export const chasesPosition = (state: GameState, id: PlayerId) =>
  goalsOf(state, id).some((goal) => goal in POSITION_GOALS);
