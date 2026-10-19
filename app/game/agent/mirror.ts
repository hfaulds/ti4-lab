/**
 * Plays a game's moves through the web app's game endpoint, so the app's
 * copy is the one that counts. The harness works out each move locally, but
 * a move is only played once the app has accepted it: while the app is down
 * the game waits, and if the app ever disagrees about the game it stops.
 */
import { PlayerId } from "~/types";
import { GameAction } from "../actions";
import { MoveNote } from "../history";
import { GameState } from "../types";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type MirrorOptions = {
  /** The game's endpoint, e.g. http://localhost:3000/api/game/<name>. */
  endpoint: string;
  /** Milliseconds to wait after each accepted move. */
  paceMs?: number;
  /** Longest wait between attempts while the app is unavailable. */
  maxBackoffMs?: number;
  fetch?: Fetch;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export type Move = { player: PlayerId; action: GameAction; note?: MoveNote };

type Outcome =
  | { kind: "accepted"; version?: number }
  | { kind: "rejected"; error: string }
  | { kind: "unavailable"; error: string };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** HTTP statuses that mean "try again later" rather than "no". */
const TRANSIENT = new Set([408, 409, 425, 429]);

export function mirrorMoves(options: MirrorOptions) {
  const http = options.fetch ?? fetch;
  const log = options.log ?? ((message: string) => console.warn(message));
  const sleep = options.sleep ?? wait;
  const maxBackoff = options.maxBackoffMs ?? 10_000;

  async function send(move: Move): Promise<Outcome> {
    let response: Response;
    try {
      response = await http(options.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(move),
      });
    } catch (error) {
      return { kind: "unavailable", error: String(error) };
    }
    const body = (await response.json().catch(() => undefined)) as
      | { success?: boolean; error?: string; view?: { version: number } }
      | undefined;
    if (response.status >= 500 || TRANSIENT.has(response.status) || !body) {
      return { kind: "unavailable", error: body?.error ?? `HTTP ${response.status}` };
    }
    if (!body.success) {
      return { kind: "rejected", error: body.error ?? `HTTP ${response.status}` };
    }
    return { kind: "accepted", version: body.view?.version };
  }

  /** The app's current version of the game, or undefined if it cannot say. */
  async function serverVersion(): Promise<number | undefined> {
    try {
      const response = await http(options.endpoint);
      if (!response.ok) return undefined;
      const body = (await response.json()) as { view?: { version: number } };
      return body.view?.version;
    } catch {
      return undefined;
    }
  }

  /** Waits until the app has applied `move`, which leads to `next`. */
  return async function onMove(move: Move, next: GameState) {
    const expected = next.version;
    const describe = `${move.action.type} by P${move.player}`;
    let backoff = 500;
    let waiting = false;

    for (;;) {
      const outcome = await send(move);
      if (outcome.kind === "accepted") {
        // The engine is deterministic, so both copies reach the same version.
        if (outcome.version !== undefined && outcome.version !== expected) {
          throw new Error(
            `The app is at version ${outcome.version} after ${describe}, but the harness is at ${expected}; stopping.`,
          );
        }
        break;
      }

      // An earlier attempt may have landed with its reply lost.
      const current = await serverVersion();
      if (current === expected) break;
      if (current !== undefined && current !== expected - 1) {
        throw new Error(
          `The app is at version ${current} but the harness expected ${expected - 1} before ${describe}; stopping.`,
        );
      }
      if (outcome.kind === "rejected" && current !== undefined) {
        throw new Error(`The app rejected ${describe}: ${outcome.error}`);
      }

      if (!waiting) {
        log(`The app is unavailable (${outcome.error}); waiting for it before playing on.`);
        waiting = true;
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    }

    if (waiting) log("The app is back; playing on.");
    if (options.paceMs) await sleep(options.paceMs);
  };
}
