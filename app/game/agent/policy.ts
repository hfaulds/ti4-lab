/**
 * Policies choose a move from a menu. The harness does not care which model
 * (if any) is behind one, so the model and provider are configuration.
 */
import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./rules";
import {
  LookupArgs,
  parseChoose,
  parseLookup,
  parseSearch,
  SEARCH_GUIDES_TOOL,
  SearchArgs,
  TOOLS,
} from "./tools";

export type MenuEntry = { label: string; text: string };

export type DecisionRequest = {
  /** Facts that hold all game, sent first so they can be cached. */
  game: string;
  /** The position this turn, from the seat's point of view. */
  turn: string;
  /** What the agent wrote for itself at its previous decision. */
  planNote: string;
  menu: MenuEntry[];
  lookup: (args: LookupArgs) => string;
  /**
   * Searches the strategy guides, returning text for the model and the
   * passage ids in it. Absent when there is no knowledge base, in which
   * case the tool is not offered.
   */
  searchGuides?: (args: SearchArgs) => { text: string; ids: string[] };
  /** Guide passages searched before asking, with their ids for citing. */
  briefing?: { text: string; ids: string[] };
};

export type ToolStep = { tool: string; arguments: string; result: string };

export type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  requests: number;
  /** Requests sent again after a timeout or a dropped connection. */
  retries: number;
  /** Cost the provider reports, where it does; otherwise worked out from tokens. */
  costUsd?: number;
};

export type Decision = {
  /** The chosen menu label, or undefined if the policy failed to choose. */
  label?: string;
  rationale: string;
  planNote: string;
  /** Guide passage ids the agent cited; only ones it was shown. */
  citations: string[];
  steps: ToolStep[];
  usage: Usage;
  error?: string;
};

/** A planning call's result: the agent's plan, in its own words. */
export type Plan = {
  text: string;
  /** Guide passages the plan cites by id, among those it was shown. */
  citations: string[];
  steps: ToolStep[];
  usage: Usage;
  error?: string;
};

export interface Policy {
  /** Identifies the policy and model in replay logs. */
  readonly name: string;
  decide(request: DecisionRequest): Promise<Decision>;
  /** Writes or revises the agent's plan before its own turn; optional. */
  plan?(request: DecisionRequest): Promise<Plan>;
}

/** What a planning call is asked for, after the position and the menu. */
export const PLANNING_REQUEST = `# Plan before you move

Before you choose your next move, write your plan for the rest of this round and the next. Revise your last plan in light of what has happened since; keep what still holds. Cover:
- which public objective you will score at the end of this round (and, if you hold Imperial, whether you can score a second with its primary), and what you must keep ready to pay for it;
- which secret objective you are working towards, and how;
- where you will expand or attack, in what order, and with which ships and ground forces;
- what you will build, and which other players' strategy cards are worth a strategy token this round;
- threats you will guard against or accept.

Name moves by what they are (the card, the system, the units), not by their menu letters: the letters change from one decision to the next. Look up and search the guides as you need. Then reply with the plan as plain text, citing guide passages by id like [118-21] where they shaped it. Do not choose a move yet: you will choose next, with this plan in front of you.`;

/** The plan a planning reply gives, and the guide ids it cites among those shown. */
export function planFrom(text: string, shown: Set<string>): Pick<Plan, "text" | "citations"> {
  const cited = [...text.matchAll(/\[(\d+-\d+)\]/g)].map((m) => m[1]).filter((id) => shown.has(id));
  return { text: text.trim(), citations: [...new Set(cited)] };
}

export const noUsage = (): Usage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  requests: 0,
  retries: 0,
});

/** Always takes the first candidate: the scripted bot's own top choice. */
export class FirstCandidatePolicy implements Policy {
  readonly name = "first-candidate";

  async decide(request: DecisionRequest): Promise<Decision> {
    return {
      label: request.menu[0]?.label,
      rationale: "The scripted bot's top candidate.",
      planNote: request.planNote,
      citations: [],
      steps: [],
      usage: noUsage(),
    };
  }
}

/** The user message for a decision: the position, the plan note and the menu. */
export function turnMessage(request: DecisionRequest) {
  return [
    request.turn,
    "",
    "## Your plan",
    request.planNote
      ? `${request.planNote}\n\nFollow this plan unless something on the board makes it wrong now; if you choose otherwise, say in your rationale what changed.`
      : "(none yet)",
    "",
    ...(request.briefing
      ? ["## From the strategy guides, searched for this decision", request.briefing.text, ""]
      : []),
    "## Candidates",
    ...request.menu.map((entry) => `${entry.label}. ${entry.text}`),
  ].join("\n");
}

