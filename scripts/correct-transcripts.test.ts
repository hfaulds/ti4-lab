import { describe, expect, test } from "vitest";
import { correct } from "./correct-transcripts";

const words = (text: string) =>
  text.split(" ").map((word, i) => [i, i + 0.5, word, 0.9] as [number, number, string, number]);
const aliases = [
  { from: "Mechatol", to: "Mecatol" },
  { from: "Joel Narr", to: "Jol-Nar" },
  { from: "Narr", to: "N'orr", after: "Sardakk" },
  { from: "Sardak", to: "Sardakk" },
];

describe("transcript correction", () => {
  test("keeps punctuation and timings, and spans multi-word names", () => {
    const { words: out, counts } = correct(words("take (Mechatol), then Joel Narr builds."), aliases);
    expect(out.map((w) => w[2]).join(" ")).toBe("take (Mecatol), then Jol-Nar builds.");
    // "Joel Narr" covered words 3 and 4.
    expect(out[3]).toEqual([3, 4.5, "Jol-Nar", 0.9]);
    expect(counts).toEqual({ "Mechatol -> Mecatol": 1, "Joel Narr -> Jol-Nar": 1 });
  });

  test("leaves names broken by a sentence end, and respects `after`", () => {
    const text = (s: string) => correct(words(s), aliases).words.map((w) => w[2]).join(" ");
    expect(text("ask Joel. Narr said")).toBe("ask Joel. Narr said");
    expect(text("Sardak Narr is strong; Narr alone is not")).toBe(
      "Sardakk N'orr is strong; Narr alone is not",
    );
  });
});
