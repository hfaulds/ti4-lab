/**
 * Shorthand for game terms ("Diplo", "cruiser 2", "CCs"), expanded to the
 * canonical terms they stand for so search matches either form. The list
 * lives in knowledge/synonyms.json.
 */
export type Synonym = { pattern: string; means: string };
export type SynonymList = { version: number; synonyms: Synonym[] };

type Compiled = { pattern: RegExp; means: string };

export function compileSynonyms(list: SynonymList): Compiled[] {
  return list.synonyms.map((s) => ({ pattern: new RegExp(s.pattern, "gi"), means: s.means }));
}

/** The canonical terms whose shorthand appears in `text`, each once. */
export function canonicalTerms(text: string, synonyms: Compiled[]): string[] {
  const found = new Set<string>();
  for (const { pattern, means } of synonyms) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) found.add(means);
  }
  return [...found];
}

/** `text` with the canonical terms for any shorthand in it added at the end. */
export function expandShorthand(text: string, synonyms: Compiled[]): string {
  const terms = canonicalTerms(text, synonyms);
  return terms.length > 0 ? `${text} ${terms.join(" ")}` : text;
}