export type ChatPolicyOptions = {
  model: string;
  apiKey: string;
  baseURL?: string;
  /** Model calls allowed per decision, counting lookups and nudges. */
  maxRequests?: number;
  /** Lookups allowed per decision before the agent is told to choose. */
  maxLookups?: number;
  /** How long one request may take, response included, before it is abandoned. */
  requestTimeoutMs?: number;
  /** Times a timed-out or failed request is sent again. */
  retries?: number;
  /** Provider-specific request fields, such as a thinking switch. */
  extraBody?: Record<string, unknown>;
  /** A client to use instead of creating one, e.g. a fake in tests. */
  client?: Pick<OpenAI, "chat">;
};

type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type CreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

const REQUEST_TIMEOUT_MS = 180_000;
/**
 * Lookups and guide searches per decision: enough to read up on every
 * faction at the table in round one as well as the board.
 */
export const MAX_LOOKUPS = 50;

/**
 * Whether a failed request is worth sending again: timeouts, dropped
 * connections and server errors are; a request the API rejected is not. The
 * SDK already retries rate limits and server errors that fail before a
 * response starts, but not a response cut off partway through.
 */
function worthRetrying(error: unknown) {
  if (!(error instanceof OpenAI.APIError) || error.status === undefined) return true;
  return error.status >= 500 || [408, 409, 429].includes(error.status);
}

/**
 * A policy backed by any OpenAI-compatible chat completions API, such as
 * DeepSeek's. Each decision is a fresh conversation: the system prompt, the
 * game block, then the turn, so the first two form a prefix the provider
 * can cache across decisions.
 */
export class ChatPolicy implements Policy {
  readonly name: string;
  private readonly client: Pick<OpenAI, "chat">;

  constructor(private readonly options: ChatPolicyOptions) {
    this.name = `chat:${options.model}`;
    this.client =
      options.client ?? new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
  }

  async decide(request: DecisionRequest): Promise<Decision> {
    const labels = request.menu.map((entry) => entry.label);
    const messages: Message[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: request.game },
      { role: "user", content: turnMessage(request) },
    ];
    // Searching is offered only with a knowledge base, before choose.
    const offered = request.searchGuides
      ? [TOOLS[0], SEARCH_GUIDES_TOOL, ...TOOLS.slice(1)]
      : TOOLS;
    const allTools = offered.map((tool) => ({ type: "function" as const, function: tool }));
    const shown = new Set<string>(request.briefing?.ids);
    const chooseOnly = allTools.filter((tool) => tool.function.name === "choose");
    const usage = noUsage();
    const steps: ToolStep[] = [];
    const maxLookups = this.options.maxLookups ?? MAX_LOOKUPS;
    // Room for one lookup per request, then choose, and a nudge if needed.
    const maxRequests = this.options.maxRequests ?? maxLookups + 3;
    let lookups = 0;
    let nudged = false;
    let warned = false;

    for (let i = 0; i < maxRequests; i++) {
      // The last request, or once lookups are spent, can only choose.
      const last = i === maxRequests - 1 || lookups >= maxLookups;
      if (last && i > 0 && !warned) {
        warned = true;
        messages.push({
          role: "user",
          content: "No more lookups for this decision. Call choose now with the label of your move.",
        });
      }
      const response = await this.complete(
        {
          model: this.options.model,
          messages,
          tools: last ? chooseOnly : allTools,
          ...this.options.extraBody,
        },
        usage,
      );
      usage.requests++;
      usage.inputTokens += response.usage?.prompt_tokens ?? 0;
      usage.outputTokens += response.usage?.completion_tokens ?? 0;
      // DeepSeek reports cache hits under its own field name.
      const extra = response.usage as { prompt_cache_hit_tokens?: number } | undefined;
      usage.cachedInputTokens +=
        extra?.prompt_cache_hit_tokens ??
        response.usage?.prompt_tokens_details?.cached_tokens ??
        0;

      const message = response.choices[0]?.message;
      if (!message) break;
      // Kept whole, so provider fields such as reasoning_content go back too.
      messages.push(message as Message);

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        if (nudged) break;
        nudged = true;
        messages.push({ role: "user", content: "Call choose with the label of your move." });
        continue;
      }

