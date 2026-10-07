import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as CodexClient from "./client.ts";
import * as Replay from "./replay.ts";

const threadParams = {
  cwd: "/fixture/owned-workspace",
  model: "fixture-model",
  config: {
    mcp_servers: {
      scient: {
        url: "http://fixture.invalid/mcp",
        http_headers: { Authorization: "Bearer fixture-issued" },
      },
    },
  },
};
const turnParams = {
  threadId: "native-owned-thread",
  input: [{ type: "text", text: "Exact fixture input." }],
  sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/fixture/owned-workspace"] },
};

const runReplay = Effect.fnUntraced(function* (
  method: string,
  expected: object,
  actual: object,
  strict: boolean,
) {
  const frame = { id: 1, method, params: expected };
  const transcript: Replay.CodexAppServerReplayTranscript = {
    provider: "codex",
    protocol: "codex.app-server",
    version: "fixture",
    scenario: "issued-mcp-exact-matching",
    entries: [
      { type: "expect_outbound", label: "fixture.request", frame },
      { type: "emit_inbound", frame: { id: 1, result: { accepted: true } } },
    ],
  };
  let materialized = 0;
  const driver = yield* Replay.makeReplayDriver(
    transcript,
    strict
      ? {
          materializeExpectedOutbound: (entry) =>
            Effect.sync(() => {
              assert.equal(entry.label, "fixture.request");
              materialized++;
              return frame;
            }),
        }
      : {},
  );
  const result = yield* Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    return yield* client.raw.request(method, actual);
  }).pipe(Effect.provide(Replay.layerReplayWithDriver(driver)), Effect.exit);
  return { result, state: yield* Ref.get(driver.state), materialized };
});

describe("Codex replay opt-in exact issued-context expectations", () => {
  it.effect("retains the default recorded compatibility matcher", () =>
    Effect.gen(function* () {
      const replay = yield* runReplay(
        "thread/start",
        threadParams,
        {
          ...threadParams,
          cwd: "/different-fixture",
          model: "different-model",
          config: {
            mcp_servers: {
              scient: {
                url: "http://other.invalid",
                http_headers: { Authorization: "Bearer other-fixture" },
              },
            },
          },
        },
        false,
      );
      assert.isTrue(Exit.isSuccess(replay.result));
      assert.equal(replay.state.failure, null);
      assert.equal(replay.materialized, 0);
    }),
  );

  it.effect("matches the fully materialized fixture exactly", () =>
    Effect.gen(function* () {
      const replay = yield* runReplay("thread/start", threadParams, threadParams, true);
      assert.isTrue(Exit.isSuccess(replay.result));
      assert.equal(replay.state.failure, null);
      assert.equal(replay.materialized, 1);
    }),
  );

  it.effect.each(["credential", "model", "cwd", "input", "sandbox", "native-owner"] as const)(
    "rejects a changed %s without relaxing the structural matcher",
    (kind) =>
      Effect.gen(function* () {
        const isThread = kind === "credential" || kind === "model" || kind === "cwd";
        const expected = isThread ? threadParams : turnParams;
        const actual =
          kind === "credential"
            ? {
                ...threadParams,
                config: {
                  mcp_servers: {
                    scient: {
                      url: "http://fixture.invalid/mcp",
                      http_headers: { Authorization: "Bearer wrong-fixture" },
                    },
                  },
                },
              }
            : kind === "model"
              ? { ...threadParams, model: "wrong-model" }
              : kind === "cwd"
                ? { ...threadParams, cwd: "/wrong-workspace" }
                : kind === "input"
                  ? { ...turnParams, input: [{ type: "text", text: "Wrong input." }] }
                  : kind === "sandbox"
                    ? { ...turnParams, sandboxPolicy: { type: "dangerFullAccess" } }
                    : { ...turnParams, threadId: "foreign-native-thread" };
        const replay = yield* runReplay(
          isThread ? "thread/start" : "turn/start",
          expected,
          actual,
          true,
        );
        assert.isTrue(Exit.isFailure(replay.result));
        assert.equal(replay.state.failure?._tag, "CodexAppServerReplayFrameMismatchError");
        assert.equal(replay.materialized, 1);
      }),
  );
});
