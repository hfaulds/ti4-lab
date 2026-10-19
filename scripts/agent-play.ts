/**
 * Plays one game with an agent seat against scripted bots and writes the
 * replay log to games/.
 *
 *   tsx scripts/agent-play.ts [--seed 1] [--seat 0] [--policy deepseek|first]
 *                             [--model deepseek-flash] [--quiet]
 *                             [--spectate] [--server http://localhost:3000] [--pace 300]
 *                             [--no-knowledge]
 *
 * The deepseek policy reads DEEPSEEK_API_KEY from the environment or .env.
 * --spectate saves the game to the web app's database (TI4_LAB_DATABASE_PATH)
 * and plays every move through the running app, so it can be watched live.
 * The app's copy counts: each move waits until the app accepts it, the game
 * pauses while the app is down, and it stops if the app disagrees. --pace
 * waits that many milliseconds between moves.
 *
 * The agent can search the strategy guides in knowledge/knowledge.db when it
 * has been built (tsx scripts/kb.ts index); --no-knowledge plays without them.
 *
 * Each decision is printed with the tools the agent called, and appended to
 * a .decisions.jsonl file in games/ as it is made, so a game stopped early
 * still leaves its decisions behind.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { playAgentGame } from "~/game/agent/harness";
import { ChatPolicy, FirstCandidatePolicy, Policy } from "~/game/agent/policy";
import { setupFor } from "~/game/agent/setups";
import { testGame } from "~/game/engine/testing";
import { KnowledgeBase, openKnowledgeBase } from "~/knowledge/search";
import { SynonymList } from "~/knowledge/synonyms";

/** deepseek-flash prices per million tokens at peak; off-peak is half. */
const PRICES = { cacheMiss: 0.3, cacheHit: 0.006, output: 1.2 };

function option(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

try {
  process.loadEnvFile();
} catch {
  // No .env file; the environment may still have the key.
}

const seed = Number(option("seed", "1"));
const seat = Number(option("seat", "0"));
const policyName = option("policy", "deepseek");
const model = option("model", "deepseek-flash");

let policy: Policy;
if (policyName === "first") {
  policy = new FirstCandidatePolicy();
} else {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error("Set DEEPSEEK_API_KEY (in the environment or .env), or use --policy first.");
    process.exit(1);
  }
  policy = new ChatPolicy({ model, apiKey, baseURL: "https://api.deepseek.com" });
}

// Names show in the web app and in the game log.
const state = structuredClone(testGame({ seed, ...setupFor(seed) }));
for (const player of Object.values(state.players)) {
  player.name = player.id === seat ? `Agent (${policy.name})` : `Bot ${player.id}`;
}
console.log(
  `Seed ${seed}: agent is P${seat} (${state.players[seat].faction}); ` +
    `others ${state.seating.filter((id) => id !== seat).map((id) => state.players[id].faction).join(", ")}.`,
);

let onMove: Parameters<typeof playAgentGame>[0]["onMove"];
if (flag("spectate")) {
  // Imported late: the database module needs the environment loaded above.
  const { startSpectating } = await import("~/game/agent/spectate.server");
  const spectating = await startSpectating(state, {
    server: option("server", "http://localhost:3000"),
    paceMs: Number(option("pace", "300")),
  });
  onMove = spectating.onMove;
  console.log(`Watch: ${spectating.url} (pick seat P${seat} in the page to see the agent's hand)`);
}

const KNOWLEDGE = "knowledge/knowledge.db";
let knowledge: KnowledgeBase | undefined;
if (!flag("no-knowledge") && policyName !== "first") {
  if (existsSync(KNOWLEDGE)) {
    const synonyms = JSON.parse(readFileSync("knowledge/synonyms.json", "utf8")) as SynonymList;
    knowledge = openKnowledgeBase(KNOWLEDGE, synonyms);
  } else {
    console.log(`No ${KNOWLEDGE}, so the agent plays without the strategy guides.`);
  }
}

mkdirSync("games", { recursive: true });
const live = `games/${new Date().toISOString().replace(/[:.]/g, "-")}-seed${seed}-p${seat}.decisions.jsonl`;
console.log(`Decisions: ${live}`);

/** One line for a tool call: what was asked, and what came back in brief. */
function describeStep(step: { tool: string; arguments: string; result: string }) {
  if (step.tool === "choose") return undefined;
  const ids = [...step.result.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]);
  const brief = ids.length > 0 ? ids.join(", ") : step.result.split("\n")[0].slice(0, 100);
  return `   ${step.tool} ${step.arguments} -> ${brief}`;
}

const log = await playAgentGame({
  state,
  seed,
  agentSeats: [seat],
  policy,
  knowledge,
  onMove,
  onDecision: (record) => {
    appendFileSync(live, `${JSON.stringify(record)}\n`);
    if (flag("quiet") || record.forced) return;
    const chosen = record.menu.find((m) => m.label === record.chosen);
    const tag = record.fallback ? ` [fallback: ${record.error ?? "no choice"}]` : "";
    console.log(`r${record.round} ${record.phase} ${record.chosen}. ${chosen?.text}${tag}`);
    for (const step of record.steps) {
      const line = describeStep(step);
      if (line) console.log(line);
    }
    if (record.rationale) console.log(`   ${record.rationale}`);
    for (const citation of record.citations) console.log(`   cites ${citation}`);
  },
});
knowledge?.close();

const decisions = log.decisions.filter((d) => !d.forced);
const total = decisions.reduce(
  (sum, d) => ({
    input: sum.input + d.usage.inputTokens,
    cached: sum.cached + d.usage.cachedInputTokens,
    output: sum.output + d.usage.outputTokens,
    requests: sum.requests + d.usage.requests,
    retries: sum.retries + (d.usage.retries ?? 0),
  }),
  { input: 0, cached: 0, output: 0, requests: 0, retries: 0 },
);
const cost =
  ((total.input - total.cached) * PRICES.cacheMiss +
    total.cached * PRICES.cacheHit +
    total.output * PRICES.output) /
  1e6;

const file = `games/${log.startedAt.replace(/[:.]/g, "-")}-seed${seed}-p${seat}.json`;
writeFileSync(file, JSON.stringify(log, null, 2));

console.log(
  `\nGame ${log.result.phase} in round ${log.result.round}; winner ${log.result.winner !== undefined ? `P${log.result.winner}` : "none"}; ` +
    `VP ${log.result.vp.join("/")} (agent P${seat}: ${log.result.vp[seat]}).`,
);
console.log(
  `${decisions.length} agent decisions, ${decisions.filter((d) => d.fallback).length} fallbacks, ` +
    `${total.requests} requests (${total.retries} retried). Tokens: ${total.input} in (${total.cached} cached), ${total.output} out; ` +
    `about $${cost.toFixed(3)} at peak prices.`,
);
console.log(`Replay log: ${file}`);
