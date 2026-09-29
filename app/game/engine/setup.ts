import { factionSystems } from "~/data/systemData";
import { factions } from "~/data/factionData";
import { FactionId, Map as TiMap, PlayerId, Tile } from "~/types";
import {
  actionCards,
  agendas,
  enabledContent,
  explorations,
  ExplorationDeck,
  factionSetupFor,
  isEnabled,
  leadersById,
  objectives,
  promissoryNotes,
  relics,
  resolveTechnology,
  strategyCardsFor,
  technologies,
} from "../data";
import {
  Deck,
  GameError,
  GameOptions,
  GameState,
  PlayerState,
  SystemKey,
  SystemState,
} from "../types";
import {
  CREUSS_GATE_ID,
  MECATOL_REX,
  OFF_BOARD,
  systemInfo,
  WORMHOLE_NEXUS_ID,
} from "./board";
import { addUnits, ask, entries, log, shuffle } from "./helpers";

export type GamePlayerSetup = {
  id: PlayerId;
  name: string;
  faction: FactionId;
  /** Council Keleres only: whose home system they take. */
  factionVariant?: FactionId;
  color?: string;
  /** 0 is the speaker. */
  speakerOrder: number;
};

export type GameSetup = {
  players: GamePlayerSetup[];
  /** Finished draft map; HOME tiles carry the player seated there. */
  map: TiMap;
  options: GameOptions;
  seed: number;
};

export const DEFAULT_COLORS = [
  "Blue",
  "Red",
  "Green",
  "Yellow",
  "Purple",
  "Orange",
  "Black",
  "Magenta",
];

/**
 * Agendas Prophecy of Kings removes from the deck, as the expansion replaces
 * them with exploration cards and relics.
 */
const AGENDAS_REMOVED_BY_POK = [
  "Core Mining",
  "Demilitarized Zone",
  "Holy Planet of Ixth",
  "Research Team: Biotic",
  "Research Team: Cybernetic",
  "Research Team: Propulsion",
  "Research Team: Warfare",
  "Senate Sanctuary",
  "Shard of the Throne",
  "Terraforming Initiative",
  "The Crown of Emphidia",
  "The Crown of Thalnos",
];

const STARTING_POOLS = { tactic: 3, fleet: 3, strategy: 2 };
const OBJECTIVES_PER_STAGE = 5;

/** Checks that a game can be started, returning a reason when it cannot. */
export function setupProblem(setup: GameSetup): string | undefined {
  const { players, options } = setup;
  if (players.length < 3 || players.length > 8) {
    return "A game needs between 3 and 8 players.";
  }
  const usesLeaders = options.expansions.includes("pok");
  for (const expansion of ["codex2", "codex3"] as const) {
    if (options.expansions.includes(expansion) && !usesLeaders) {
      return "Codex II and Codex III need Prophecy of Kings.";
    }
  }
  const taken = new Set<FactionId>();
  for (const player of players) {
    const setupData = factionSetupFor(player.faction, player.factionVariant);
    const name = factions[player.faction]?.name ?? player.faction;
    if (!setupData) {
      return `${name} is not supported yet: only official factions can be played.`;
    }
    if (!isEnabled(setupData.source, options.expansions)) {
      return `${name} needs an expansion that is switched off for this game.`;
    }
    if (taken.has(player.faction)) return `${name} was chosen twice.`;
    taken.add(player.faction);
    const seated = setup.map.some(
      (t) => t.type === "HOME" && t.playerId === player.id,
    );
    if (!seated) return `${player.name} has no home system on the map.`;
  }
  for (const player of players) {
    if (player.faction !== "keleres") continue;
    const variant = player.factionVariant;
    if (!variant) return "Council Keleres must choose a home system.";
    if (taken.has(variant)) {
      return `Council Keleres cannot use the home system of ${factions[variant].name}, who are in the game.`;
    }
  }
  return undefined;
}

const homeSystemFaction = (player: GamePlayerSetup) =>
  player.faction === "keleres" ? player.factionVariant! : player.faction;

/** Clockwise order around the table, judged from where home systems sit. */
function seatingOrder(setup: GameSetup): PlayerId[] {
  const angle = (tile: Tile) => {
    const { x, y } = tile.position;
    // Same projection the map uses; screen y grows downwards.
    return Math.atan2(Math.sqrt(3) * (y + x / 2), 1.5 * x);
  };
  return setup.map
    .filter(
      (t) =>
        t.type === "HOME" &&
        setup.players.some((p) => p.id === t.playerId),
    )
    .sort((a, b) => angle(a) - angle(b))
    .map((t) => (t as Extract<Tile, { type: "HOME" }>).playerId!);
}

