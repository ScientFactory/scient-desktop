import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";

const settings = Schema.decodeSync(ClaudeSettings)({});
const encoder = new TextEncoder();

/** A CLI command that answers after `seconds`, as the native Claude CLI does on a busy host. */
interface SlowAnswer {
  readonly stdout: string;
  readonly seconds: number;
}

const slowCliLayer = (answers: Record<string, SlowAnswer>) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const joined = (command as unknown as { args: ReadonlyArray<string> }).args.join(" ");
        const answer = answers[joined];
        if (answer === undefined) return Effect.die(`Unexpected Claude command: ${joined}`);
        const delay = Duration.seconds(answer.seconds);
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.sleep(delay).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.fromEffect(
              Effect.sleep(delay).pipe(Effect.as(encoder.encode(answer.stdout))),
            ),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }),
    ),
  );

const capabilities = () =>
  Effect.succeed({
    email: undefined,
    subscriptionType: "team",
    tokenSource: undefined,
    apiKeySource: undefined,
    apiProvider: undefined,
    slashCommands: [],
  });

/** Runs the real Claude check, letting the test clock pass one second at a time. */
const checkWithSlowCli = (answers: Record<string, SlowAnswer>) =>
  Effect.gen(function* () {
    const fiber = yield* checkClaudeProviderStatus(settings, capabilities, {}).pipe(
      Effect.provide(slowCliLayer(answers)),
      Effect.forkChild,
    );
    for (let second = 0; second < 60; second++) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
    }
    return yield* Fiber.join(fiber);
  });

const VERSION = "2.1.302 (Claude Code)\n";
const SIGNED_IN = '{"loggedIn":true,"authMethod":"claude.ai"}\n';

describe("Claude health-check deadline", () => {
  it.effect("waits for a slow but healthy `--version`", () =>
    Effect.gen(function* () {
      const status = yield* checkWithSlowCli({
        "--version": { stdout: VERSION, seconds: 10 },
        "auth status --json": { stdout: SIGNED_IN, seconds: 0 },
      });
      assert.strictEqual(status.status, "ready");
      assert.strictEqual(status.auth.status, "authenticated");
    }),
  );

  it.effect("waits for a slow but healthy `auth status`", () =>
    Effect.gen(function* () {
      const status = yield* checkWithSlowCli({
        "--version": { stdout: VERSION, seconds: 0 },
        "auth status --json": { stdout: SIGNED_IN, seconds: 10 },
      });
      assert.strictEqual(status.status, "ready");
      assert.strictEqual(status.auth.status, "authenticated");
      assert.ok(status.models.length > 0);
    }),
  );

  it.effect("still reports a CLI that does not answer within 20 seconds", () =>
    Effect.gen(function* () {
      const status = yield* checkWithSlowCli({
        "--version": { stdout: VERSION, seconds: 25 },
      });
      assert.strictEqual(status.status, "error");
      assert.strictEqual(
        status.message,
        "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      );
    }),
  );
});
