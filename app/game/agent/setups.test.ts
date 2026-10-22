import { describe, expect, test } from "vitest";
import { testGame } from "../engine/testing";
import { sliceOf } from "./reach";
import { draftedSetupFor } from "./setups";

describe("drafted setups", () => {
  test("deal six Milty slices of base-game systems, the same for the same seed", () => {
    for (const seed of [1, 2, 3]) {
      const setup = draftedSetupFor(seed);
      expect(draftedSetupFor(seed)).toEqual(setup);
      const systems = setup.map.flatMap((tile) => (tile.type === "SYSTEM" ? [tile.systemId] : []));
      const outer = systems.filter((id) => id !== "18");
      // Thirty of the 32 base blue and red systems, each once.
      expect(outer).toHaveLength(30);
      expect(new Set(outer).size).toBe(30);
      expect(outer.every((id) => Number(id) >= 19 && Number(id) <= 50)).toBe(true);

      const state = testGame({ seed, ...setup });
      expect(state.seating).toHaveLength(6);
      for (const id of state.seating) expect(state.systems[state.players[id].home]).toBeDefined();
    }
  });

  test("give each seat its own slice of four systems and an equidistant", () => {
    const state = testGame({ seed: 2, ...draftedSetupFor(2) });
    const all: number[] = [];
    for (const id of state.seating) {
      const { own, equidistant } = sliceOf(state, id);
      expect(own).toHaveLength(4);
      expect(equidistant).toHaveLength(1);
      all.push(...own, ...equidistant);
    }
    // Six seats, five systems each, none shared: the whole Milty map but Mecatol.
    expect(new Set(all).size).toBe(30);
  });
});
