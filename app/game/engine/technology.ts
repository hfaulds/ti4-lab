import { PlayerId } from "~/types";
import { availableTechnologies, TechColor, technologiesById } from "../data";
import { Research } from "../actions";
import { GameState } from "../types";
import { planetTechSpecialties } from "./board";
import { pay } from "./economy";
import { ask, ensure, hasTech, log, playerOf } from "./helpers";
import { destroyUnits } from "./effects/helpers";
import { openWindow } from "./reactions";

const AIDA = "aida";

const RESEARCH_TEAMS: Record<string, TechColor> = {
  rt_biotic: "BIOTIC",
  rt_cybernetic: "CYBERNETIC",
  rt_propulsion: "PROPULSION",
  rt_warfare: "WARFARE",
};

/** Destroys a player's cheapest non-fighter ship (the engine chooses). */
function loseCheapestShip(state: GameState, id: PlayerId) {
  const ships = ["destroyer", "cruiser", "carrier", "dreadnought", "flagship", "warsun"] as const;
  for (const type of ships) {
    const system = Object.values(state.systems).find((s) => (s.space[id]?.[type]?.count ?? 0) > 0);
    if (!system) continue;
    destroyUnits(state, id, { system: system.key }, type, 1);
    log(state, `Anti-Intellectual Revolution: ${state.players[id].name} lost a ship.`, { player: id });
    return;
  }
}
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
  // Propagation: the Nekro gain command tokens instead.
  if (player.faction === "nekro") {
    ask(state, [{ kind: "redistribute", player: id, gained: 3 }]);
    log(state, `${player.name} gains 3 command tokens instead of researching.`, {
      player: id,
    });
    return;
  }
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

  // Analytical: the Jol-Nar ignore 1 prerequisite on other technologies.
  if (player.faction === "jolnar" && !tech.unitUpgrade && missing.length > 0) {
    missing.pop();
  }

  if (request.inheritance && missing.length > 0) {
    ensure(hasTech(state, id, "is"), "You do not own Inheritance Systems.");
    ensure(
      !player.exhaustedTechnologies.includes("is"),
      "Inheritance Systems is exhausted.",
    );
    pay(state, id, request.inheritance, "resources", 2);
    player.exhaustedTechnologies.push("is");
    missing.length = 0;
  }

  // Research Team laws attached to the player's planets ignore a prerequisite of their color.
  for (const planet of Object.values(state.planets)) {
    if (planet.controller !== id) continue;
    for (const attachment of planet.attachments) {
      const color = RESEARCH_TEAMS[attachment];
      const key = `${attachment}@${planet.name}`;
      if (!color || !missing.includes(color) || player.used?.includes(key)) continue;
      missing.splice(missing.indexOf(color), 1);
      (player.used ??= []).push(key);
    }
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
  openWindow(state, "afterResearch", { player: id, card: tech.id });
  // Anti-Intellectual Revolution
  if (state.laws.some((law) => law.id === "revolution" && law.outcome !== "Against")) {
    loseCheapestShip(state, id);
  }
}
