// @effect-diagnostics nodeBuiltinImport:off -- Exercise the replay agent as a child process.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

it.live("exits promptly with a recorded mismatch instead of leaving the ACP child open", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-replay-agent-"))),
      (created) => Effect.sync(() => NodeFS.rmSync(created, { recursive: true, force: true })),
    );
    const statusPath = NodePath.join(directory, "status.json");
    const transcript = {
      scenario: "mismatch-exit",
      entries: [
        {
          type: "expect_outbound",
          label: "prompt",
          frame: {
            kind: "request",
            method: "session/prompt",
            params: { sessionId: "expected" },
          },
        },
      ],
    };
    const scriptPath = NodePath.join(import.meta.dirname, "acp-replay-agent.ts");
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["--experimental-strip-types", scriptPath],
      {
        env: {
          T3_ACP_REPLAY_TRANSCRIPT: Buffer.from(JSON.stringify(transcript)).toString("base64"),
          T3_ACP_REPLAY_STATUS_PATH: statusPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const childExit = new Promise<{ readonly code: number | null; readonly signal: string | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    const childTermination = new Promise<void>((resolve) => {
      child.once("error", () => {
        if (child.pid === undefined || child.pid === null) resolve();
      });
      child.once("exit", () => resolve());
    });
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (child.exitCode !== null || child.signalCode !== null) return;

        const terminated = Effect.promise(() => childTermination).pipe(Effect.timeout("2 seconds"));
        child.kill("SIGKILL");
        yield* terminated.pipe(Effect.orDie);
      }),
    );

    const exit = yield* Effect.tryPromise({
      try: () => {
        child.stdin.end(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "session/prompt",
            params: { sessionId: "actual" },
          })}\n`,
        );
        return childExit;
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(Effect.timeout("2 seconds"));

    NodeAssert.deepEqual(exit, { code: 1, signal: null });
    const status = NodeFS.readFileSync(statusPath, "utf8");
    NodeAssert.deepEqual(JSON.parse(status), {
      scenario: "mismatch-exit",
      cursor: 0,
      total: 1,
      failure: {
        detail: "Unexpected outbound ACP frame",
        cursor: 0,
        expected: {
          type: "expect_outbound",
          label: "prompt",
          frame: {
            kind: "request",
            method: "session/prompt",
            params: { sessionId: "expected" },
          },
        },
        actual: {
          kind: "request",
          method: "session/prompt",
          params: { sessionId: "actual" },
        },
      },
    });
  }),
);