function emptySystem(
  key: SystemKey,
  systemId: string,
  onBoard: boolean,
): SystemState {
  return {
    key,
    systemId,
    onBoard,
    planets: systemInfo(systemId)?.planets.map((p) => p.name) ?? [],
    space: {},
    commandTokens: [],
    frontier: false,
    addedWormholes: [],
    inactiveWormholes: [],
  };
}

function deckOf(state: GameState, cards: { id: string }[]): Deck {
  return {
    draw: shuffle(
      state,
      cards.map((c) => c.id),
    ),
    discard: [],
  };
}

export function createGame(setup: GameSetup): GameState {
  const problem = setupProblem(setup);
  if (problem) throw new GameError(problem);

  const { options } = setup;
  const { expansions } = options;
  const usesPok = expansions.includes("pok");
  const speaker = [...setup.players].sort(
    (a, b) => a.speakerOrder - b.speakerOrder,
  )[0];

  const state: GameState = {
    version: 0,
    options,
    round: 1,
    phase: "setup",
    seating: seatingOrder(setup),
    players: {},
    speaker: speaker.id,
    actionsThisTurn: 0,
    tradedWith: [],
    map: [],
    systems: {},
    planets: {},
    custodians: true,
    strategyCards: strategyCardsFor(expansions).map((c) => c.id),
    strategyCardBonus: {},
    decks: {
      actionCards: { draw: [], discard: [] },
      agendas: { draw: [], discard: [] },
      secretObjectives: { draw: [], discard: [] },
      stage1: { draw: [], discard: [] },
      stage2: { draw: [], discard: [] },
      cultural: { draw: [], discard: [] },
      hazardous: { draw: [], discard: [] },
      industrial: { draw: [], discard: [] },
      frontier: { draw: [], discard: [] },
      relics: { draw: [], discard: [] },
    },
    publicObjectives: [],
    laws: [],
    transactions: [],
    prompts: [],
    nextId: 1,
    rng: setup.seed | 0,
    log: [],
  };

  // --- Board ---
  let offBoard = OFF_BOARD;
  const homes = new Map<PlayerId, SystemKey>();
  state.map = setup.map.map((tile): Tile => {
    if (tile.type !== "HOME") return tile;
    const player = setup.players.find((p) => p.id === tile.playerId);
    if (!player) return { idx: tile.idx, position: tile.position, type: "OPEN" };

    const homeId = factionSystems[homeSystemFaction(player)].id;
    if (player.faction === "creuss") {
      // The Creuss home system sits off the board; its gate takes the seat.
      const key = offBoard++;
      state.systems[key] = { ...emptySystem(key, homeId, false), homeOf: player.id };
      homes.set(player.id, key);
      return {
        idx: tile.idx,
        position: tile.position,
        type: "SYSTEM",
        systemId: CREUSS_GATE_ID,
      };
    }
    homes.set(player.id, tile.idx);
    return {
      idx: tile.idx,
      position: tile.position,
      type: "SYSTEM",
      systemId: homeId,
    };
  });

  state.map.forEach((tile, idx) => {
    if (tile.type !== "SYSTEM") return;
    const info = systemInfo(tile.systemId);
    if (!info || info.type === "HYPERLANE") return;
    const system = emptySystem(idx, tile.systemId, true);
    const owner = [...homes.entries()].find(([, key]) => key === idx);
    if (owner) system.homeOf = owner[0];
    state.systems[idx] = system;
  });

  if (usesPok) {
    const key = offBoard++;
    state.systems[key] = {
      ...emptySystem(key, WORMHOLE_NEXUS_ID, false),
      inactiveWormholes: ["ALPHA", "BETA"],
    };
  }

  for (const system of Object.values(state.systems)) {
    for (const name of system.planets) {
      state.planets[name] = {
        name,
        system: system.key,
        exhausted: false,
        units: {},
        attachments: [],
      };
    }
    if (usesPok && system.planets.length === 0 && system.homeOf === undefined) {
      system.frontier = true;
    }
  }
  state.custodians = !!state.planets[MECATOL_REX];

  // --- Common decks ---
  const removedAgendas = usesPok ? AGENDAS_REMOVED_BY_POK : [];
  state.decks.actionCards = deckOf(state, enabledContent(actionCards, expansions));
  state.decks.agendas = deckOf(
    state,
    enabledContent(agendas, expansions).filter(
      (a) => !removedAgendas.includes(a.name),
    ),
  );
  const objectivePool = enabledContent(objectives, expansions);
  state.decks.secretObjectives = deckOf(
    state,
    objectivePool.filter((o) => o.kind === "secret"),
  );
  const stage1 = deckOf(
    state,
    objectivePool.filter((o) => o.kind === "stage1"),
  ).draw.slice(0, OBJECTIVES_PER_STAGE);
  const stage2 = deckOf(
    state,
    objectivePool.filter((o) => o.kind === "stage2"),
  ).draw.slice(0, OBJECTIVES_PER_STAGE);
  state.publicObjectives = [...stage1, ...stage2].map((id, idx) => ({
    id,
    revealed: idx < 2,
    scoredBy: [],
  }));

  if (usesPok) {
    const cards = enabledContent(explorations, expansions);
    for (const deck of [
      "cultural",
      "hazardous",
      "industrial",
      "frontier",
    ] as ExplorationDeck[]) {
      state.decks[deck] = deckOf(
        state,
        cards.filter((c) => c.deck === deck),
      );
    }
    state.decks.relics = deckOf(state, enabledContent(relics, expansions));
  }

  // --- Players ---
  const notes = enabledContent(promissoryNotes, expansions);
  setup.players.forEach((entry, idx) => {
    const data = factionSetupFor(entry.faction, entry.factionVariant)!;
    const home = homes.get(entry.id)!;
    const technologies = data.startingTech
      .map((id) => resolveTechnology(id, expansions)?.id)
      .filter((id): id is string => !!id);

    const player: PlayerState = {
      id: entry.id,
      name: entry.name,
      faction: entry.faction,
      factionVariant: entry.factionVariant,
      color: entry.color ?? DEFAULT_COLORS[idx % DEFAULT_COLORS.length],
      seat: state.seating.indexOf(entry.id),
      home,
      commodities: 0,
      commodityLimit: data.commodities,
      tradeGoods: 0,
      pools: { ...STARTING_POOLS },
      technologies,
      exhaustedTechnologies: [],
      actionCards: [],
      secretObjectives: [],
      scoredSecrets: [],
      promissoryNotes: notes
        .filter((n) => !n.faction || n.faction === entry.faction)
        .map((n) => ({ id: n.id, owner: entry.id })),
      promissoryNotesInPlay: [],
      strategyCards: [],
      leaders: usesPok
        ? data.leaders
            .map((id) => leadersById[id])
            .filter((l) => l && isEnabled(l.source, expansions))
            .map((l) => ({
              id: l.id,
              type: l.type,
              status: l.type === "agent" ? "ready" : "locked",
            }))
        : [],
      relics: [],
      exhaustedRelics: [],
      relicFragments: [],
      breakthrough:
        expansions.includes("te") && data.breakthrough
          ? { id: data.breakthrough, unlocked: false, exhausted: false }
          : undefined,
      passed: false,
      bonusVictoryPoints: 0,
      eliminated: false,
    };
    state.players[entry.id] = player;

    const system = state.systems[home];
    for (const name of system.planets) {
      state.planets[name].controller = entry.id;
    }
    for (const [type, count] of entries(data.startingUnits.space)) {
      addUnits(system.space, entry.id, type, count);
    }
    for (const [name, counts] of Object.entries(data.startingUnits.planets)) {
      const planet = state.planets[name] ?? state.planets[system.planets[0]];
      for (const [type, count] of entries(counts)) {
        if (type === "mech" && !usesPok) continue;
        addUnits(planet.units, entry.id, type, count);
      }
    }
  });

  // --- Opening decisions ---
  const order = state.seating;
  ask(
    state,
    order.flatMap((id) => {
      const player = state.players[id];
      const data = factionSetupFor(player.faction, player.factionVariant)!;
      if (data.startingTechChoices === 0) return [];
      // Factions that name no options choose from every technology that
      // has no prerequisites.
      const listed =
        data.startingTechOptions.length > 0
          ? data.startingTechOptions
          : technologies
              .filter(
                (t) =>
                  !t.faction && !t.unitUpgrade && t.prerequisites.length === 0,
              )
              .map((t) => t.id);
      const options = [
        ...new Set(
          listed
            .map((tech) => resolveTechnology(tech, expansions)?.id)
            .filter((tech): tech is string => !!tech),
        ),
      ];
      const count = Math.min(data.startingTechChoices, options.length);
      if (count === 0) return [];
      return [
        { kind: "chooseStartingTech" as const, player: id, options, count },
      ];
    }),
  );
  ask(
    state,
    order.map((id) => ({
      kind: "chooseSecret" as const,
      player: id,
      options: [
        state.decks.secretObjectives.draw.shift()!,
        state.decks.secretObjectives.draw.shift()!,
      ],
    })),
  );

  log(
    state,
    `The game begins. ${state.players[state.speaker].name} is the speaker.`,
  );
  return state;
}
