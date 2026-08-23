import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  antigravityTerminalResponses,
  findAntigravityAuthorizationUrl,
  isAntigravityModelsAuthenticated,
  makeAntigravityConnectionActions,
  makeAntigravityConnectionActionsFromRuntime,
  makeAntigravityLocalCredentialStore,
  officialAntigravityAccountEnvironment,
  withAntigravitySessionShutdown,
} from "./AntigravityConnectionActions.ts";
import type { PtyProcess } from "../../terminal/PtyAdapter.ts";

describe("officialAntigravityAccountEnvironment", () => {
  it("keeps host and browser essentials while excluding provider secrets", () => {
    const environment = officialAntigravityAccountEnvironment({
      HOME: "/Users/test",
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      USERPROFILE: "C:\\Users\\scientist",
      HTTPS_PROXY: "https://proxy.example",
      BROWSER: "open",
      GOOGLE_API_KEY: "secret",
      GEMINI_API_KEY: "secret",
      GOOGLE_GEMINI_BASE_URL: "https://api-key-endpoint.example",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/service-account.json",
      UNRELATED_SECRET_TOKEN: "secret",
    });

    expect(environment.HOME).toBe("/Users/test");
    expect(environment.Path).toBe("C:\\Windows\\System32");
    expect(environment.SystemRoot).toBe("C:\\Windows");
    expect(environment.ComSpec).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(environment.USERPROFILE).toBe("C:\\Users\\scientist");
    expect(environment.HTTPS_PROXY).toBe("https://proxy.example");
    expect(environment.BROWSER).toBe("open");
    expect(environment.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
    expect(environment.DISABLE_UPDATES).toBeUndefined();
    expect(environment.GOOGLE_API_KEY).toBeUndefined();
    expect(environment.GEMINI_API_KEY).toBeUndefined();
    expect(environment.GOOGLE_GEMINI_BASE_URL).toBeUndefined();
    expect(environment.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(environment.UNRELATED_SECRET_TOKEN).toBeUndefined();
  });

  it("drops undefined values", () => {
    expect(Object.hasOwn(officialAntigravityAccountEnvironment({ HOME: undefined }), "HOME")).toBe(
      false,
    );
  });
});

describe("Antigravity local credential store", () => {
  it.layer(NodeServices.layer)(
    "removes only Antigravity's consumer token and is idempotent",
    (it) =>
      it.effect("clears the exact provider credential file", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "scient-antigravity-logout-",
          });
          const credentialDirectory = path.join(home, ".gemini", "antigravity-cli");
          const credentialFile = path.join(credentialDirectory, "antigravity-oauth-token");
          const unrelatedFile = path.join(credentialDirectory, "jetski_state.pbtxt");
          yield* fileSystem.makeDirectory(credentialDirectory, { recursive: true });
          yield* fileSystem.writeFileString(credentialFile, "provider-token");
          yield* fileSystem.writeFileString(unrelatedFile, "provider-state");

          const spawner = ChildProcessSpawner.make(() =>
            Effect.die("non-macOS credential cleanup must not invoke a process"),
          );
          const store = makeAntigravityLocalCredentialStore(
            { HOME: home },
            fileSystem,
            path,
            spawner,
            "linux",
          );
          yield* store.removeConsumerCredential;
          yield* store.removeConsumerCredential;

          expect(yield* fileSystem.exists(credentialFile)).toBe(false);
          expect(yield* fileSystem.readFileString(unrelatedFile)).toBe("provider-state");
        }).pipe(Effect.scoped),
      ),
  );

  it.layer(NodeServices.layer)("uses the exact scoped macOS Keychain deletion", (it) =>
    it.effect("treats an already-missing Keychain item as success", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "scient-antigravity-keychain-",
        });
        const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
          [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const input = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            commands.push({ command: input.command, args: input.args });
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(44)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.encodeText(
                Stream.make("The specified item could not be found in the keychain."),
              ),
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        );
        const store = makeAntigravityLocalCredentialStore(
          { HOME: home },
          fileSystem,
          path,
          spawner,
          "darwin",
        );

        yield* store.removeConsumerCredential;

        expect(commands).toEqual([
          {
            command: "/usr/bin/security",
            args: ["delete-generic-password", "-s", "gemini"],
          },
        ]);
      }).pipe(Effect.scoped),
    ),
  );
});

