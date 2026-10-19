import { describe, expect, test } from "vitest";
import { GameState } from "../types";
import { mirrorMoves, Move } from "./mirror";

const move: Move = { player: 0, action: { type: "PASS" } };
const after = (version: number) => ({ version }) as GameState;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/**
 * A fake game endpoint at `version`. `script` decides what each POST does:
 * apply it, fail before it arrives, apply it but lose the reply, or answer
 * with an HTML error page as a reloading dev server does.
 */
function fakeApp(version: number, script: ("ok" | "down" | "lost" | "html" | "reject")[]) {
  const state = { version, posts: 0, gets: 0 };
  const fetch = async (_url: string, init?: RequestInit) => {
    if (init?.method !== "POST") {
      state.gets++;
      return json({ view: { version: state.version } });
    }
    const step = script[Math.min(state.posts++, script.length - 1)];
    switch (step) {
      case "ok":
        state.version++;
        return json({ success: true, view: { version: state.version } });
      case "down":
        throw new TypeError("fetch failed");
      case "lost":
        state.version++;
        throw new TypeError("socket hang up");
      case "html":
        return new Response("<html>Reloading</html>", { status: 500 });
      case "reject":
        return json({ success: false, error: "It is not your turn." }, 422);
    }
  };
  const logs: string[] = [];
  const waits: number[] = [];
  const onMove = mirrorMoves({
    endpoint: "http://app/api/game/x",
    fetch,
    log: (message) => logs.push(message),
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { state, onMove, logs, waits };
}

describe("playing moves through the app", () => {
  test("moves on once the app accepts the move", async () => {
    const app = fakeApp(10, ["ok"]);
    await app.onMove(move, after(11));
    expect(app.state).toMatchObject({ version: 11, posts: 1 });
    expect(app.logs).toEqual([]);
  });

  test("waits while the app is down or reloading, then carries on", async () => {
    const app = fakeApp(10, ["down", "html", "down", "ok"]);
    await app.onMove(move, after(11));
    expect(app.state).toMatchObject({ version: 11, posts: 4 });
    expect(app.waits).toEqual([500, 1000, 2000]);
    expect(app.logs[0]).toMatch(/unavailable .* waiting/);
    expect(app.logs.at(-1)).toMatch(/back; playing on/);
  });

  test("does not send a move twice when only the reply was lost", async () => {
    const app = fakeApp(10, ["lost", "ok"]);
    await app.onMove(move, after(11));
    expect(app.state).toMatchObject({ version: 11, posts: 1 });
  });

  test("stops when the app rejects a move", async () => {
    const app = fakeApp(10, ["reject"]);
    await expect(app.onMove(move, after(11))).rejects.toThrow(
      "The app rejected PASS by P0: It is not your turn.",
    );
  });

  test("stops when the app and the harness disagree about the game", async () => {
    const ahead = fakeApp(12, ["ok"]);
    await expect(ahead.onMove(move, after(11))).rejects.toThrow(/app is at version 13/);
    const elsewhere = fakeApp(7, ["down"]);
    await expect(elsewhere.onMove(move, after(11))).rejects.toThrow(/expected 10/);
  });
});
