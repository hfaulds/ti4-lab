/**
 * Runs the eval cases in evals/cases.json against a policy: each case's
 * decision is rebuilt from its replay log, asked again, and graded by the
 * checks (see app/game/agent/evals.ts).
 *
 *   tsx scripts/eval.ts [--policy first|deepseek|claude] [--model deepseek-flash|haiku]
 *                       [--repeat 3] [--case <id>] [--review] [--cases evals/cases.json]
 *
 * --repeat asks each decision that many times, for a pass rate.
 * --review grades the choice after the review step, as in play: a choice
 * that trips a check is asked again with the warnings.
 * The deepseek policy reads DEEPSEEK_API_KEY from the environment or .env;
 * --policy claude plays through the Claude Agent SDK as agent-play does.
 * The first-candidate policy is free, and shows how the scripted bot fares.
 *
 * Two helpers for making cases:
 *
 *   tsx scripts/eval.ts scan <log.json>
 *     lists every logged choice that trips a check, with the checks each
 *     option on the menu trips;
 *   tsx scripts/eval.ts fixture <log.json> --through <move> --out evals/fixtures/<name>.json.gz
 *     writes the log cut down to what cases up to that move need, gzipped.
 */
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { ClaudePolicy } from "~/game/agent/claudePolicy";
import { CHECKS } from "~/game/agent/checks";
import { EvalResult, loadCases, readLog, runCase, scanLog, trimLog } from "~/game/agent/evals";
import { ChatPolicy, FirstCandidatePolicy, noUsage, Policy } from "~/game/agent/policy";
import { addUsage } from "~/game/agent/review";

/** deepseek-flash prices per million tokens at peak; off-peak is half. */
const PRICES = { cacheMiss: 0.3, cacheHit: 0.006, output: 1.2 };

function option(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const [command, file] = process.argv.slice(2);

if (command === "scan") {
  const log = readLog(file);
  const hits = scanLog(log);
  for (const hit of hits) {
    const d = hit.decision;
    console.log(`move ${d.move}, round ${d.round} ${d.phase}, P${d.player} chose ${hit.chosen.label}. ${hit.chosen.text}`);
    for (const f of hit.fired) console.log(`   ${f.check}: ${f.warning}`);
    const menu = Object.entries(hit.menu).map(([label, ids]) => `${label} ${ids.join("+") || "-"}`);
    console.log(`   options: ${menu.join(", ")}`);
  }
  const counts = CHECKS.map((c) => `${c.id} ${hits.filter((h) => h.fired.some((f) => f.check === c.id)).length}`);
  console.log(`\n${hits.length} choices tripped a check: ${counts.join(", ")}.`);
  process.exit(0);
}

if (command === "fixture") {
  const through = Number(option("through", "NaN"));
  const out = option("out", "");
  if (!Number.isInteger(through) || !out) {
    console.error("Usage: tsx scripts/eval.ts fixture <log.json> --through <move> --out <file.json.gz>");
    process.exit(1);
  }
  const trimmed = JSON.stringify(trimLog(readLog(file), through));
  writeFileSync(out, out.endsWith(".gz") ? gzipSync(trimmed) : trimmed);
  console.log(`Wrote ${out}: actions 0-${through}.`);
  process.exit(0);
}

try {
  process.loadEnvFile();
} catch {
  // No .env file; the environment may still have the key.
}

const policyName = option("policy", "first");
const model = option("model", policyName === "claude" ? "haiku" : "deepseek-flash");
let policy: Policy;
if (policyName === "first") {
  policy = new FirstCandidatePolicy();
} else if (policyName === "claude") {
  policy = new ClaudePolicy({ model });
} else {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error("Set DEEPSEEK_API_KEY (in the environment or .env), or use --policy first.");
    process.exit(1);
  }
  policy = new ChatPolicy({ model, apiKey, baseURL: "https://api.deepseek.com" });
}

const repeat = Number(option("repeat", "1"));
const only = option("case", "");
const { cases, logFor } = loadCases(option("cases", "evals/cases.json"));
const chosen = cases.filter((c) => !only || c.id === only);
if (chosen.length === 0) {
  console.error(`No case ${only}.`);
  process.exit(1);
}

console.log(`${chosen.length} cases, ${repeat} each, policy ${policy.name}${flag("review") ? ", with review" : ""}.`);
const results: EvalResult[] = [];
const usage = noUsage();
for (const evalCase of chosen) {
  const result = await runCase(evalCase, logFor(evalCase), policy, { repeat, review: flag("review") });
  results.push(result);
  addUsage(usage, result.usage);
  console.log(`\n${evalCase.id}: ${result.passes}/${result.runs.length} pass. ${evalCase.description}`);
  if (result.logged) {
    const verdict = result.logged.grade ? (result.logged.grade.pass ? "passes" : "fails") : "is no longer on the menu";
    console.log(`   logged: ${result.logged.label}. ${result.logged.text} (${verdict})`);
  }
  if (result.drift.length) console.log(`   ${result.drift.length} logged menu lines read differently now`);
  for (const run of result.runs) {
    const mark = run.grade?.pass ? "pass" : "FAIL";
    console.log(`   ${mark} ${run.label ?? "-"}. ${run.text ?? run.error ?? ""}`);
    for (const reason of run.grade?.reasons ?? []) console.log(`      ${reason}`);
    if (run.review) console.log(`      reviewed: ${run.review.kept ? "kept" : `changed from ${run.review.first}`}. ${run.review.rationale}`);
    if (run.rationale && policyName !== "first") console.log(`      ${run.rationale}`);
  }
}

const runs = results.reduce((n, r) => n + r.runs.length, 0);
const passes = results.reduce((n, r) => n + r.passes, 0);
const cost =
  usage.costUsd ??
  ((usage.inputTokens - usage.cachedInputTokens) * PRICES.cacheMiss +
    usage.cachedInputTokens * PRICES.cacheHit +
    usage.outputTokens * PRICES.output) /
    1e6;
console.log(
  `\n${passes}/${runs} runs pass (${runs ? Math.round((passes / runs) * 100) : 0}%); ` +
    `${results.filter((r) => r.passes === r.runs.length).length}/${results.length} cases pass every run. ` +
    `Tokens: ${usage.inputTokens} in (${usage.cachedInputTokens} cached), ${usage.outputTokens} out; about $${cost.toFixed(3)}.`,
);
