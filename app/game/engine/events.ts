/**
 * Things that happen automatically at fixed points in the game because of
 * abilities, technologies, laws and promissory notes, and the windows that
 * let players react at those points.
 */
import { PlayerId } from "~/types";
import { promissoryNotesById, UnitCounts } from "../data";
import { GameState, SystemKey } from "../types";
import { isLegendary, planetInfluence, planetResources, systemOf, MECATOL_REX } from "./board";
import { achieve } from "./effects/helpers";
import { transferRelic } from "./relics";
import { enforceFleetSupply } from "./combat";
import { victoryPoints } from "./control";
import {
  addUnits,
  countOf,
  drawActionCards,
  hasShips,
  hasTech,
  log,
  playerName,
  plural,
  totalUnits,
  unitsAvailable,
} from "./helpers";
import { openWindow, ownsAbility } from "./reactions";

const lawOwner = (state: GameState, law: string) =>
  state.laws.find((l) => l.id === law)?.owner;

// --- Turns ------------------------------------------------------------------

/** The start of a player's turn in the action phase. */
export function startTurn(state: GameState, id: PlayerId) {
  const player = state.players[id];
  // Infantry II brought back from the card onto a home planet.
  const reviving = player.revivingInfantry ?? 0;
  if (reviving > 0) {
    player.revivingInfantry = 0;
    const home = systemOf(state, player.home).planets.find(
      (p) => state.planets[p].controller === id,
    );
    if (home) {
      addUnits(state.planets[home].units, id, "infantry", reviving);
      log(state, `${player.name} returned ${plural(reviving, "infantry")} to ${home}.`, {
        player: id,
      });
    }
  }
  // Crimson Legionnaire II units come back to a home planet.
  const legionnaires = player.revivingLegionnaires ?? 0;
  if (legionnaires > 0) {
    player.revivingLegionnaires = 0;
    const home = systemOf(state, player.home).planets.find(
      (p) => state.planets[p].controller === id,
    );
    if (home) {
      addUnits(state.planets[home].units, id, "infantry", legionnaires);
      log(state, `${player.name} returned ${plural(legionnaires, "infantry")} to ${home}.`, {
        player: id,
      });
    }
  }
  openWindow(state, "turnStart", { player: id });
}

/** After an action is finished, while the player may still act again. */
export function afterAction(state: GameState, id: PlayerId) {
  if (state.phase !== "action" || state.activePlayer !== id) return;
  openWindow(state, "afterAction", { player: id }, [id]);
}

// --- Trade goods ------------------------------------------------------------

/** After a player gains trade goods or resolves a transaction (Pillage). */
export function afterGainingTradeGoods(state: GameState, id: PlayerId, fromSupply?: number) {
  if (state.phase === "finished") return;
  openWindow(state, "afterGainTradeGoods", { player: id, amount: fromSupply });
}

export function gainTradeGoodsFrom(
  state: GameState,
  id: PlayerId,
  amount: number,
  source: string,
) {
  if (amount <= 0) return;
  state.players[id].tradeGoods += amount;
  log(state, `${playerName(state, id)} gained ${plural(amount, "trade good")} (${source}).`, {
    player: id,
  });
  afterGainingTradeGoods(state, id, amount);
}

// --- Activation -------------------------------------------------------------

const hasUnitsIn = (state: GameState, id: PlayerId, key: SystemKey) => {
  const system = systemOf(state, key);
  return (
    totalUnits(system.space[id]) > 0 ||
    system.planets.some((p) => totalUnits(state.planets[p].units[id]) > 0)
  );
};

/** Promissory notes in play that go home when their owner's system is activated. */
const RETURN_ON_ACTIVATION = [
  "sftt",
  "convoys",
  "pop",
  "antivirus",
  "an",
  "blood_pact",
  "dark_pact",
];

export function afterActivating(state: GameState, id: PlayerId, key: SystemKey) {
  const system = systemOf(state, key);
  const active = state.players[id];

  for (const note of [...active.promissoryNotesInPlay]) {
    if (!RETURN_ON_ACTIVATION.includes(note.id)) continue;
    if (!hasUnitsIn(state, note.owner, key)) continue;
    returnNoteInPlay(state, id, note.id, note.owner);
  }

  for (const other of state.seating) {
    if (other === id || state.players[other].eliminated) continue;
    if (!hasShips(system.space[other])) continue;
    // Neuroglaive
    if (hasTech(state, other, "ng") && active.pools.fleet > 0) {
      active.pools.fleet--;
      enforceFleetSupply(state, id);
      log(
        state,
        `Neuroglaive: ${active.name} returned a fleet pool token to their reinforcements.`,
        { player: id },
      );
    }
    // E-Res Siphons
    if (hasTech(state, other, "ers")) {
      gainTradeGoodsFrom(state, other, 4, "E-Res Siphons");
    }
  }
  openWindow(state, "afterActivate", { system: key, player: id });
}

/** Returns a note from a player's play area to its owner. */
export function returnNoteInPlay(
  state: GameState,
  holder: PlayerId,
  note: string,
  owner: PlayerId,
) {
  const player = state.players[holder];
  const index = player.promissoryNotesInPlay.findIndex(
    (n) => n.id === note && n.owner === owner,
  );
  if (index < 0) return;
  player.promissoryNotesInPlay.splice(index, 1);
  state.players[owner].promissoryNotes.push({ id: note, owner });
  if (note === "sftt") player.bonusVictoryPoints -= 1;
  log(
    state,
    `${player.name} returned ${promissoryNotesById[note]?.name ?? note} to ${playerName(state, owner)}${note === "sftt" ? ` and lost 1 victory point (${victoryPoints(state, holder)} VP)` : ""}.`,
    { player: holder },
  );
}

