// FILE: OpenCodeTextGeneration.test.ts
// Purpose: Locks down OpenCode git text-generation behavior around server reuse,
// plain-text JSON parsing, and upstream structured-output failures.
// Depends on: OpenCodeTextGenerationServiceLive, OpenCodeRuntime, ServerConfig, TestClock.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Duration, Effect, Fiber, FileSystem, Layer, Path } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../../provider/opencodeRuntime.ts";
import { KiloTextGeneration, OpenCodeTextGeneration } from "../Services/TextGeneration.ts";
import {
  KiloTextGenerationServiceLive,
  OpenCodeTextGenerationServiceLive,
} from "./OpenCodeTextGeneration.ts";

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    startCwds: [] as Array<string | undefined>,
    startEnvs: [] as Array<NodeJS.ProcessEnv | undefined>,
    clientDirectories: [] as string[],
    sessionCreateInputs: [] as Array<Record<string, unknown>>,
    promptUrls: [] as string[],
    promptInputs: [] as Array<Record<string, unknown>>,
    authHeaders: [] as Array<string | null>,
    clientPasswords: [] as string[],
    closeCalls: [] as string[],
    startStartedResolvers: [] as Array<() => void>,
    interruptNextStart: false,
    promptStartedResolvers: [] as Array<() => void>,
    promptWaits: [] as Array<Promise<void>>,
    promptResult: undefined as
      | {
          data?: {
            info?: { error?: unknown };
            parts?: Array<{ type: string; text?: string }>;
          };
        }
      | undefined,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.startCwds.length = 0;
    this.state.startEnvs.length = 0;
    this.state.clientDirectories.length = 0;
    this.state.sessionCreateInputs.length = 0;
    this.state.promptUrls.length = 0;
    this.state.promptInputs.length = 0;
    this.state.authHeaders.length = 0;
    this.state.clientPasswords.length = 0;
    this.state.closeCalls.length = 0;
    this.state.startStartedResolvers.length = 0;
    this.state.interruptNextStart = false;
    this.state.promptStartedResolvers.length = 0;
    this.state.promptWaits.length = 0;
    this.state.promptResult = undefined;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath, cwd, env }) =>
    Effect.gen(function* () {
      const index = runtimeMock.state.startCalls.length + 1;
      const url = `http://127.0.0.1:${4_300 + index}`;
      runtimeMock.state.startCalls.push(binaryPath);
      runtimeMock.state.startCwds.push(cwd);
      runtimeMock.state.startEnvs.push(env);

      // Mirror the production scoped cleanup so we can assert idle shutdown behavior.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
        }),
      );
      runtimeMock.state.startStartedResolvers.shift()?.();
      if (runtimeMock.state.interruptNextStart) {
        runtimeMock.state.interruptNextStart = false;
        return yield* Effect.interrupt;
      }

      return {
        url,
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.succeed({
      url: serverUrl ?? "http://127.0.0.1:4301",
      exitCode: null,
      external: Boolean(serverUrl),
    }),
  runOpenCodeCommand: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "runOpenCodeCommand",
        detail: "OpenCodeRuntimeTestDouble.runOpenCodeCommand should not be used in this test",
        cause: null,
      }),
    ),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword, directory }) => {
    runtimeMock.state.clientDirectories.push(directory);
    if (serverPassword) runtimeMock.state.clientPasswords.push(serverPassword);
    return {
      session: {
        create: async (input: Record<string, unknown>) => {
          runtimeMock.state.sessionCreateInputs.push(input);
          return { data: { id: `${baseUrl}/session` } };
        },
        prompt: async (input: Record<string, unknown>) => {
          runtimeMock.state.promptUrls.push(baseUrl);
          runtimeMock.state.promptInputs.push(input);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          runtimeMock.state.promptStartedResolvers.shift()?.();
          const promptWait = runtimeMock.state.promptWaits.shift();
          if (promptWait) {
            await promptWait;
          }

          return (
            runtimeMock.state.promptResult ?? {
              data: {
                parts: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      subject: "Improve OpenCode reuse",
                      body: "Reuse one server for the full action.",
                    }),
                  },
                ],
              },
            }
          );
        },
      },
    } as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>;
  },
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory should not be used in this test",
        cause: null,
      }),
    ),
  listOpenCodeCliModels: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "listOpenCodeCliModels",
        detail: "OpenCodeRuntimeTestDouble.listOpenCodeCliModels should not be used in this test",
        cause: null,
      }),
    ),
  loadOpenCodeCredentialProviderIDs: () => Effect.succeed([]),
};

