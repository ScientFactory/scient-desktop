import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { CursorSettings } from "@t3tools/contracts";
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

import {
  findCursorAuthorizationUrl,
  makeCursorConnectionActions,
  makeCursorConnectionActionsFromRuntime,
  officialCursorAccountEnvironment,
  withCursorSessionShutdown,
} from "./CursorConnectionActions.ts";

const cursorSettings = Schema.decodeSync(CursorSettings)({ binaryPath: "cursor-agent" });
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function makeHandle(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly all?: string;
  readonly allStream?: Stream.Stream<Uint8Array>;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly onKill?: () => void;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: input.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.sync(() => input.onKill?.()),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(input.stdout ?? "")),
    stderr: Stream.encodeText(Stream.make(input.stderr ?? "")),
    all: input.allStream ?? Stream.encodeText(Stream.make(input.all ?? "")),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("Cursor authorization output", () => {
  it("extracts only official Cursor HTTPS login URLs", () => {
    expect(
      findCursorAuthorizationUrl("Open https://cursor.com/loginDeepControl?challenge=scient"),
    ).toContain("cursor.com/loginDeepControl");
    expect(
      findCursorAuthorizationUrl("Open https://auth.cursor.com/oauth/authorize?challenge=scient"),
    ).toContain("auth.cursor.com");
    expect(findCursorAuthorizationUrl("Read https://cursor.com/docs/cli")).toBeUndefined();
    expect(
      findCursorAuthorizationUrl("Open https://cursor.com.evil.example/login"),
    ).toBeUndefined();
    expect(findCursorAuthorizationUrl("Open http://cursor.com/login")).toBeUndefined();
    expect(findCursorAuthorizationUrl("Open https://evil.example/login")).toBeUndefined();
  });

  it("recovers URLs from terminal hyperlinks and strips trailing punctuation", () => {
    expect(
      findCursorAuthorizationUrl(
        "\u001b]8;;https://cursor.com/loginDeepControl?challenge=scient\u0007Sign in\u001b]8;;\u0007.",
      ),
    ).toBe("https://cursor.com/loginDeepControl?challenge=scient");
  });

  it("keeps account-storage and network essentials while excluding credentials", () => {
    const environment = officialCursorAccountEnvironment({
      HOME: "/Users/test",
      Path: "C:\\Windows\\System32",
      USERPROFILE: "C:\\Users\\scientist",
      HTTPS_PROXY: "https://proxy.example",
      XDG_CONFIG_HOME: "/Users/test/.config",
      SCIENT_MANAGED_CURSOR_RUNTIME: "1",
      CURSOR_API_KEY: "secret",
      CURSOR_AUTH_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
      UNRELATED_SECRET_TOKEN: "secret",
    });

    expect(environment).toMatchObject({
      HOME: "/Users/test",
      Path: "C:\\Windows\\System32",
      USERPROFILE: "C:\\Users\\scientist",
      HTTPS_PROXY: "https://proxy.example",
      XDG_CONFIG_HOME: "/Users/test/.config",
      SCIENT_MANAGED_CURSOR_RUNTIME: "1",
    });
    expect(environment.CURSOR_API_KEY).toBeUndefined();
    expect(environment.CURSOR_AUTH_TOKEN).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.UNRELATED_SECRET_TOKEN).toBeUndefined();
  });
});

