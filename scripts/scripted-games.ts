/**
 * Plays scripted-bot games on fixed seeds and reports how they ended, for
 * the Phase 1 acceptance criteria in docs/agent-play-plan.md.
 *
 *   tsx scripts/scripted-games.ts [games=20] [firstSeed=1]
 */
import { scriptedMove, SCRIPTED_BOT_VERSION } from "~/game/agent/scriptedBot";
import { setupFor } from "~/game/agent/setups";
import { victoryPoints } from "~/game/engine/control";
import { play, testGame } from "~/game/engine/testing";
import { GameState } from "~/game/types";

const MOVE_BUDGET = 20000;

type Result = {
  seed: number;
  byVictoryPoints: boolean;
  round: number;
  winnerVp: number;
  winner?: number;
  vp: number[];
  moves: number;
  fallbacks: Record<string, number>;
  /** Highest VP at the end of each round, from round 1. */
  leaderByRound: number[];
  ms: number;
};

function playGame(seed: number): Result {
  const started = Date.now();
  let state: GameState = testGame({ seed, ...setupFor(seed) });
  const fallbacks: Record<string, number> = {};
  const leaderByRound: number[] = [];
  const leader = () => Math.max(...state.seating.map((id) => victoryPoints(state, id)));
  let moves = 0;
  for (; moves < MOVE_BUDGET; moves++) {
    const move = scriptedMove(state);
    if (!move) break;
    const round = state.round;
    if (move.fallback) {
      fallbacks[move.action.type] = (fallbacks[move.action.type] ?? 0) + 1;
    }
    state = play(state, move.player, move.action);
    if (state.round > round) leaderByRound[round - 1] = leader();
  }
  leaderByRound[state.round - 1] = leader();
  const vp = state.seating.map((id) => victoryPoints(state, id));
  const winnerVp = state.winner !== undefined ? victoryPoints(state, state.winner) : 0;
  return {
    seed,
    byVictoryPoints: winnerVp >= state.options.victoryPoints,
    round: state.round,
    winnerVp,
    winner: state.winner,
    vp,
    moves,
    fallbacks,
    leaderByRound,
    ms: Date.now() - started,
  };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const games = Number(process.argv[2] ?? 20);
const firstSeed = Number(process.argv[3] ?? 1);
const results: Result[] = [];
for (let seed = firstSeed; seed < firstSeed + games; seed++) {
  const result = playGame(seed);
  results.push(result);
  console.log(
    `seed ${seed}: round ${result.round}, ${result.byVictoryPoints ? "VP win" : "no VP win"}, ` +
      `VP ${result.vp.join("/")}, ${result.moves} moves, ${result.ms} ms` +
      (Object.keys(result.fallbacks).length > 0
        ? `, fallbacks ${JSON.stringify(result.fallbacks)}`
        : ""),
  );
}

const won = results.filter((r) => r.byVictoryPoints);
const winsBySeat = Array.from({ length: 6 }, (_, seat) =>
  results.filter((r) => r.winner === seat).length,
);
const fallbacks = results.reduce(
  (sum, r) => sum + Object.values(r.fallbacks).reduce((a, b) => a + b, 0),
  0,
);
const moves = results.reduce((sum, r) => sum + r.moves, 0);
console.log(`\nscripted bot v${SCRIPTED_BOT_VERSION}, ${games} games`);
console.log(`ended by VP: ${won.length}/${games}`);
console.log(`median round of a VP win: ${won.length ? median(won.map((r) => r.round)) : "-"}`);
console.log(`median winner VP: ${median(results.map((r) => r.winnerVp))}`);
const rounds = Math.max(...results.map((r) => r.leaderByRound.length));
const leaderLine = Array.from({ length: rounds }, (_, i) => {
  // A finished game keeps its final score for later rounds.
  const values = results.map((r) => r.leaderByRound[Math.min(i, r.leaderByRound.length - 1)]);
  return `r${i + 1} ${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)}`;
}).join("  ");
console.log(`mean leader VP by round: ${leaderLine}`);
console.log(`wins by seat: ${winsBySeat.join("/")}`);
console.log(`fallback rate: ${((100 * fallbacks) / moves).toFixed(2)}% of ${moves} moves`);
