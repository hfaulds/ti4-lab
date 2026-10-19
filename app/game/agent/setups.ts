/**
 * Seeded game setups for bot and agent games: six of the 17 base factions in
 * random seats, on a random layout of the base-game systems.
 */
import { FactionId } from "~/types";
import { testMap } from "../engine/testing";

export const BASE_FACTIONS: FactionId[] = [
  "arborec", "barony", "creuss", "hacan", "jolnar", "l1z1x", "mentak",
  "muaat", "naalu", "nekro", "saar", "sardakk", "sol", "winnu", "xxcha",
  "yin", "yssaril",
];
/** Base-game blue and red systems. */
const SYSTEMS = Array.from({ length: 30 }, (_, i) => String(19 + i));

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