const DEFAULT_TEST_MODEL_SELECTION = {
  provider: "opencode" as const,
  model: "openai/gpt-5",
};

const OPENCODE_TEXT_GENERATION_IDLE_TTL_MS = 30_000;
const TEST_SOURCE_DATA_HOME = mkdtempSync(nodePath.join(tmpdir(), "synara-opencode-auth-test-"));
let originalXdgDataHome: string | undefined;

beforeAll(() => {
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = TEST_SOURCE_DATA_HOME;
});

afterAll(() => {
  if (originalXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalXdgDataHome;
  }
  rmSync(TEST_SOURCE_DATA_HOME, { recursive: true, force: true });
});

const OpenCodeTextGenerationServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-opencode-text-generation-test-",
});

const OpenCodeTextGenerationExistingServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-opencode-text-generation-existing-server-test-",
});

const KiloTextGenerationServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-kilo-text-generation-test-",
});

const OpenCodeTextGenerationTestLayer = Layer.mergeAll(
  NodeServices.layer,
  OpenCodeTextGenerationServiceLive.pipe(
    Layer.provide(OpenCodeTextGenerationServerConfigLayer),
    Layer.provide(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
    Layer.provide(NodeServices.layer),
  ),
);

const OpenCodeTextGenerationExistingServerTestLayer = Layer.mergeAll(
  NodeServices.layer,
  OpenCodeTextGenerationServiceLive.pipe(
    Layer.provide(OpenCodeTextGenerationExistingServerConfigLayer),
    Layer.provide(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
    Layer.provide(NodeServices.layer),
  ),
);

const KiloTextGenerationTestLayer = Layer.mergeAll(
  NodeServices.layer,
  KiloTextGenerationServiceLive.pipe(
    Layer.provide(KiloTextGenerationServerConfigLayer),
    Layer.provide(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
    Layer.provide(NodeServices.layer),
  ),
);

beforeEach(() => {
  runtimeMock.reset();
});

// Advance the shared-server idle timer without sleeping in real time.
const advanceIdleClock = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(OPENCODE_TEXT_GENERATION_IDLE_TTL_MS + 1));
  yield* Effect.yieldNow;
});