describe("Antigravity authorization output", () => {
  it("extracts only official Google or Antigravity HTTPS URLs", () => {
    expect(
      findAntigravityAuthorizationUrl(
        "Open https://accounts.google.com/o/oauth2/v2/auth?client_id=scient",
      ),
    ).toContain("accounts.google.com");
    expect(findAntigravityAuthorizationUrl("Open https://evil.example/oauth")).toBeUndefined();
    expect(findAntigravityAuthorizationUrl("Read https://support.google.com/help")).toBeUndefined();
    expect(
      findAntigravityAuthorizationUrl("Open https://accounts.google.com.evil.example/oauth"),
    ).toBeUndefined();
    expect(
      findAntigravityAuthorizationUrl("Open http://accounts.google.com/oauth"),
    ).toBeUndefined();
  });

  it("accepts an authenticated models probe only when it succeeds with models", () => {
    expect(
      isAntigravityModelsAuthenticated({ code: 0, stdout: "gemini-3.7-flash-high\tGemini" }),
    ).toBe(true);
    expect(isAntigravityModelsAuthenticated({ code: 1, stdout: "Please sign in" })).toBe(false);
    expect(isAntigravityModelsAuthenticated({ code: 0, stdout: "" })).toBe(false);
  });

  it("answers the terminal capability probes required by the Antigravity TUI", () => {
    expect(antigravityTerminalResponses("\u001b[?2026$p\u001b[?2027$p")).toEqual([
      "\u001b[?2026;2$y",
      "\u001b[?2027;2$y",
    ]);
    expect(antigravityTerminalResponses("ordinary output")).toEqual([]);
  });
});

