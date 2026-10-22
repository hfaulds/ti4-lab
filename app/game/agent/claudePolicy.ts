/**
 * A policy backed by Claude through the Claude Agent SDK, which runs Claude
 * Code and so signs in the way it does: with a Claude subscription login,
 * or ANTHROPIC_API_KEY when that is set. The SDK's own tools are switched
 * off; the model sees only lookup, search_guides, search_lessons and
 * choose, served in process, and our system prompt in place of Claude Code's.
 *
 * Subscription login is for the user's own runs. Anthropic does not allow
 * offering claude.ai login in products built on the SDK, so anything shared
 * should use an API key.
 */
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { SYSTEM_PROMPT } from "./rules";
import {
  Decision,
  DecisionRequest,
  MAX_LOOKUPS,
  noUsage,
  Plan,
  planFrom,
  PLANNING_REQUEST,
  Policy,
  ToolStep,
  turnMessage,
  Usage,
} from "./policy";
import { LOOKUP_KINDS, parseChoose, SEARCH_GUIDES_TOOL, SEARCH_LESSONS_TOOL, TOOLS } from "./tools";

export type ClaudePolicyOptions = {
  /** A model alias such as "haiku", or a full model id. */
  model: string;
  /** Model round trips allowed per decision. */
  maxTurns?: number;
  /** Lookups and searches allowed per decision before only choose works. */
  maxLookups?: number;
  /** How long one call may take before it is abandoned; by default, no limit. */
  timeoutMs?: number;
};

const SERVER = "game";
const toolName = (name: string) => `mcp__${SERVER}__${name}`;
/** Claude Code's own tools, none of which a game decision needs. */
const BUILT_IN_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch",
  "NotebookEdit", "Task", "TodoWrite",
];

const describe = (name: string) => TOOLS.find((t) => t.name === name)!.description;
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/** A tool as the SDK's in-process server takes it, whatever its arguments. */
type GameTool = NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]>[number];

/** What one call to Claude did: its usage, final text and any error. */
type Run = { usage: Usage; result: string; error?: string };

export class ClaudePolicy implements Policy {
  readonly name: string;

  constructor(private readonly options: ClaudePolicyOptions) {
    this.name = `claude:${options.model}`;
  }

  async decide(request: DecisionRequest): Promise<Decision> {
    const labels = request.menu.map((entry) => entry.label);
    const steps: ToolStep[] = [];
    const shown = new Set<string>(request.briefing?.ids);
    let chosen: Decision | undefined;
    const usage = noUsage();

    const tools = [
      ...this.lookupTools(request, steps, shown, "Call choose now."),
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
          const record = (result: string) => {
            steps.push({ tool: "choose", arguments: JSON.stringify(args), result });
            return text(result);
          };
          if (chosen) return record("Only one choice per decision.");
          const parsed = parseChoose(JSON.stringify(args), labels);
          if (!parsed.ok) return record(`Error: ${parsed.error}`);
          chosen = {
            label: parsed.value.candidate,
            rationale: parsed.value.rationale,
            planNote: parsed.value.plan_note,
            citations: parsed.value.citations.filter((id) => shown.has(id)),
            steps,
            usage,
          };
          return record("Move recorded. The decision is over; reply with nothing more.");
        },
      ),
    ];

    // The game block leads the prompt so it caches across decisions.
    const prompt = [
      request.game,
      "",
      turnMessage(request),
      "",
      this.toolNames(tools),
      `End the decision by calling ${toolName("choose")} once.`,
    ].join("\n");

    const run = await this.run(prompt, tools, () => chosen !== undefined);
    Object.assign(usage, run.usage);
    if (chosen) return chosen;
    return {
      rationale: "",
      planNote: request.planNote,
      citations: [],
      steps,
      usage,
      error: run.error ?? "Claude did not choose a move.",
    };
  }

  async plan(request: DecisionRequest): Promise<Plan> {
    const steps: ToolStep[] = [];
    const shown = new Set<string>(request.briefing?.ids);
    const tools = this.lookupTools(request, steps, shown, "Write your plan now.");
    const prompt = [
      request.game,
      "",
      turnMessage(request),
      "",
      PLANNING_REQUEST,
      "",
      this.toolNames(tools),
    ].join("\n");
    const run = await this.run(prompt, tools, () => false);
    if (!run.result.trim()) {
      return { text: "", citations: [], steps, usage: run.usage, error: run.error ?? "No plan was written." };
    }
    return { ...planFrom(run.result, shown), steps, usage: run.usage };
  }

  /** The lookup and search tools, recording their calls and the passages shown. */
  private lookupTools(
    request: DecisionRequest,
    steps: ToolStep[],
    shown: Set<string>,
    whenSpent: string,
  ): GameTool[] {
    const maxLookups = this.options.maxLookups ?? MAX_LOOKUPS;
    let lookups = 0;
    const record = (name: string, args: unknown, result: string) => {
      steps.push({ tool: name, arguments: JSON.stringify(args), result });
      return text(result);
    };
    const spent = `Lookup limit reached for this decision. ${whenSpent}`;
    return [
      tool("lookup", describe("lookup"), { kind: z.enum(LOOKUP_KINDS), id: z.string() }, async (args) => {
        if (lookups >= maxLookups) return record("lookup", args, spent);
        lookups++;
        return record("lookup", args, request.lookup(args));
      }),
      ...(request.searchGuides
        ? [
            tool(
              "search_guides",
              SEARCH_GUIDES_TOOL.description,
              { query: z.string(), faction: z.string().optional() },
              async (args) => {
                if (lookups >= maxLookups) return record("search_guides", args, spent);
                lookups++;
                const found = request.searchGuides!(args);
                for (const id of found.ids) shown.add(id);
                return record("search_guides", args, found.text);
              },
            ),
          ]
        : []),
      ...(request.searchLessons
        ? [
            tool("search_lessons", SEARCH_LESSONS_TOOL.description, { query: z.string() }, async (args) => {
              if (lookups >= maxLookups) return record("search_lessons", args, spent);
              lookups++;
              const found = request.searchLessons!(args);
              for (const id of found.ids) shown.add(id);
              return record("search_lessons", args, found.text);
            }),
          ]
        : []),
    ];
  }

  /** The rules name the tools plainly; the SDK serves them under longer names. */
  private toolNames(tools: GameTool[]) {
    return (
      `The tools the rules call ${tools.map((t) => t.name).join(", ")} are ` +
      `${tools.map((t) => toolName(t.name)).join(", ")} here. Use them as the rules describe.`
    );
  }

  /** One Claude call with only the given tools, stopped by the timeout. */
  private async run(prompt: string, tools: GameTool[], done: () => boolean): Promise<Run> {
    const usage = noUsage();
    const maxLookups = this.options.maxLookups ?? MAX_LOOKUPS;
    const offered = tools.map((t) => toolName(t.name));
    const abort = new AbortController();
    // No limit unless asked for: the harness waits out sleeps and outages.
    const timer =
      this.options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => abort.abort(), this.options.timeoutMs);
    let result = "";
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
        if (message.subtype === "success") result = message.result;
        else if (!done()) error = `Claude stopped: ${message.subtype}.`;
      }
    } catch (thrown) {
      if (!done()) error = abort.signal.aborted ? "The decision timed out." : String(thrown);
    } finally {
      clearTimeout(timer);
    }
    return { usage, result, error };
  }
}