describe("Cursor connection actions", () => {
  it.effect("starts browser login, verifies it, cancels it, and stops sessions before logout", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (event: string) => Ref.update(events, (current) => [...current, event]);
      const actions = withCursorSessionShutdown(
        makeCursorConnectionActionsFromRuntime({
          startLogin: record("login").pipe(
            Effect.as({
              authorizationUrl: "https://cursor.com/loginDeepControl?challenge=scient",
              waitForExit: record("wait"),
              cancel: record("cancel"),
            }),
          ),
          verifyLoggedIn: record("verify"),
          logout: record("logout"),
        }),
        record("stop-sessions"),
      );

      const attempt = yield* actions.start("cursor_browser");
      expect(attempt.initialStatus).toBe("waiting_for_browser");
      expect(attempt.authorizationUrlKind).toBe("primary");
      expect(attempt.submitAuthorizationCode).toBeUndefined();
      yield* attempt.waitForCompletion;
      yield* attempt.cancel;
      yield* actions.disconnect;

      expect(yield* Ref.get(events)).toEqual([
        "login",
        "wait",
        "verify",
        "cancel",
        "stop-sessions",
        "logout",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not sign out when active Cursor sessions cannot be stopped", () =>
    Effect.gen(function* () {
      const logoutCalls = yield* Ref.make(0);
      const stopFailure = new Error("session remained active");
      const actions = withCursorSessionShutdown(
        makeCursorConnectionActionsFromRuntime({
          startLogin: Effect.die("must not start"),
          verifyLoggedIn: Effect.void,
          logout: Ref.update(logoutCalls, (count) => count + 1),
        }),
        Effect.fail(stopFailure),
      );

      const failure = yield* actions.disconnect.pipe(Effect.flip);
      expect(failure.message).toBe("Scient could not stop active Cursor sessions before sign out.");
      expect(failure.cause).toBe(stopFailure);
      expect(yield* Ref.get(logoutCalls)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects unrelated provider methods without starting Cursor", () =>
    Effect.gen(function* () {
      const actions = makeCursorConnectionActionsFromRuntime({
        startLogin: Effect.die("must not start"),
        verifyLoggedIn: Effect.void,
        logout: Effect.void,
      });

      const result = yield* Effect.result(actions.start("codex_browser"));
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.scoped),
  );

  it.effect("runs Cursor's browser login and verifies the account with a fresh about probe", () =>
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
            if (command.args.includes("login")) {
              return makeHandle({
                all: "Open https://cursor.com/loginDeepControl?challenge=scient\n",
                exitCode: Deferred.await(loginExit),
              });
            }
            if (command.args.includes("about")) {
              return makeHandle({
                stdout: encodeUnknownJson({
                  cliVersion: "2026.08.11-e8db854",
                  userEmail: "scientist@example.test",
                  subscriptionTier: "Pro",
                }),
              });
            }
            return yield* Effect.die(`Unexpected Cursor command: ${command.args.join(" ")}`);
          }),
        );
        const actions = yield* makeCursorConnectionActions(
          cursorSettings,
          {
            HOME: "/Users/test",
            SCIENT_MANAGED_CURSOR_RUNTIME: "1",
            CURSOR_API_KEY: "must-not-reach-Cursor",
          },
          spawner,
        );

        const attempt = yield* actions.start("cursor_browser");
        assert.strictEqual(
          attempt.authorizationUrl,
          "https://cursor.com/loginDeepControl?challenge=scient",
        );
        yield* Deferred.succeed(loginExit, ChildProcessSpawner.ExitCode(0));
        yield* attempt.waitForCompletion;

        const spawned = yield* Ref.get(commands);
        assert.deepStrictEqual(
          spawned.map((command) => command.args),
          [
            ["--disable-auto-update", "login"],
            ["--disable-auto-update", "about", "--format", "json"],
          ],
        );
        for (const command of spawned) {
          assert.strictEqual(command.options.extendEnv, false);
          assert.strictEqual(command.options.env?.HOME, "/Users/test");
          assert.strictEqual(command.options.env?.SCIENT_MANAGED_CURSOR_RUNTIME, "1");
          assert.strictEqual(command.options.env?.CURSOR_API_KEY, undefined);
        }
        assert.strictEqual(spawned[0]?.options.env?.NO_OPEN_BROWSER, "1");
        assert.strictEqual(spawned[1]?.options.env?.NO_OPEN_BROWSER, undefined);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not let process exit outrun the final authorization URL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseOutput = yield* Deferred.make<void>();
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            assert.ok(ChildProcess.isStandardCommand(command));
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("Expected a standard command");
            }
            if (command.args.includes("login")) {
              return makeHandle({
                allStream: Stream.unwrap(
                  Deferred.await(releaseOutput).pipe(
                    Effect.as(
                      Stream.encodeText(
                        Stream.make("Open https://cursor.com/loginDeepControl?challenge=scient\n"),
                      ),
                    ),
                  ),
                ),
                exitCode: Deferred.succeed(releaseOutput, undefined).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(1)),
                ),
              });
            }
            return yield* Effect.die(`Unexpected Cursor command: ${command.args.join(" ")}`);
          }),
        );
        const actions = yield* makeCursorConnectionActions(
          cursorSettings,
          { HOME: "/Users/test" },
          spawner,
        );

        const attempt = yield* actions.start("cursor_browser");

        assert.strictEqual(
          attempt.authorizationUrl,
          "https://cursor.com/loginDeepControl?challenge=scient",
        );
        const failure = yield* attempt.waitForCompletion.pipe(Effect.flip);
        assert.match(failure.message, /exit code 1/iu);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("verifies a login that completes before Cursor emits an authorization URL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            assert.ok(ChildProcess.isStandardCommand(command));
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("Expected a standard command");
            }
            yield* Ref.update(commands, (current) => [...current, command.args]);
            if (command.args.includes("login")) {
              return makeHandle({ all: "Already authenticated.\n" });
            }
            if (command.args.includes("about")) {
              return makeHandle({
                stdout: encodeUnknownJson({
                  cliVersion: "2026.08.11-e8db854",
                  userEmail: "scientist@example.test",
                  subscriptionTier: "Pro",
                }),
              });
            }
            return yield* Effect.die(`Unexpected Cursor command: ${command.args.join(" ")}`);
          }),
        );
        const actions = yield* makeCursorConnectionActions(
          cursorSettings,
          { HOME: "/Users/test" },
          spawner,
        );

        const attempt = yield* actions.start("cursor_browser");
        assert.strictEqual(attempt.initialStatus, "verifying");
        assert.strictEqual(attempt.authorizationUrl, undefined);
        assert.strictEqual(attempt.authorizationUrlKind, undefined);
        yield* attempt.waitForCompletion;

        assert.deepStrictEqual(yield* Ref.get(commands), [
          ["login"],
          ["about", "--format", "json"],
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a completed login when Cursor still reports no account", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            assert.ok(ChildProcess.isStandardCommand(command));
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("Expected a standard command");
            }
            if (command.args.includes("login")) {
              return makeHandle({ all: "Login process finished.\n" });
            }
            if (command.args.includes("about")) {
              return makeHandle({
                stdout: encodeUnknownJson({
                  cliVersion: "2026.08.11-e8db854",
                  userEmail: null,
                }),
              });
            }
            return yield* Effect.die(`Unexpected Cursor command: ${command.args.join(" ")}`);
          }),
        );
        const actions = yield* makeCursorConnectionActions(
          cursorSettings,
          { HOME: "/Users/test" },
          spawner,
        );

        const attempt = yield* actions.start("cursor_browser");
        assert.strictEqual(attempt.initialStatus, "verifying");
        const failure = yield* attempt.waitForCompletion.pipe(Effect.flip);
        assert.match(failure.message, /did not report a connected account/iu);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports bounded sanitized Cursor output when login exits before a secure URL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeHandle({
              all:
                "Error:\u202e proxy connection failed token=very-secret Bearer bearer-secret " +
                "https://status.example.test/private?challenge=hidden\n",
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(17)),
            }),
          ),
        );
        const actions = yield* makeCursorConnectionActions(
          cursorSettings,
          { HOME: "/Users/test" },
          spawner,
        );

        const failure = yield* actions.start("cursor_browser").pipe(Effect.flip);

        assert.match(failure.message, /proxy connection failed/iu);
        assert.match(failure.message, /token=\[redacted\]/iu);
        assert.match(failure.message, /Bearer \[redacted\]/u);
        expect(failure.message).not.toMatch(/very-secret|bearer-secret|hidden|https?:\/\//iu);
        assert.deepStrictEqual(failure.cause, {
          exitCode: 17,
          providerMessage:
            "proxy connection failed token=[redacted] Bearer [redacted] [secure sign-in URL]",
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops a login that never provides an authorization page", () =>
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
        const actions = yield* makeCursorConnectionActions(
          cursorSettings,
          { HOME: "/Users/test" },
          spawner,
        );

        const starting = yield* actions.start("cursor_browser").pipe(Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        const failure = yield* Fiber.join(starting).pipe(Effect.flip);

        assert.match(failure.message, /too long to provide/iu);
        assert.strictEqual(killed, true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("bounds an unfinished login and terminates that concrete process", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let killed = false;
        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeHandle({
              all: "Open https://cursor.com/loginDeepControl?challenge=scient\n",
              exitCode: Effect.never,
              onKill: () => {
                killed = true;
              },
            }),
          ),
        );
        const actions = yield* makeCursorConnectionActions(
          cursorSettings,
          { HOME: "/Users/test" },
          spawner,
        );

        const attempt = yield* actions.start("cursor_browser");
        const completion = yield* attempt.waitForCompletion.pipe(Effect.forkChild);
        yield* TestClock.adjust("10 minutes");
        const failure = yield* Fiber.join(completion).pipe(Effect.flip);

        assert.match(failure.message, /took too long/iu);
        assert.strictEqual(killed, true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("logs out and rejects a stale authenticated account report", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* Ref.make<ReadonlyArray<ChildProcess.StandardCommand>>([]);
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            assert.ok(ChildProcess.isStandardCommand(command));
            if (!ChildProcess.isStandardCommand(command)) {
              return yield* Effect.die("Expected a standard command");
            }
            yield* Ref.update(commands, (current) => [...current, command]);
            if (command.args.includes("logout")) return makeHandle({});
            if (command.args.includes("about")) {
              return makeHandle({
                stdout: encodeUnknownJson({
                  cliVersion: "2026.08.11-e8db854",
                  userEmail: "still-connected@example.test",
                  subscriptionTier: "Pro",
                }),
              });
            }
            return yield* Effect.die(`Unexpected Cursor command: ${command.args.join(" ")}`);
          }),
        );
        const actions = yield* makeCursorConnectionActions(
          cursorSettings,
          { HOME: "/Users/test" },
          spawner,
        );

        const failure = yield* actions.disconnect.pipe(Effect.flip);

        assert.match(failure.message, /still reports a connected account/iu);
        assert.deepStrictEqual(
          (yield* Ref.get(commands)).map((command) => command.args),
          [["logout"], ["about", "--format", "json"]],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
