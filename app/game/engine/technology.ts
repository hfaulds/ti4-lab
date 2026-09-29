import { PlayerId } from "~/types";
import { availableTechnologies, TechColor, technologiesById } from "../data";
import { Research } from "../actions";
import { GameState } from "../types";
import { planetTechSpecialties } from "./board";
import { ensure, hasTech, log, playerOf } from "./helpers";

const AIDA = "aida";
const PSYCHOARCHAEOLOGY = "pa";

export function ownedColors(state: GameState, id: PlayerId) {
  const counts: Partial<Record<TechColor, number>> = {};
  for (const tech of state.players[id].technologies) {
    const data = technologiesById[tech];
    if (!data?.color || data.unitUpgrade) continue;
    counts[data.color] = (counts[data.color] ?? 0) + 1;
  }
  return counts;
}

/** Technologies a player could still research, prerequisites aside. */
export function researchableTechnologies(state: GameState, id: PlayerId) {
  const player = state.players[id];
  return availableTechnologies(player.faction, state.options.expansions).filter(
    (tech) => !player.technologies.includes(tech.id),
  );
}

/** Prerequisites a player has not met from technologies alone. */
export function missingPrerequisites(
  state: GameState,
  id: PlayerId,
  technology: string,
): TechColor[] {
  const owned = { ...ownedColors(state, id) };
  const missing: TechColor[] = [];
  for (const color of technologiesById[technology]?.prerequisites ?? []) {
    if ((owned[color] ?? 0) > 0) owned[color]!--;
    else missing.push(color);
  }
  return missing;
}

export function research(state: GameState, id: PlayerId, request: Research) {
  const player = playerOf(state, id);
  const tech = researchableTechnologies(state, id).find(
    (t) => t.id === request.technology,
  );
  ensure(tech, "You cannot research that technology.");

  const missing = missingPrerequisites(state, id, tech.id);
  const skips = request.skips ?? [];
  ensure(
    new Set(skips).size === skips.length,
    "A planet can only be exhausted once.",
  );
  const free = hasTech(state, id, PSYCHOARCHAEOLOGY);
  for (const name of skips) {
    const planet = state.planets[name];
    ensure(planet?.controller === id, `You do not control ${name}.`);
    ensure(free || !planet.exhausted, `${name} is already exhausted.`);
    const specialty = planetTechSpecialties(state, name).find((color) =>
      missing.includes(color),
    );
    ensure(specialty, `${name} does not help with this technology.`);
    missing.splice(missing.indexOf(specialty), 1);
  }

  if (request.useAida && missing.length > 0) {
    ensure(hasTech(state, id, AIDA), "You do not own AI Development Algorithm.");
    ensure(
      !player.exhaustedTechnologies.includes(AIDA),
      "AI Development Algorithm is exhausted.",
    );
    ensure(
      tech.unitUpgrade,
      "AI Development Algorithm only helps with unit upgrades.",
    );
    player.exhaustedTechnologies.push(AIDA);
    missing.pop();
  }

  ensure(
    missing.length === 0,
    `${tech.name} needs ${missing.length} more ${missing.join(", ").toLowerCase()} prerequisite${missing.length === 1 ? "" : "s"}.`,
  );

  if (!free) for (const name of skips) state.planets[name].exhausted = true;
  player.technologies.push(tech.id);
  log(state, `${player.name} researched ${tech.name}.`, { player: id });
}
