/**
 * Seeded game setups for bot and agent games: six of the 17 base factions in
 * random seats, on either a random layout of the base-game systems or a
 * Milty draft map like those played competitively.
 */
import { miltySystemTiers } from "~/data/miltyTileTiers";
import { systemData } from "~/data/systemData";
import { coreGenerateSlices, postProcessSlices } from "~/draft/common/sliceGenerator";
import { draftConfig } from "~/draft/draftConfig";
import { isAlpha, isBeta } from "~/draft/helpers/sliceGeneration";
import { SLICE_SHAPES } from "~/draft/sliceShapes";
import { TieredSlice } from "~/draft/types";
import { valueSlice } from "~/stats";
import { FactionId, PlayerId, SystemId } from "~/types";
import { generateEmptyMap, hydrateMap } from "~/utils/map";
import { systemIdsToSlices } from "~/utils/slice";
import { testMap } from "../engine/testing";

export const BASE_FACTIONS: FactionId[] = [
  "arborec", "barony", "creuss", "hacan", "jolnar", "l1z1x", "mentak",
  "muaat", "naalu", "nekro", "saar", "sardakk", "sol", "winnu", "xxcha",
  "yin", "yssaril",
];
/** Base-game blue and red systems, enough to fill a random six-player map. */
const SYSTEMS = Array.from({ length: 30 }, (_, i) => String(19 + i));
/** Every base-game blue (19-38) and red (39-50) system, for drafting from. */
const BASE_SYSTEMS = Array.from({ length: 32 }, (_, i) => String(19 + i));

/** mulberry32: a small integer generator, exact in JavaScript numbers. */
function generator(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Six factions in random seats and a random layout of systems for a seed. */
export function setupFor(seed: number) {
  const random = generator(seed);
  return {
    factions: shuffled(BASE_FACTIONS, random).slice(0, 6),
    map: testMap(6, shuffled(SYSTEMS, random)),
  };
}

/**
 * Milty's usual recipe is a high, medium and low blue tile and two reds per
 * slice, but the base game has only five medium tiles, so one slice gets a
 * second high in place of its medium.
 */
const BASE_SLICE_TIERS: TieredSlice[] = [
  ...Array.from({ length: 5 }, (): TieredSlice => ["high", "med", "low", "red", "red"]),
  ["high", "high", "low", "red", "red"],
];

/** Candidate slice sets per seed; the most even one is kept. */
const CANDIDATES = 40;

/** Six Milty slices from the base-game systems, as even in value as found. */
function baseGameSlices() {
  let best: { slices: SystemId[][]; spread: number } | undefined;
  for (let i = 0; i < CANDIDATES; i++) {
    let next = 0;
    const slices = coreGenerateSlices({
      sliceCount: 6,
      sliceShape: SLICE_SHAPES.milty,
      systemTiers: miltySystemTiers,
      availableSystems: BASE_SYSTEMS,
      config: { numAlphas: 2, numBetas: 2, minLegendaries: 0, maxLegendaries: 0 },
      mecatolPath: draftConfig.milty.mecatolPathSystemIndices,
      centerTile: 1,
      getSliceTiers: () => BASE_SLICE_TIERS[next++],
      // Both alphas and both betas are in play; one of each per slice at most.
      validateSystems: () => true,
      validateSlice: (slice) => {
        const systems = slice.map((id) => systemData[id]);
        return systems.filter(isAlpha).length <= 1 && systems.filter(isBeta).length <= 1;
      },
      postProcessSlices,
    });
    if (!slices) continue;
    const values = slices.map((slice) => valueSlice(slice.map((id) => systemData[id])));
    const spread = Math.max(...values) - Math.min(...values);
    if (!best || spread < best.spread) best = { slices, spread };
  }
  return best?.slices;
}

/**
 * A seeded Milty draft with base-game systems only: the app's slice
 * generator makes six slices (wormholes spread, a safe path to Mecatol Rex,
 * anomalies apart), the most even of several candidates is kept, and each
 * seat is dealt a faction and a slice. Players do not choose; this stands
 * in for a finished draft.
 */
export function draftedSetupFor(seed: number) {
  const random = generator(seed);
  const factions = shuffled(BASE_FACTIONS, random).slice(0, 6);
  const config = draftConfig.milty;
  // The draft code draws from Math.random; seed it for this call only.
  const unseeded = Math.random;
  Math.random = random;
  try {
    const raw = baseGameSlices();
    if (!raw) throw new Error(`No Milty slices for seed ${seed}.`);
    const slices = systemIdsToSlices(config, raw);
    const order = shuffled(slices.map((_, i) => i), random);
    const selections = order.map((sliceIdx, seat) => ({
      playerId: seat as PlayerId,
      seatIdx: seat,
      sliceIdx,
    }));
    return { factions, map: hydrateMap(config, generateEmptyMap(config), slices, selections) };
  } finally {
    Math.random = unseeded;
  }
}