      let chosen: Decision | undefined;
      for (const call of calls) {
        let result: string;
        if (call.type !== "function") {
          result = "Unknown tool.";
        } else if (call.function.name === "lookup") {
          const args = parseLookup(call.function.arguments);
          if (lookups >= maxLookups) {
            result = "Lookup limit reached for this decision. Call choose now.";
          } else {
            lookups++;
            result = args.ok ? request.lookup(args.value) : `Error: ${args.error}`;
          }
        } else if (call.function.name === "search_guides" && request.searchGuides) {
          const args = parseSearch(call.function.arguments);
          if (lookups >= maxLookups) {
            result = "Lookup limit reached for this decision. Call choose now.";
          } else if (!args.ok) {
            result = `Error: ${args.error}`;
          } else {
            lookups++;
            const found = request.searchGuides(args.value);
            for (const id of found.ids) shown.add(id);
            result = found.text;
          }
        } else if (call.function.name === "choose") {
          const args = parseChoose(call.function.arguments, labels);
          if (args.ok && !chosen) {
            chosen = {
              label: args.value.candidate,
              rationale: args.value.rationale,
              planNote: args.value.plan_note,
              citations: args.value.citations.filter((id) => shown.has(id)),
              steps,
              usage,
            };
            result = "Move recorded.";
          } else {
            result = args.ok ? "Only one choice per decision." : `Error: ${args.error}`;
          }
        } else {
          result = `Unknown tool ${call.function.name}.`;
        }
        const name = call.type === "function" ? call.function.name : call.type;
        const argsText = call.type === "function" ? call.function.arguments : "";
        steps.push({ tool: name, arguments: argsText, result });
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      if (chosen) return chosen;
    }
    return {
      rationale: "",
      planNote: request.planNote,
      citations: [],
      steps,
      usage,
      error: `No valid choice after ${usage.requests} requests.`,
    };
  }

  async plan(request: DecisionRequest): Promise<Plan> {
    const messages: Message[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: request.game },
      { role: "user", content: `${turnMessage(request)}\n\n${PLANNING_REQUEST}` },
    ];
    const tools = (request.searchGuides ? [TOOLS[0], SEARCH_GUIDES_TOOL] : [TOOLS[0]]).map((tool) => ({
      type: "function" as const,
      function: tool,
    }));
    const shown = new Set<string>(request.briefing?.ids);
    const usage = noUsage();
    const steps: ToolStep[] = [];
    const maxLookups = this.options.maxLookups ?? MAX_LOOKUPS;
    let lookups = 0;

    for (let i = 0; i < maxLookups + 2; i++) {
      // Once lookups are spent, ask for the plan with no tools.
      const done = lookups >= maxLookups;
      const response = await this.complete(
        { model: this.options.model, messages, ...(done ? {} : { tools }), ...this.options.extraBody },
        usage,
      );
      usage.requests++;
      usage.inputTokens += response.usage?.prompt_tokens ?? 0;
      usage.outputTokens += response.usage?.completion_tokens ?? 0;
      const extra = response.usage as { prompt_cache_hit_tokens?: number } | undefined;
      usage.cachedInputTokens +=
        extra?.prompt_cache_hit_tokens ?? response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const message = response.choices[0]?.message;
      if (!message) break;
      messages.push(message as Message);
      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        if (message.content?.trim()) return { ...planFrom(message.content, shown), steps, usage };
        break;
      }
      for (const call of calls) {
        let result: string;
        if (call.type !== "function") {
          result = "Unknown tool.";
        } else if (lookups >= maxLookups) {
          result = "Lookup limit reached. Write your plan now.";
        } else if (call.function.name === "lookup") {
          const args = parseLookup(call.function.arguments);
          lookups++;
          result = args.ok ? request.lookup(args.value) : `Error: ${args.error}`;
        } else if (call.function.name === "search_guides" && request.searchGuides) {
          const args = parseSearch(call.function.arguments);
          lookups++;
          if (args.ok) {
            const found = request.searchGuides(args.value);
            for (const id of found.ids) shown.add(id);
            result = found.text;
          } else {
            result = `Error: ${args.error}`;
          }
        } else {
          result = `Unknown tool ${call.function.name}.`;
        }
        const name = call.type === "function" ? call.function.name : call.type;
        steps.push({ tool: name, arguments: call.type === "function" ? call.function.arguments : "", result });
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    return { text: "", citations: [], steps, usage, error: "No plan was written." };
  }

  /** One request, abandoned after the timeout and sent again if worth it. */
  private async complete(body: CreateParams, usage: Usage) {
    const timeout = this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    const retries = this.options.retries ?? 1;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.chat.completions.create(body, {
          signal: AbortSignal.timeout(timeout),
        });
      } catch (error) {
        if (attempt >= retries || !worthRetrying(error)) throw error;
        usage.retries++;
      }
    }
  }
}