describe("Antigravity connection actions", () => {
  it.effect("starts the official Google flow, verifies it, and delegates sign out", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (event: string) => Ref.update(events, (current) => [...current, event]);
      const actions = withAntigravitySessionShutdown(
        makeAntigravityConnectionActionsFromRuntime({
          startLogin: record("login").pipe(
            Effect.as({
              authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
              authorizationUrlKind: "primary" as const,
              submitAuthorizationCode: (code: string) => record(`code:${code}`),
              waitForExit: record("wait"),
              cancel: record("cancel"),
            }),
          ),
          verifyLoggedIn: record("verify"),
          logout: record("logout"),
        }),
        record("stop-sessions"),
      );

      const attempt = yield* actions.start("antigravity_google");
      expect(attempt.authorizationUrlKind).toBe("primary");
      expect(attempt.submitAuthorizationCode).toBeDefined();
      yield* attempt.submitAuthorizationCode!("google-code");
      yield* attempt.waitForCompletion;
      yield* attempt.cancel;
      yield* actions.disconnect;

      expect(yield* Ref.get(events)).toEqual([
        "login",
        "code:google-code",
        "wait",
        "verify",
        "cancel",
        "stop-sessions",
        "logout",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects unrelated connection methods", () =>
    Effect.gen(function* () {
      const actions = makeAntigravityConnectionActionsFromRuntime({
        startLogin: Effect.die("must not start"),
        verifyLoggedIn: Effect.void,
        logout: Effect.void,
      });
      const result = yield* Effect.result(actions.start("claude_subscription"));
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.scoped),
  );

  function modelsHandle(stdout: string, code = 0) {
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.encodeText(Stream.make(stdout)),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
  }

  it.effect("treats sign-out as idempotent when Antigravity is already disconnected", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(modelsHandle("", 1)));
      const actions = yield* makeAntigravityConnectionActions(
        { enabled: true, binaryPath: "/usr/local/bin/agy", customModels: [] },
        { HOME: "/Users/scientist", PATH: "/usr/bin" },
        spawner,
        { spawn: () => Effect.die("PTY must not start") },
        { removeConsumerCredential: Effect.die("credential store must not be touched") },
      );

      yield* actions.disconnect;
    }).pipe(Effect.scoped),
  );

  it.effect("removes only the provider token when onboarding blocks the logout command", () =>
    Effect.gen(function* () {
      const modelResults = [
        modelsHandle("gemini-3.7-flash-high\tGemini\n"),
        modelsHandle("gemini-3.7-flash-high\tGemini\n"),
        modelsHandle("", 1),
      ];
      let modelProbe = 0;
      let removedCredentials = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          const handle = modelResults[modelProbe++];
          if (!handle) throw new Error("unexpected models probe");
          return handle;
        }),
      );
      const pty = {
        spawn: () =>
          Effect.succeed<PtyProcess>({
            pid: 42,
            write: () => undefined,
            resize: () => undefined,
            kill: () => undefined,
            onData: (callback) => {
              callback("Choose your color scheme:");
              return () => undefined;
            },
            onExit: () => () => undefined,
          }),
      };
      const actions = yield* makeAntigravityConnectionActions(
        { enabled: true, binaryPath: "/usr/local/bin/agy", customModels: [] },
        { HOME: "/Users/scientist", PATH: "/usr/bin" },
        spawner,
        pty,
        {
          removeConsumerCredential: Effect.sync(() => {
            removedCredentials += 1;
          }),
        },
      );

      yield* actions.disconnect;

      expect(removedCredentials).toBe(1);
      expect(modelProbe).toBe(3);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "drives the real PTY seam while keeping Google account verification provider-owned",
    () =>
      Effect.gen(function* () {
        const modelResults = [
          modelsHandle("", 1),
          modelsHandle("gemini-3.7-flash-high\tGemini\n"),
          modelsHandle("gemini-3.7-flash-high\tGemini\n"),
          modelsHandle("gemini-3.7-flash-high\tGemini\n"),
          modelsHandle("", 1),
        ];
        let modelProbe = 0;
        const spawner = ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            const handle = modelResults[modelProbe++];
            if (!handle) throw new Error("unexpected models probe");
            return handle;
          }),
        );
        const writes: string[] = [];
        let kills = 0;
        const spawnInputs: Array<{
          readonly shell: string;
          readonly args?: string[];
          readonly cols?: number;
        }> = [];
        const makeProcess = (dataChunks: ReadonlyArray<string>): PtyProcess => {
          let exited = false;
          return {
            pid: 42,
            write: (data) => writes.push(data),
            resize: () => undefined,
            kill: () => {
              exited = true;
              kills += 1;
            },
            onData: (callback) => {
              for (const data of dataChunks) callback(data);
              return () => undefined;
            },
            onExit: (callback) => {
              if (exited) callback({ exitCode: 0, signal: null });
              return () => undefined;
            },
          };
        };
        const pty = {
          spawn: (input: {
            readonly shell: string;
            readonly args?: string[];
            readonly cols?: number;
          }) =>
            Effect.sync(() => {
              spawnInputs.push(input);
              return makeProcess(
                spawnInputs.length === 1
                  ? [
                      // Split the terminal query as a real PTY is allowed to do.
                      "\u001b[?202",
                      "6$p",
                      "Select login method:\r\n > 1. Google OAuth\r\n 2. Use a Google Cloud project\r\n",
                      "Open https://accounts.google.com/o/oauth2/v2/auth?client_id=scient\r\n",
                    ]
                  : ["\u001b[?2027$p"],
              );
            }),
        };
        const actions = yield* makeAntigravityConnectionActions(
          { enabled: true, binaryPath: "/usr/local/bin/agy", customModels: [] },
          { HOME: "/Users/scientist", PATH: "/usr/bin", GEMINI_API_KEY: "must-not-leak" },
          spawner,
          pty,
          { removeConsumerCredential: Effect.die("fallback must not run") },
        );

        const attempt = yield* actions.start("antigravity_google");
        expect(attempt.authorizationUrl).toContain("accounts.google.com");
        expect(attempt.authorizationUrlKind).toBe("primary");
        const invalidCode = yield* Effect.result(attempt.submitAuthorizationCode!("line\nbreak"));
        expect(invalidCode._tag).toBe("Failure");
        yield* attempt.submitAuthorizationCode!("google-one-time-code");
        yield* attempt.waitForCompletion;
        yield* actions.disconnect;

        expect(spawnInputs).toHaveLength(2);
        expect(spawnInputs[0]?.shell).toBe("/usr/local/bin/agy");
        expect(spawnInputs[0]?.cols).toBe(2_000);
        expect(spawnInputs[1]?.args).toEqual(["--prompt-interactive", "/logout"]);
        expect(writes).toEqual([
          "\u001b[?2026;2$y",
          "\r",
          "google-one-time-code\r",
          "\u001b[?2027;2$y",
        ]);
        expect(kills).toBeGreaterThanOrEqual(2);
        expect(modelProbe).toBe(5);
      }).pipe(Effect.scoped),
  );
});
