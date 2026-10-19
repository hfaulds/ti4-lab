/**
 * Saves a replay log from scripts/agent-play.ts to the web app's database
 * (TI4_LAB_DATABASE_PATH), with the agent's reasoning for each of its moves,
 * so the game can be stepped through on its page.
 *
 *   tsx --env-file=.env scripts/import-game.ts games/<log>.json [--server http://localhost:3000]
 *
 * Logs written before the starting state was recorded are rebuilt from their
 * seed, which only works while the game setup and engine still match.
 */
import { readFileSync } from "node:fs";
import { moveNote, ReplayLog } from "~/game/agent/harness";
import { setupFor } from "~/game/agent/setups";
import { testGame } from "~/game/engine/testing";
import { GameHistory } from "~/game/history";

function option(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("Usage: tsx scripts/import-game.ts games/<log>.json");
  process.exit(1);
}
const log = JSON.parse(readFileSync(file, "utf8")) as ReplayLog;

let initial = log.initialState;
if (!initial) {
  if (log.seed === undefined) {
    console.error("This log has neither a starting state nor a seed.");
    process.exit(1);
  }
  // As scripts/agent-play.ts set the game up.
  initial = structuredClone(testGame({ seed: log.seed, ...setupFor(log.seed) }));
  for (const player of Object.values(initial.players)) {
    player.name = log.agentSeats.includes(player.id)
      ? `Agent (${log.policy})`
      : `Bot ${player.id}`;
  }
  console.log(`No starting state in the log; rebuilt it from seed ${log.seed}.`);
}

// The agent's reasoning goes with the move each decision chose.
const decisions = new Map(log.decisions.map((record) => [record.move, record]));
const history = new GameHistory(initial);
try {
  history.extend(
    log.actions.map((move, index) => {
      const decision = decisions.get(index);
      return {
        ...move,
        version: initial.version + index + 1,
        note: decision && moveNote(decision),
      };
    }),
  );
} catch (error) {
  console.error(
    `The log does not replay: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
}

// Imported late: the database module needs the environment.
const { createSavedGame } = await import("~/drizzle/game.server");
const { urlName } = await createSavedGame(initial, undefined, {
  moves: history.moves,
  state: history.latest,
});
const server = option("server", "http://localhost:3000").replace(/\/$/, "");
console.log(
  `Imported ${history.moves.length} moves (round ${history.latest.round}, ${history.latest.phase}).`,
);
console.log(`Watch: ${server}/game/${urlName}`);
