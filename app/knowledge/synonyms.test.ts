import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { canonicalTerms, compileSynonyms, expandShorthand, SynonymList } from "./synonyms";

const synonyms = compileSynonyms(
  JSON.parse(readFileSync("knowledge/synonyms.json", "utf8")) as SynonymList,
);
const terms = (text: string) => canonicalTerms(text, synonyms).sort();

describe("shorthand", () => {
  test("expands what players and hosts say to the canonical terms", () => {
    expect(terms("Take Diplo round one, then get cruiser 2 off a red skip.")).toEqual(
      ["Cruiser II", "Diplomacy", "Warfare technology", "technology specialty"].sort(),
    );
    expect(terms("Spend your CCs and TGs before you grab Rex.")).toEqual(
      ["Mecatol Rex", "command token", "trade goods"].sort(),
    );
    expect(terms("dread two beats a dread")).toEqual(["Dreadnought", "Dreadnought II"]);
  });

  test("leaves ambiguous words alone outside their phrases", () => {
    // "lead" as a verb, colours outside tech talk, Rex already named in full.
    expect(terms("You lead the table. The red player is on Mecatol Rex.")).toEqual([]);
    expect(terms("I would take lead here")).toEqual(["Leadership"]);
  });

  test("adds terms without rewriting the text", () => {
    expect(expandShorthand("Diplo is fine", synonyms)).toBe("Diplo is fine Diplomacy");
    expect(expandShorthand("Diplomacy is fine", synonyms)).toBe("Diplomacy is fine");
  });
});
