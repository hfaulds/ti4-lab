/**
 * Which official content a piece of knowledge holds for, in the engine's
 * terms: the base game is always in play, and each expansion or codex is
 * on or off per game (state.options.expansions). Guide passages and
 * lessons carry a scope, so a game is only told what holds for its
 * content, and every source says which content its games were played with.
 */
import type { Expansion } from "~/game/data/types";

export const EXPANSION_NAMES: Record<Expansion, string> = {
  pok: "Prophecy of Kings",
  codex1: "Codex I",
  codex2: "Codex II",
  codex3: "Codex III",
  codex4: "Codex IV",
  te: "Thunder's Edge",
};
const EXPANSION_IDS = Object.keys(EXPANSION_NAMES) as Expansion[];

export type Scope = {
  /** Content it is about, which must be in play: ["codex1"] for advice on Magen Defense Grid Ω. */
  needs: Expansion[];
  /** Content that replaces what it is about: ["te"] for advice on the base Warfare card. */
  voidedBy: Expansion[];
  /** Which component or version it is about, when the tags alone do not say. */
  note?: string;
};

/** Holds whatever content is in play. */
export const ALL_CONTENT: Scope = { needs: [], voidedBy: [] };

export const holdsIn = (scope: Scope | undefined, expansions: readonly Expansion[]) =>
  !scope ||
  (scope.needs.every((e) => expansions.includes(e)) && !scope.voidedBy.some((e) => expansions.includes(e)));

const names = (list: Expansion[]) => list.map((e) => EXPANSION_NAMES[e]).join(" and ");

/** "needs Codex I", "not with Thunder's Edge", or "" for knowledge that holds everywhere. */
export function scopeLabel(scope: Scope | undefined) {
  if (!scope) return "";
  const parts = [
    ...(scope.needs.length > 0 ? [`needs ${names(scope.needs)}`] : []),
    ...(scope.voidedBy.length > 0 ? [`not with ${names(scope.voidedBy)}`] : []),
  ];
  return [parts.join(", "), scope.note].filter(Boolean).join(": ");
}

/** The content a game or source was played with, for people: "the base game" or "base game with Prophecy of Kings". */
export const contentLabel = (expansions: readonly Expansion[]) =>
  expansions.length === 0 ? "the base game" : `base game with ${names([...expansions])}`;

const isExpansionList = (value: unknown): value is Expansion[] =>
  Array.isArray(value) && value.every((v) => EXPANSION_IDS.includes(v as Expansion));

/** What is wrong with a scope, if anything; `where` starts each message. */
export function scopeProblems(value: unknown, where: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${where}: scope must be an object.`];
  const scope = value as Record<string, unknown>;
  const problems: string[] = [];
  const allowed = EXPANSION_IDS.join(", ");
  if (!isExpansionList(scope.needs)) problems.push(`${where}: scope needs must be a list of ${allowed}.`);
  if (!isExpansionList(scope.voidedBy)) problems.push(`${where}: scope voidedBy must be a list of ${allowed}.`);
  if (scope.note !== undefined && typeof scope.note !== "string") problems.push(`${where}: scope note must be text.`);
  if (isExpansionList(scope.needs) && isExpansionList(scope.voidedBy)) {
    const both = scope.needs.filter((e) => (scope.voidedBy as Expansion[]).includes(e));
    if (both.length > 0) problems.push(`${where}: scope both needs and is voided by ${both.join(", ")}.`);
  }
  return problems;
}

export const expansionListProblems = (value: unknown, where: string) =>
  isExpansionList(value) ? [] : [`${where} must be a list of ${EXPANSION_IDS.join(", ")} ([] for the base game).`];
