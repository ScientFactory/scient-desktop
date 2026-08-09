import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { decodeClaudeAuthStatus } from "../../provider/Drivers/ClaudeAuthStatus.ts";
import {
  findClaudeAuthorizationUrl,
  makeClaudeConnectionActions,
  makeClaudeConnectionActionsFromRuntime,
  officialClaudeAccountEnvironment,
  type ClaudeAuthRuntime,
} from "./ClaudeConnectionActions.ts";

const claudeSettings = Schema.decodeSync(ClaudeSettings)({ binaryPath: "claude" });

function makeHandle(input: {
  readonly stdout?: string;
  readonly all?: string;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly stdin?: ChildProcessSpawner.ChildProcessHandle["stdin"];
  readonly onKill?: () => void;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: input.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.sync(() => input.onKill?.()),
    unref: Effect.succeed(Effect.void),
    stdin: input.stdin ?? Sink.drain,
    stdout: Stream.encodeText(Stream.make(input.stdout ?? "")),
    stderr: Stream.empty,
    all: Stream.encodeText(Stream.make(input.all ?? "")),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("ClaudeConnectionActions", () => {
  it("accepts only official Claude and Anthropic HTTPS authorization pages", () => {
    assert.strictEqual(
      findClaudeAuthorizationUrl(
        "Open https://claude.com/cai/oauth/authorize?client_id=test&state=secure",
      ),
      "https://claude.com/cai/oauth/authorize?client_id=test&state=secure",
    );
    assert.strictEqual(
      findClaudeAuthorizationUrl("Open https://platform.claude.com/oauth/authorize"),
      "https://platform.claude.com/oauth/authorize",
    );
    assert.strictEqual(
      findClaudeAuthorizationUrl("Open https://claude.ai/oauth/authorize?state=secure"),
      "https://claude.ai/oauth/authorize?state=secure",
    );
    assert.strictEqual(
      findClaudeAuthorizationUrl(
        "Open \u001b]8;;https://claude.ai/oauth/authorize?state=secure\u0007https://claude.ai/oauth/authorize?state=secure\u001b]8;;\u0007",
      ),
      "https://claude.ai/oauth/authorize?state=secure",
    );
    assert.strictEqual(
      findClaudeAuthorizationUrl(
        "Open \u001b]8;;https://claude.ai/oauth/authorize?state=metadata-only\u001b\\secure browser\u001b]8;;\u001b\\",
      ),
      "https://claude.ai/oauth/authorize?state=metadata-only",
    );
    assert.strictEqual(
      findClaudeAuthorizationUrl("Read https://docs.anthropic.com/en/docs/claude-code"),
      undefined,
    );
    assert.strictEqual(
      findClaudeAuthorizationUrl("Ignore https://claude.com.evil.example/oauth"),
      undefined,
    );
    assert.strictEqual(findClaudeAuthorizationUrl("Ignore http://claude.com/oauth"), undefined);
  });

  it("decodes only the documented logged-in boolean", () => {
    assert.deepStrictEqual(decodeClaudeAuthStatus('{"loggedIn":true}'), { loggedIn: true });
    assert.deepStrictEqual(decodeClaudeAuthStatus('{"loggedIn":false}'), { loggedIn: false });
    assert.deepStrictEqual(decodeClaudeAuthStatus('{"loggedIn":true,"accountLabel":"ignored"}'), {
      loggedIn: true,
    });
    assert.strictEqual(decodeClaudeAuthStatus('{"loggedIn":"yes"}'), undefined);
    assert.strictEqual(decodeClaudeAuthStatus("not json"), undefined);
  });

  it("keeps host essentials while excluding credentials and alternate backends", () => {
    const environment = officialClaudeAccountEnvironment({
      HOME: "/Users/test",
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: "C:\\Users\\scientist",
      APPDATA: "C:\\Users\\scientist\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\scientist\\AppData\\Local",
      TEMP: "C:\\Users\\scientist\\AppData\\Local\\Temp",
      HTTPS_PROXY: "https://proxy.example",
      CLAUDE_CONFIG_DIR: "/Users/test/.claude-work",
      ANTHROPIC_API_KEY: "secret",
      ANTHROPIC_AUTH_TOKEN: "secret",
      ANTHROPIC_BASE_URL: "https://gateway.example",
      CLAUDE_CODE_OAUTH_TOKEN: "secret",
      CLAUDE_CODE_USE_BEDROCK: "1",
      SCIENT_CLAUDE_SUBSCRIPTION_AUTH_APPROVED: "1",
      UNRELATED_SECRET_TOKEN: "secret",
    });

    assert.strictEqual(environment.HOME, "/Users/test");
    assert.strictEqual(environment.Path, "C:\\Windows\\System32");
    assert.strictEqual(environment.SystemRoot, "C:\\Windows");
    assert.strictEqual(environment.ComSpec, "C:\\Windows\\System32\\cmd.exe");
    assert.strictEqual(environment.PATHEXT, ".COM;.EXE;.BAT;.CMD");
    assert.strictEqual(environment.USERPROFILE, "C:\\Users\\scientist");
    assert.strictEqual(environment.APPDATA, "C:\\Users\\scientist\\AppData\\Roaming");
    assert.strictEqual(environment.LOCALAPPDATA, "C:\\Users\\scientist\\AppData\\Local");
    assert.strictEqual(environment.TEMP, "C:\\Users\\scientist\\AppData\\Local\\Temp");
    assert.strictEqual(environment.HTTPS_PROXY, "https://proxy.example");
    assert.strictEqual(environment.CLAUDE_CONFIG_DIR, "/Users/test/.claude-work");
    assert.strictEqual(environment.DISABLE_UPDATES, "1");
    assert.strictEqual(environment.ANTHROPIC_API_KEY, undefined);
    assert.strictEqual(environment.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.strictEqual(environment.ANTHROPIC_BASE_URL, undefined);
    assert.strictEqual(environment.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.strictEqual(environment.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.strictEqual(environment.SCIENT_CLAUDE_SUBSCRIPTION_AUTH_APPROVED, undefined);
    assert.strictEqual(environment.UNRELATED_SECRET_TOKEN, undefined);
  });

  it.effect("supervises Claude's official login without owning credentials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* Ref.make<ReadonlyArray<string>>([]);
        const record = (event: string) => Ref.update(events, (current) => [...current, event]);
        const runtime: ClaudeAuthRuntime = {
          startLogin: (method) =>
            Effect.succeed({
              authorizationUrl: "https://claude.com/cai/oauth/authorize",
              submitAuthorizationCode: (code) => record(`code:${code}`),
              waitForExit: record(`wait:${method}`),
              cancel: record("cancel"),
            }),
          verifyLoggedIn: record("verify"),
          logout: record("logout"),
        };
        const actions = makeClaudeConnectionActionsFromRuntime(runtime);

        const attempt = yield* actions.start("claude_subscription");
        assert.strictEqual(attempt.authorizationUrl, "https://claude.com/cai/oauth/authorize");
        assert.strictEqual(attempt.authorizationUrlKind, "manual_fallback");
        assert.ok(attempt.submitAuthorizationCode);
        yield* attempt.submitAuthorizationCode("one-time-code");
        yield* attempt.waitForCompletion;
        yield* attempt.cancel;
        yield* actions.disconnect;

        assert.deepStrictEqual(yield* Ref.get(events), [
          "code:one-time-code",
          "wait:claude_subscription",
          "verify",
          "cancel",
          "logout",
        ]);
      }),
    ),
  );

  it.effect("completes the normal Console browser flow without requiring a one-time code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const loginExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const commands = yield* Ref.make<ReadonlyArray<ChildProcess.StandardCommand>>([]);
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            assert.ok(ChildProcess.isStandardCommand(command));
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("Expected a standard command");
            }
            yield* Ref.update(commands, (current) => [...current, command]);
            if (command.args[0] === "auth" && command.args[1] === "login") {
              return makeHandle({
                all: "Open https://platform.claude.com/oauth/authorize?state=secure\n",
                exitCode: Deferred.await(loginExit),
              });
            }
            if (command.args[0] === "auth" && command.args[1] === "status") {
              return makeHandle({ stdout: '{"loggedIn":true}' });
            }
            return yield* Effect.die(`Unexpected Claude command: ${command.args.join(" ")}`);
          }),
        );
        const actions = yield* makeClaudeConnectionActions(
          claudeSettings,
          {
            HOME: "/Users/test",
            PATH: "/usr/bin",
            ANTHROPIC_API_KEY: "must-not-reach-Claude",
            CLAUDE_CODE_USE_BEDROCK: "1",
          },
          spawner,
        );

        const attempt = yield* actions.start("claude_console");
        assert.strictEqual(
          attempt.authorizationUrl,
          "https://platform.claude.com/oauth/authorize?state=secure",
        );
        yield* Deferred.succeed(loginExit, ChildProcessSpawner.ExitCode(0));
        yield* attempt.waitForCompletion;

        const spawned = yield* Ref.get(commands);
        assert.deepStrictEqual(
          spawned.map((command) => command.args),
          [
            ["auth", "login", "--console"],
            ["auth", "status", "--json"],
          ],
        );
        for (const command of spawned) {
          assert.strictEqual(command.options.extendEnv, false);
          assert.strictEqual(command.options.env?.DISABLE_UPDATES, "1");
          assert.strictEqual(command.options.env?.ANTHROPIC_API_KEY, undefined);
          assert.strictEqual(command.options.env?.CLAUDE_CODE_USE_BEDROCK, undefined);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("hands an occasional fallback code only to the live login process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const loginExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const receivedInput = yield* Ref.make("");
        const decoder = new TextDecoder();
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            assert.ok(ChildProcess.isStandardCommand(command));
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("Expected a standard command");
            }
            if (command.args[1] === "login") {
              return makeHandle({
                all: "Open https://claude.ai/oauth/authorize?state=secure\n",
                exitCode: Deferred.await(loginExit),
                stdin: Sink.forEach((chunk: Uint8Array) =>
                  Ref.update(
                    receivedInput,
                    (current) => `${current}${decoder.decode(chunk, { stream: true })}`,
                  ),
                ),
              });
            }
            return makeHandle({ stdout: '{"loggedIn":true}' });
          }),
        );
        const actions = yield* makeClaudeConnectionActions(
          claudeSettings,
          { HOME: "/Users/test", PATH: "/usr/bin" },
          spawner,
        );

        const attempt = yield* actions.start("claude_subscription");
        assert.ok(attempt.submitAuthorizationCode);
        yield* attempt.submitAuthorizationCode("one-time-code");
        assert.strictEqual(yield* Ref.get(receivedInput), "one-time-code\n");
        yield* Deferred.succeed(loginExit, ChildProcessSpawner.ExitCode(0));
        yield* attempt.waitForCompletion;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels the same concrete Claude login process without touching credentials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const loginExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        let killed = false;
        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeHandle({
              all: "Open https://claude.com/cai/oauth/authorize?state=secure\n",
              exitCode: Deferred.await(loginExit),
              onKill: () => {
                killed = true;
              },
            }),
          ),
        );
        const actions = yield* makeClaudeConnectionActions(
          claudeSettings,
          { HOME: "/Users/test", PATH: "/usr/bin" },
          spawner,
        );

        const attempt = yield* actions.start("claude_console");
        yield* attempt.cancel;

        assert.strictEqual(killed, true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("terminates a login that never provides an authorization page", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let killed = false;
        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeHandle({
              exitCode: Effect.never,
              onKill: () => {
                killed = true;
              },
            }),
          ),
        );
        const actions = yield* makeClaudeConnectionActions(
          claudeSettings,
          { HOME: "/Users/test", PATH: "/usr/bin" },
          spawner,
        );

        const starting = yield* actions.start("claude_subscription").pipe(Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        const failure = yield* Fiber.join(starting).pipe(Effect.flip);

        assert.match(failure.message, /too long to open/iu);
        assert.strictEqual(killed, true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("bounds an unfinished login and terminates only that concrete process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let killed = false;
        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeHandle({
              all: "Open https://claude.com/cai/oauth/authorize?state=secure\n",
              exitCode: Effect.never,
              onKill: () => {
                killed = true;
              },
            }),
          ),
        );
        const actions = yield* makeClaudeConnectionActions(
          claudeSettings,
          { HOME: "/Users/test", PATH: "/usr/bin" },
          spawner,
        );

        const attempt = yield* actions.start("claude_subscription");
        const completion = yield* attempt.waitForCompletion.pipe(Effect.forkChild);
        yield* TestClock.adjust("10 minutes");
        const failure = yield* Fiber.join(completion).pipe(Effect.flip);

        assert.match(failure.message, /took too long/iu);
        assert.strictEqual(killed, true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