export function afterMoving(state: GameState, id: PlayerId, key: SystemKey) {
  // Voidwatch: moving in on the Empyrean costs a promissory note.
  for (const other of state.seating) {
    if (other === id || !hasTech(state, other, "vw") || !hasUnitsIn(state, other, key)) continue;
    const mover = state.players[id];
    const [note] = mover.promissoryNotes;
    if (!note) continue;
    mover.promissoryNotes = mover.promissoryNotes.slice(1);
    state.players[other].promissoryNotes.push(note);
    log(state, `Voidwatch: ${mover.name} gave a promissory note to ${playerName(state, other)}.`, {
      player: id,
    });
  }
  openWindow(state, "afterMove", { system: key, player: id });
}

// --- Planets ----------------------------------------------------------------

/**
 * After a player gains control of a planet. `previous` is the player who
 * lost it, if any, and `lost` the structures destroyed with it.
 */
export function afterGainingControl(
  state: GameState,
  id: PlayerId,
  name: string,
  previous: PlayerId | undefined,
  lost: UnitCounts,
) {
  const planet = state.planets[name];
  // Assimilate: the L1Z1X take over what was built there.
  if (ownsAbility(state, id, "assimilate")) {
    for (const type of ["pds", "spacedock"] as const) {
      const count = Math.min(lost[type] ?? 0, unitsAvailable(state, id, type));
      if (count <= 0) continue;
      addUnits(planet.units, id, type, count);
      log(state, `Assimilate: ${playerName(state, id)} took over ${count} ${type === "pds" ? "PDS" : "space dock"} on ${name}.`, {
        player: id,
      });
    }
  }
  if (ownsAbility(state, id, "scavenge")) gainTradeGoodsFrom(state, id, 1, "Scavenge");
  // Liberate
  if (ownsAbility(state, id, "liberate")) {
    if (countOf(planet.units[id], "infantry") >= planetResources(state, name)) planet.exhausted = false;
    else if (unitsAvailable(state, id, "infantry") > 0) addUnits(planet.units, id, "infantry", 1);
  }
  // Fealty Uplink
  if (ownsAbility(state, id, "l1z1xbt")) {
    const count = Math.min(planetInfluence(state, name), unitsAvailable(state, id, "infantry"));
    if (count > 0) addUnits(planet.units, id, "infantry", count);
  }
  if (lawOwner(state, "minister_exploration") === id) {
    gainTradeGoodsFrom(state, id, 1, "Minister of Exploration");
  }
  // The Crown of Emphidia goes to whoever takes a planet in its owner's home.
  const crown = state.laws.find((law) => law.id === "crown_of_emphidia");
  if (
    crown?.owner !== undefined &&
    crown.owner !== id &&
    state.systems[planet.system]?.homeOf === crown.owner
  ) {
    state.players[crown.owner].bonusVictoryPoints -= 1;
    state.players[id].bonusVictoryPoints += 1;
    log(state, `${playerName(state, id)} took the Crown of Emphidia.`, { player: id });
    crown.owner = id;
  }
  if (
    previous !== undefined &&
    state.players[previous].relics.includes("shard") &&
    (isLegendary(state, name) || state.systems[planet.system]?.homeOf === previous)
  ) {
    transferRelic(state, previous, id, "shard");
  }
  // Become a Martyr
  if (previous !== undefined && state.systems[planet.system]?.homeOf !== undefined) {
    achieve(state, previous, "bam");
  }
  if (name === MECATOL_REX && state.tactical?.player === id) {
    (state.tactical.flags ??= []).push(`mecatol:${id}`);
  }
  openWindow(state, "afterGainControl", { planet: name, player: previous, units: lost });
}

// --- Production ---------------------------------------------------------------

export function afterProducing(
  state: GameState,
  id: PlayerId,
  key: SystemKey,
  units: { type: string; count: number }[],
) {
  openWindow(state, "afterProduce", {
    player: id,
    system: key,
    amount: units.reduce((sum, u) => sum + u.count, 0),
  }, [id]);
}

// --- Status phase -----------------------------------------------------------

/** End of the status phase: Minister of Policy and the Sol flagship. */
export function statusEndEffects(state: GameState) {
  // Gift of Prescience goes home at the end of the status phase.
  for (const id of state.seating) {
    for (const note of [...state.players[id].promissoryNotesInPlay]) {
      if (note.id === "gift") returnNoteInPlay(state, id, note.id, note.owner);
    }
  }
  const minister = lawOwner(state, "minister_policy");
  if (minister !== undefined && !state.players[minister].eliminated) {
    drawActionCards(state, minister, 1);
  }
  for (const id of state.seating) {
    const player = state.players[id];
    if (player.eliminated || player.faction !== "sol") continue;
    const flagship = Object.values(state.systems).find(
      (s) => countOf(s.space[id], "flagship") > 0,
    );
    if (!flagship) continue;
    addUnits(flagship.space, id, "infantry", 1);
    log(state, `${player.name}'s Genesis placed 1 infantry in its system.`, { player: id });
  }
}