it.layer(OpenCodeTextGenerationTestLayer)("OpenCodeTextGenerationServiceLive", (it) => {
  it.effect("reuses a warm server across back-to-back requests and closes it after idling", () =>
    Effect.gen(function* () {
      const textGeneration = yield* OpenCodeTextGeneration;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-reuse",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });
      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-reuse",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      expect(runtimeMock.state.startCalls).toEqual(["opencode"]);
      expect(runtimeMock.state.startCwds).toHaveLength(1);
      expect(runtimeMock.state.startCwds[0]).toMatch(/scient-opencode-writer-.*\/workspace$/);
      const env = runtimeMock.state.startEnvs[0];
      expect(env?.XDG_CONFIG_HOME).toMatch(/scient-opencode-writer-/);
      expect(env?.XDG_DATA_HOME).toMatch(/scient-opencode-writer-/);
      expect(env?.XDG_CACHE_HOME).toMatch(/scient-opencode-writer-/);
      expect(env?.XDG_STATE_HOME).toMatch(/scient-opencode-writer-/);
      expect(env?.OPENCODE_CONFIG_DIR).toMatch(/scient-opencode-writer-/);
      expect(env).toMatchObject({
        OPENCODE_AUTO_SHARE: "false",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        OPENCODE_EXPERIMENTAL_WEBSOCKETS: "false",
        OPENCODE_PURE: "1",
        KILO_DISABLE_DEFAULT_PLUGINS: "1",
        KILO_DISABLE_CODEBASE_INDEXING: "vscode-no-workspace",
        KILO_PURE: "1",
      });
      expect(JSON.parse(env?.OPENCODE_CONFIG_CONTENT ?? "{}")).toMatchObject({
        autoupdate: false,
        share: "disabled",
        snapshot: false,
        permission: { "*": "deny" },
        plugin: [],
        mcp: {},
        agent: {},
        instructions: [],
      });
      expect(runtimeMock.state.promptUrls).toEqual([
        "http://127.0.0.1:4301",
        "http://127.0.0.1:4301",
      ]);
      expect(env?.OPENCODE_SERVER_PASSWORD).toHaveLength(43);
      expect(runtimeMock.state.clientPasswords).toEqual([
        env?.OPENCODE_SERVER_PASSWORD,
        env?.OPENCODE_SERVER_PASSWORD,
      ]);
      expect(runtimeMock.state.closeCalls).toEqual([]);

      yield* advanceIdleClock;

      expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "rotates immediately to the selected API credential and removes stale runtime data",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourceDataHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "synara-opencode-source-auth-",
        });
        const sourceProviderDirectory = path.join(sourceDataHome, "opencode");
        const sourceAuthPath = path.join(sourceProviderDirectory, "auth.json");
        yield* fileSystem.makeDirectory(sourceProviderDirectory, {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          sourceAuthPath,
          JSON.stringify({
            openai: { type: "api", key: "first-key", extra: "drop-me" },
            oauth: {
              type: "oauth",
              refresh: "refresh-token",
              access: "access-token",
              expires: 123,
              accountId: "account",
              extra: "drop-me",
            },
            organization: {
              type: "wellknown",
              key: "remote",
              token: "remote-token",
            },
          }),
        );

        const previousDataHome = process.env.XDG_DATA_HOME;
        const previousOpenCodeAuthContent = process.env.OPENCODE_AUTH_CONTENT;
        const previousKiloAuthContent = process.env.KILO_AUTH_CONTENT;
        const previousServerPassword = process.env.OPENCODE_SERVER_PASSWORD;
        yield* Effect.sync(() => {
          process.env.XDG_DATA_HOME = sourceDataHome;
          process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
            openai: { type: "wellknown", key: "poisoned", token: "poisoned" },
          });
          process.env.KILO_AUTH_CONTENT = process.env.OPENCODE_AUTH_CONTENT;
          process.env.OPENCODE_SERVER_PASSWORD = "must-not-inherit";
        });

        const textGeneration = yield* OpenCodeTextGeneration;
        yield* Effect.gen(function* () {
          yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/opencode-credential-refresh",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          const firstEnv = runtimeMock.state.startEnvs[0];
          const firstWorkingDirectory = runtimeMock.state.startCwds[0];
          expect(firstEnv?.XDG_DATA_HOME).toBeTruthy();
          expect(firstWorkingDirectory).toBeTruthy();
          expect(firstEnv?.OPENCODE_AUTH_CONTENT).toBeUndefined();
          expect(firstEnv?.KILO_AUTH_CONTENT).toBeUndefined();
          expect(firstEnv?.OPENCODE_SERVER_PASSWORD).toHaveLength(43);
          expect(firstEnv?.OPENCODE_SERVER_PASSWORD).not.toBe("must-not-inherit");
          const firstAuth = JSON.parse(
            yield* fileSystem.readFileString(
              path.join(firstEnv?.XDG_DATA_HOME ?? "", "opencode", "auth.json"),
            ),
          );
          expect(firstAuth).toEqual({
            openai: { type: "api", key: "first-key" },
          });

          const firstRuntimeRoot = path.dirname(firstWorkingDirectory ?? "");
          const firstAuthPath = path.join(firstEnv?.XDG_DATA_HOME ?? "", "opencode", "auth.json");
          yield* fileSystem.writeFileString(
            sourceAuthPath,
            JSON.stringify({ openai: { type: "api", key: "second-key" } }),
          );
          yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/opencode-credential-refresh",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
          expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
          expect(yield* fileSystem.exists(firstAuthPath)).toBe(false);
          const secondEnv = runtimeMock.state.startEnvs[1];
          expect(secondEnv?.OPENCODE_SERVER_PASSWORD).toHaveLength(43);
          expect(secondEnv?.OPENCODE_SERVER_PASSWORD).not.toBe(firstEnv?.OPENCODE_SERVER_PASSWORD);
          expect(path.dirname(runtimeMock.state.startCwds[1] ?? "")).not.toBe(firstRuntimeRoot);
          const secondAuth = JSON.parse(
            yield* fileSystem.readFileString(
              path.join(secondEnv?.XDG_DATA_HOME ?? "", "opencode", "auth.json"),
            ),
          );
          expect(secondAuth).toEqual({
            openai: { type: "api", key: "second-key" },
          });
          yield* advanceIdleClock;
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previousDataHome === undefined) {
                delete process.env.XDG_DATA_HOME;
              } else {
                process.env.XDG_DATA_HOME = previousDataHome;
              }
              if (previousOpenCodeAuthContent === undefined) {
                delete process.env.OPENCODE_AUTH_CONTENT;
              } else {
                process.env.OPENCODE_AUTH_CONTENT = previousOpenCodeAuthContent;
              }
              if (previousKiloAuthContent === undefined) {
                delete process.env.KILO_AUTH_CONTENT;
              } else {
                process.env.KILO_AUTH_CONTENT = previousKiloAuthContent;
              }
              if (previousServerPassword === undefined) {
                delete process.env.OPENCODE_SERVER_PASSWORD;
              } else {
                process.env.OPENCODE_SERVER_PASSWORD = previousServerPassword;
              }
            }),
          ),
        );
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("cleans an interrupted managed-server startup", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const textGeneration = yield* OpenCodeTextGeneration;
      runtimeMock.state.interruptNextStart = true;

      const exit = yield* Effect.exit(
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/interrupted-writer-start",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
      );
      const runtimeRoot = nodePath.dirname(runtimeMock.state.startCwds[0] ?? "");

      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

      expect(exit._tag).toBe("Failure");
      expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
      expect(yield* fileSystem.exists(runtimeRoot)).toBe(false);
    }),
  );

  it.effect("fails closed instead of cloning a rotating OAuth credential", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDataHome = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "synara-opencode-oauth-auth-",
      });
      const sourceProviderDirectory = path.join(sourceDataHome, "opencode");
      yield* fileSystem.makeDirectory(sourceProviderDirectory, {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(sourceProviderDirectory, "auth.json"),
        JSON.stringify({
          openai: {
            type: "oauth",
            refresh: "refresh-token",
            access: "access-token",
            expires: 123,
          },
        }),
      );
      const previousDataHome = process.env.XDG_DATA_HOME;
      yield* Effect.sync(() => {
        process.env.XDG_DATA_HOME = sourceDataHome;
      });

      const textGeneration = yield* OpenCodeTextGeneration;
      const error = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-oauth",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(
          Effect.flip,
          Effect.ensuring(
            Effect.sync(() => {
              if (previousDataHome === undefined) {
                delete process.env.XDG_DATA_HOME;
              } else {
                process.env.XDG_DATA_HOME = previousDataHome;
              }
            }),
          ),
        );

      expect(error.message).toContain("supports API credentials only");
      expect(runtimeMock.state.startCalls).toEqual([]);
    }),
  );

  it.effect("starts a new server after the warm server idles out", () =>
    Effect.gen(function* () {
      const textGeneration = yield* OpenCodeTextGeneration;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-reuse",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      yield* advanceIdleClock;

      yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-reuse",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      expect(runtimeMock.state.startCalls).toEqual(["opencode", "opencode"]);
      expect(runtimeMock.state.promptUrls).toEqual([
        "http://127.0.0.1:4301",
        "http://127.0.0.1:4302",
      ]);
      expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
      expect(runtimeMock.state.startEnvs[0]?.OPENCODE_SERVER_PASSWORD).not.toBe(
        runtimeMock.state.startEnvs[1]?.OPENCODE_SERVER_PASSWORD,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("isolates managed server and client paths from repository configuration", () =>
    Effect.gen(function* () {
      const textGeneration = yield* OpenCodeTextGeneration;
      const cwd = "/repo/with-local-opencode-config";
      yield* advanceIdleClock;
      runtimeMock.state.closeCalls.length = 0;

      yield* textGeneration.generateCommitMessage({
        cwd,
        branch: "feature/opencode-config",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      expect(runtimeMock.state.clientDirectories).toHaveLength(1);
      expect(runtimeMock.state.clientDirectories[0]).not.toBe(cwd);
      expect(runtimeMock.state.clientDirectories[0]).toMatch(
        /scient-opencode-writer-.*\/workspace$/,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reuses the isolated warm server when the request repository changes", () =>
    Effect.gen(function* () {
      const textGeneration = yield* OpenCodeTextGeneration;
      yield* advanceIdleClock;
      runtimeMock.state.closeCalls.length = 0;

      yield* textGeneration.generateCommitMessage({
        cwd: "/repo/alpha",
        branch: "feature/opencode-alpha",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });
      yield* textGeneration.generateCommitMessage({
        cwd: "/repo/beta",
        branch: "feature/opencode-beta",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      expect(runtimeMock.state.clientDirectories).toHaveLength(2);
      expect(new Set(runtimeMock.state.clientDirectories).size).toBe(1);
      expect(runtimeMock.state.clientDirectories[0]).not.toContain("/repo/");
      expect(runtimeMock.state.promptUrls).toHaveLength(2);
      expect(new Set(runtimeMock.state.promptUrls).size).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps concurrent repository requests inside the same isolated server scope", () =>
    Effect.gen(function* () {
      const textGeneration = yield* OpenCodeTextGeneration;
      yield* advanceIdleClock;
      runtimeMock.state.closeCalls.length = 0;
      let releaseFirstPrompt!: () => void;
      const firstPromptStarted = new Promise<void>((resolve) => {
        runtimeMock.state.promptStartedResolvers.push(resolve);
      });
      runtimeMock.state.promptWaits.push(
        new Promise<void>((resolve) => {
          releaseFirstPrompt = resolve;
        }),
      );

      const firstFiber = yield* textGeneration
        .generateCommitMessage({
          cwd: "/repo/alpha",
          branch: "feature/opencode-alpha",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.forkChild);

      yield* Effect.promise(() => firstPromptStarted);

      yield* textGeneration.generateCommitMessage({
        cwd: "/repo/beta",
        branch: "feature/opencode-beta",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      releaseFirstPrompt();
      yield* Fiber.join(firstFiber);

      expect(runtimeMock.state.clientDirectories).toHaveLength(2);
      expect(new Set(runtimeMock.state.clientDirectories).size).toBe(1);
      expect(runtimeMock.state.clientDirectories[0]).not.toContain("/repo/");
      expect(runtimeMock.state.promptUrls).toHaveLength(2);
      expect(new Set(runtimeMock.state.promptUrls).size).toBe(1);
      expect(runtimeMock.state.closeCalls).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("returns a typed empty-output error when OpenCode returns no text parts", () =>
    Effect.gen(function* () {
      runtimeMock.state.promptResult = { data: {} };
      const textGeneration = yield* OpenCodeTextGeneration;

      const error = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.flip);

      expect(error.message).toContain("OpenCode returned empty output.");
    }),
  );

  it.effect("parses JSON returned inside plain text output", () =>
    Effect.gen(function* () {
      runtimeMock.state.promptResult = {
        data: {
          parts: [
            {
              type: "text",
              text: 'Here is the result:\n{"subject":"Tighten OpenCode parsing","body":"Handle JSON text output locally."}',
            },
          ],
        },
      };
      const textGeneration = yield* OpenCodeTextGeneration;

      const result = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/opencode-reuse",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      expect(result).toEqual({
        subject: "Tighten OpenCode parsing",
        body: "Handle JSON text output locally.",
      });
    }),
  );

  it.effect("pins the selected OpenCode model on generated sessions", () =>
    Effect.gen(function* () {
      runtimeMock.state.promptResult = {
        data: {
          parts: [{ type: "text", text: JSON.stringify({ title: "Model check" }) }],
        },
      };
      const textGeneration = yield* OpenCodeTextGeneration;

      yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "which model are you",
        modelSelection: {
          provider: "opencode",
          model: "opencode/big-pickle",
          options: {
            agent: "build",
            variant: "fast",
          },
        },
      });

      expect(runtimeMock.state.sessionCreateInputs[0]).toMatchObject({
        model: {
          providerID: "opencode",
          id: "big-pickle",
          variant: "fast",
        },
        agent: "build",
      });
    }),
  );

  it.effect("projects generic attachments into text-generation prompts", () =>
    Effect.gen(function* () {
      runtimeMock.state.promptResult = {
        data: {
          parts: [
            {
              type: "text",
              text: JSON.stringify({ title: "Meeting recap" }),
            },
          ],
        },
      };
      const textGeneration = yield* OpenCodeTextGeneration;

      yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "summarize this",
        attachments: [
          {
            type: "file" as const,
            id: "thread-title-docx-00000000-0000-4000-8000-000000000001",
            name: "minutes.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            sizeBytes: 4_096,
          },
        ],
        modelSelection: DEFAULT_TEST_MODEL_SELECTION,
      });

      const parts = runtimeMock.state.promptInputs[0]?.parts as
        | Array<Record<string, unknown>>
        | undefined;
      expect(parts).toHaveLength(1);
      expect(parts?.[0]).toMatchObject({ type: "text" });
      expect(parts?.[0]?.text).toEqual(expect.stringContaining("<attached_files>"));
      expect(parts?.[0]?.text).toEqual(expect.stringContaining('"minutes.docx"'));
      expect(parts?.[0]?.text).toEqual(
        expect.stringContaining(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
      );
    }),
  );

  it.effect("surfaces the upstream structured-output error message", () =>
    Effect.gen(function* () {
      runtimeMock.state.promptResult = {
        data: {
          info: {
            error: {
              name: "StructuredOutputError",
              data: {
                message: "Model did not produce structured output",
                retries: 2,
              },
            },
          },
        },
      };
      const textGeneration = yield* OpenCodeTextGeneration;

      const error = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.flip);

      expect(error.message).toContain("Model did not produce structured output");
    }),
  );
});

it.layer(OpenCodeTextGenerationExistingServerTestLayer)(
  "OpenCodeTextGenerationServiceLive with configured server URL",
  (it) => {
    it.effect("fails closed before sending source-control content to an external server", () =>
      Effect.gen(function* () {
        const textGeneration = yield* OpenCodeTextGeneration;

        const error = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/opencode-reuse",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            providerOptions: {
              opencode: {
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          })
          .pipe(Effect.flip);

        expect(error.message).toContain("not permitted for automatic source-control writing");
        expect(runtimeMock.state.startCalls).toEqual([]);
        expect(runtimeMock.state.sessionCreateInputs).toEqual([]);
        expect(runtimeMock.state.promptUrls).toEqual([]);
      }),
    );
  },
);

it.layer(KiloTextGenerationTestLayer)("KiloTextGenerationServiceLive", (it) => {
  it.effect("uses the same isolated no-extension runtime boundary for Kilo", () =>
    Effect.gen(function* () {
      const textGeneration = yield* KiloTextGeneration;
      const previousKiloAuthContent = process.env.KILO_AUTH_CONTENT;
      yield* Effect.sync(() => {
        process.env.KILO_AUTH_CONTENT = JSON.stringify({
          openai: { type: "wellknown", key: "poisoned", token: "poisoned" },
        });
      });
      yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/kilo-isolation",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            provider: "kilo",
            model: "openai/gpt-5",
          },
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previousKiloAuthContent === undefined) {
                delete process.env.KILO_AUTH_CONTENT;
              } else {
                process.env.KILO_AUTH_CONTENT = previousKiloAuthContent;
              }
            }),
          ),
        );

      expect(runtimeMock.state.startCalls).toEqual(["kilo"]);
      const env = runtimeMock.state.startEnvs[0];
      expect(env?.XDG_DATA_HOME).toMatch(/scient-kilo-writer-/);
      expect(env?.KILO_CONFIG_CONTENT).toBeTruthy();
      expect(env?.KILO_AUTH_CONTENT).toBeUndefined();
      expect(env?.KILO_SERVER_PASSWORD).toHaveLength(43);
      expect(env?.OPENCODE_SERVER_PASSWORD).toBeUndefined();
      expect(runtimeMock.state.clientPasswords).toEqual([env?.KILO_SERVER_PASSWORD]);
      expect(env).toMatchObject({
        OPENCODE_AUTO_SHARE: "false",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
        KILO_DISABLE_DEFAULT_PLUGINS: "1",
        KILO_DISABLE_CODEBASE_INDEXING: "vscode-no-workspace",
        KILO_PURE: "1",
      });
      expect(runtimeMock.state.clientDirectories[0]).toMatch(/scient-kilo-writer-.*\/workspace$/);
    }),
  );
});
