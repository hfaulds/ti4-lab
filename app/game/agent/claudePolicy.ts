/**
 * A policy backed by Claude through the Claude Agent SDK, which runs Claude
 * Code and so signs in the way it does: with a Claude subscription login,
 * or ANTHROPIC_API_KEY when that is set. The SDK's own tools are switched
 * off; the model sees only lookup, search_guides and choose, served in
 * process, and our system prompt in place of Claude Code's.
 *
 * Subscription login is for the user's own runs. Anthropic does not allow
 * offering claude.ai login in products built on the SDK, so anything shared
 * should use an API key.
 */
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { SYSTEM_PROMPT } from "./rules";
import { Decision, DecisionRequest, noUsage, Policy, ToolStep, turnMessage } from "./policy";
import { LOOKUP_KINDS, parseChoose, SEARCH_GUIDES_TOOL, TOOLS } from "./tools";

export type ClaudePolicyOptions = {
  /** A model alias such as "haiku", or a full model id. */
  model: string;
  /** Model round trips allowed per decision. */
  maxTurns?: number;
  /** Lookups and searches allowed per decision before only choose works. */
  maxLookups?: number;
  /** How long one decision may take before it is abandoned. */
  timeoutMs?: number;
};

const SERVER = "game";
const toolName = (name: string) => `mcp__${SERVER}__${name}`;
const MAX_LOOKUPS = 10;
const TIMEOUT_MS = 300_000;
/** Claude Code's own tools, none of which a game decision needs. */
const BUILT_IN_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch",
  "NotebookEdit", "Task", "TodoWrite",
];

const describe = (name: string) => TOOLS.find((t) => t.name === name)!.description;
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export class ClaudePolicy implements Policy {
  readonly name: string;

  constructor(private readonly options: ClaudePolicyOptions) {
    this.name = `claude:${options.model}`;
  }

  async decide(request: DecisionRequest): Promise<Decision> {
    const labels = request.menu.map((entry) => entry.label);
    const maxLookups = this.options.maxLookups ?? MAX_LOOKUPS;
    const steps: ToolStep[] = [];
    const shown = new Set<string>();
    let lookups = 0;
    let chosen: Decision | undefined;
    const usage = noUsage();

    const record = (name: string, args: unknown, result: string) => {
      steps.push({ tool: name, arguments: JSON.stringify(args), result });
      return text(result);
    };
    const limited = () => lookups >= maxLookups;

    const tools = [
      tool(
        "lookup",
        describe("lookup"),
        { kind: z.enum(LOOKUP_KINDS), id: z.string() },
        async (args) => {
          if (limited()) return record("lookup", args, "Lookup limit reached for this decision. Call choose now.");
          lookups++;
          return record("lookup", args, request.lookup(args));
        },
      ),
      ...(request.searchGuides
        ? [
            tool(
              "search_guides",
              SEARCH_GUIDES_TOOL.description,
              { query: z.string(), faction: z.string().optional() },
              async (args) => {
                if (limited()) {
                  return record("search_guides", args, "Lookup limit reached for this decision. Call choose now.");
                }
                lookups++;
                const found = request.searchGuides!(args);
                for (const id of found.ids) shown.add(id);
                return record("search_guides", args, found.text);
              },
            ),
          ]
        : []),
      tool(
        "choose",
        describe("choose"),
        {
          candidate: z.string(),
          rationale: z.string(),
          plan_note: z.string(),
          citations: z.array(z.string()).optional(),
        },
        async (args) => {
          if (chosen) return record("choose", args, "Only one choice per decision.");
          const parsed = parseChoose(JSON.stringify(args), labels);
          if (!parsed.ok) return record("choose", args, `Error: ${parsed.error}`);
          chosen = {
            label: parsed.value.candidate,
            rationale: parsed.value.rationale,
            planNote: parsed.value.plan_note,
            citations: parsed.value.citations.filter((id) => shown.has(id)),
            steps,
            usage,
          };
          return record("choose", args, "Move recorded. The decision is over; reply with nothing more.");
        },
      ),
    ];
    const offered = tools.map((t) => toolName(t.name));

    // The game block leads the prompt so it caches across decisions.
    const prompt = [
      request.game,
      "",
      turnMessage(request),
      "",
      // The rules name the tools plainly; the SDK serves them under longer names.
      `The tools the rules call ${tools.map((t) => t.name).join(", ")} are ${offered.join(", ")} here. ` +
        `Use them as the rules describe, then end the decision by calling ${toolName("choose")} once.`,
    ].join("\n");

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.options.timeoutMs ?? TIMEOUT_MS);
    let error: string | undefined;
    try {
      for await (const message of query({
        prompt,
        options: {
          model: this.options.model,
          systemPrompt: SYSTEM_PROMPT,
          mcpServers: { [SERVER]: createSdkMcpServer({ name: SERVER, version: "1.0.0", tools }) },
          tools: [],
          allowedTools: offered,
          disallowedTools: BUILT_IN_TOOLS,
          permissionMode: "dontAsk",
          // No local settings, memory files, skills or claude.ai connectors.
          settingSources: [],
          strictMcpConfig: true,
          persistSession: false,
          maxTurns: this.options.maxTurns ?? maxLookups + 3,
          abortController: abort,
          env: {
            ...process.env,
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
            ENABLE_CLAUDEAI_MCP_SERVERS: "false",
          },
        },
      })) {
        if (message.type !== "result") continue;
        for (const model of Object.values(message.modelUsage)) {
          usage.inputTokens += model.inputTokens + model.cacheReadInputTokens + model.cacheCreationInputTokens;
          usage.cachedInputTokens += model.cacheReadInputTokens;
          usage.outputTokens += model.outputTokens;
        }
        usage.requests += message.num_turns;
        usage.costUsd = (usage.costUsd ?? 0) + message.total_cost_usd;
        if (message.subtype !== "success" && !chosen) error = `Claude stopped: ${message.subtype}.`;
      }
    } catch (thrown) {
      if (!chosen) error = abort.signal.aborted ? "The decision timed out." : String(thrown);
    } finally {
      clearTimeout(timer);
    }
    if (chosen) return chosen;
    return {
      rationale: "",
      planNote: request.planNote,
      citations: [],
      steps,
      usage,
      error: error ?? "Claude did not choose a move.",
    };
  }
}
