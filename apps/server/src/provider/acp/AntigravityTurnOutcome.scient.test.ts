import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { watchAntigravityPromptOutcome } from "./AntigravityTurnOutcome.ts";

const USER_INPUT = 14;
const ERROR_MESSAGE = 17;

const field = (tag: number, value: string) => {
  const bytes = Buffer.from(value);
  const length: Array<number> = [];
  for (let rest = bytes.length; ; rest >>>= 7) {
    if (rest < 0x80) {
      length.push(rest);
      break;
    }
    length.push((rest & 0x7f) | 0x80);
  }
  return Buffer.concat([Buffer.from([tag, ...length]), bytes]);
};

// Antigravity 1.4.x's error step: the step header, then the headline, the error chain, and the
// chain again with its Go stack trace.
const errorStep = (chain: string) =>
  Buffer.concat([
    Buffer.from([0x08, 0x11, 0x20, 0x03, 0xc2, 0x01, 0x85, 0x1f, 0x1a, 0x80, 0x1f]),
    field(0x0a, "Agent execution terminated due to error."),
    field(0x12, chain),
    field(
      0x1a,
      `${chain}\n(1) attached stack trace\n  -- stack trace:\n  | google3/third_party/gemini_coder/framework/executor/agentexecutor.(*AgentExecutor).execute`,
    ),
  ]);

describe("watchAntigravityPromptOutcome (Scient)", () => {
  it.effect("names the tool server that failed to start, and keeps other harness errors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const sessionId = "e6aba774-5472-4277-b6ee-27b2e05570a7";
      const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(conversations, { recursive: true });
      const turn = (payload: Uint8Array) =>
        Effect.gen(function* () {
          const check = yield* watchAntigravityPromptOutcome(profileDirectory, sessionId);
          const database = new NodeSqlite.DatabaseSync(path.join(conversations, `${sessionId}.db`));
          try {
            database.exec(
              "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
            );
            const insert = database.prepare(
              "INSERT INTO steps (step_type, step_payload) VALUES (?, ?)",
            );
            insert.run(USER_INPUT, Buffer.from("Run the fixture."));
            insert.run(ERROR_MESSAGE, payload);
          } finally {
            database.close();
          }
          return yield* check({ stopReason: "end_turn" });
        });

      // regression: a refused connector `initialize` failed every turn as a generic error.
      assert.deepEqual(
        yield* turn(
          errorStep(
            'failed to construct executor: MCP load failed for ct-crash: calling "initialize": CT Crash could not start: Error: CT Crash: config file /etc/ct-crash.conf not found.',
          ),
        ),
        {
          class: "provider_error",
          message:
            'Antigravity could not start the tool server "ct-crash", so it stopped this turn: CT Crash could not start: Error: CT Crash: config file ct-crash.conf not found.',
          code: "mcp_load_failed",
          retryable: false,
        },
      );
      // regression: the shown and stored text kept paths, addresses and keys from the chain.
      const secrets = [
        "/Users/fixture/.config",
        "C:\\Users\\fixture",
        "\\\\corp-share",
        "fixture@example.invalid",
        "AIzaSyA1234567890abcdefghijklmnopqrstuv",
        "ghp_abcdefghijklmnopqrstuvwxyz0123",
        "xoxb-1234567890-abcdefghij",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl",
        "sk-ant-abcdefghijklmnop1234",
        "0123456789abcdef0123456789abcdef",
        "QWxhZGRpbjpvcGVuIHNlc2FtZQ1234567890ABCDEFGH",
        "synthetic-secret",
        "pw@",
        "sig=",
      ];
      const hostile = yield* turn(
        errorStep(
          [
            `failed to construct executor: MCP load failed for fixture-tools: calling "initialize":`,
            "Fixture could not read /Users/fixture/.config/key.json, C:\\Users\\fixture\\key.json or \\\\corp-share\\home\\notes.txt",
            `for fixture@example.invalid with ${secrets.slice(4, 11).join(" ")} token=synthetic-secret`,
            "via https://user:pw@api.example.invalid/v1/models?sig=abc.",
          ].join(" "),
        ),
      );
      for (const secret of secrets) assert.notInclude(hostile?.message, secret);
      assert.include(
        hostile?.message,
        'tool server "fixture-tools", so it stopped this turn: Fixture could not read key.json, key.json or notes.txt for [REDACTED] with',
      );
      assert.include(
        hostile?.message,
        "token=[REDACTED] via https://api.example.invalid/v1/models.",
      );
      // Redaction comes before the bound, so a key the bound would cut is still caught.
      const cut = yield* turn(
        errorStep(`agent executor error: ${"x".repeat(528)} ${"0123456789abcdef".repeat(4)}`),
      );
      assert.notInclude(cut?.message, "0123456789abcdef");
      assert.match(cut?.message ?? "", / \[REDACTED\]$/u);
      // A chain longer than 127 bytes has a multi-byte length.
      const longReason = `The service answered ${"slowly ".repeat(30)}and then closed.`;
      assert.deepEqual(
        yield* turn(errorStep(`agent executor error: planner rejected the step: ${longReason}`)),
        {
          class: "provider_error",
          message: `Antigravity stopped this turn because of an error: planner rejected the step: ${longReason}`,
          code: "harness_error",
          retryable: null,
        },
      );
      assert.deepEqual(yield* turn(Buffer.from("Agent execution terminated due to error.")), {
        class: "provider_error",
        message: "Antigravity stopped this turn because of an error.",
        code: "harness_error",
        retryable: null,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
