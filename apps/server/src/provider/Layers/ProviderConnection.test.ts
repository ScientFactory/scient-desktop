import type {
  ProviderKind,
  ServerProviderConnectionState,
  ServerProviderInstallationState,
  ServerProviderRuntimeSource,
  ServerProviderStatus,
} from "@synara/contracts";
import { Duration, Effect, Fiber, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it, vi } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../../config";
import { ServerSettingsService } from "../../serverSettings";
import {
  PtyAdapter,
  type PtyAdapterShape,
  type PtyProcess,
  type PtySpawnInput,
} from "../../terminal/Services/PTY";
import { probeDroidAcpAuthentication } from "../acp/DroidAcpSupport";
import { ProviderConnection } from "../Services/ProviderConnection";
import {
  ProviderDiscoveryService,
  type ProviderDiscoveryServiceShape,
} from "../Services/ProviderDiscoveryService";
import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";
import {
  ProviderRuntimeManager,
  type ProviderRuntimeManagerShape,
} from "../Services/ProviderRuntimeManager";

import {
  antigravityAuthenticationCommandArgs,
  expectedMethodForProvider,
  makeProviderConnectionLive,
  parseAntigravityOAuthAuthorizationUrl,
  parseCodexDeviceAuthorization,
  parseCodexOAuthAuthorizationUrl,
  parseGrokOAuthAuthorizationUrl,
  providerConnectionCommandArgs,
} from "./ProviderConnection";
import { resolveProviderProbeCwd } from "./ProviderHealth";

const encoder = new TextEncoder();

interface CapturedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly cwd?: string;
    readonly stdin?: unknown;
  };
}

const TEST_CONFIG: ServerConfigShape = {
  mode: "web",
  port: 0,
  host: undefined,
  cwd: "/tmp",
  homeDir: "/tmp",
  chatWorkspaceRoot: "/tmp/chat",
  studioWorkspaceRoot: "/tmp/studio",
  baseDir: "/tmp/scient-test",
  staticDir: undefined,
  devUrl: undefined,
  noBrowser: true,
  authToken: undefined,
  autoBootstrapProjectFromCwd: false,
  logProviderEvents: false,
  logWebSocketEvents: false,
  stateDir: "/tmp/scient-test/state",
  secretsDir: "/tmp/scient-test/secrets",
  dbPath: "/tmp/scient-test/state.sqlite",
  settingsPath: "/tmp/scient-test/settings.json",
  keybindingsConfigPath: "/tmp/scient-test/keybindings.json",
  worktreesDir: "/tmp/scient-test/worktrees",
  attachmentsDir: "/tmp/scient-test/attachments",
  logsDir: "/tmp/scient-test/logs",
  serverLogPath: "/tmp/scient-test/logs/server.log",
  serverRuntimeStatePath: "/tmp/scient-test/server-runtime.json",
  providerLogsDir: "/tmp/scient-test/logs/provider",
  providerEventLogPath: "/tmp/scient-test/logs/provider/events.log",
  terminalLogsDir: "/tmp/scient-test/logs/terminal",
  anonymousIdPath: "/tmp/scient-test/anonymous-id",
  environmentIdPath: "/tmp/scient-test/environment-id",
};
const TEST_PROVIDER_PROBE_CWD = resolveProviderProbeCwd(TEST_CONFIG.stateDir);

function makeHandle(input: {
  readonly code?: number;
  readonly delayMs?: number;
  readonly hanging?: boolean;
  readonly stdout?: string;
  onKill?: () => void;
}) {
  const delay = input.delayMs
    ? <A>(effect: Effect.Effect<A>) =>
        Effect.sleep(Duration.millis(input.delayMs!)).pipe(Effect.andThen(effect))
    : <A>(effect: Effect.Effect<A>) => effect;
  const stdout = Stream.make(encoder.encode(input.stdout ?? "browser opened"));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(41),
    exitCode: input.hanging
      ? Effect.never
      : delay(Effect.succeed(ChildProcessSpawner.ExitCode(input.code ?? 0))),
    isRunning: Effect.succeed(Boolean(input.hanging)),
    kill: () => Effect.sync(() => input.onKill?.()),
    stdin: Sink.drain,
    stdout: input.hanging
      ? input.stdout
        ? Stream.concat(Stream.make(encoder.encode(input.stdout)), Stream.never)
        : Stream.never
      : input.delayMs
        ? Stream.fromEffect(Effect.sleep(Duration.millis(input.delayMs))).pipe(
            Stream.flatMap(() => stdout),
          )
        : stdout,
    stderr: input.hanging ? Stream.never : Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function makeConnectionTestLayer(input?: {
  readonly available?: boolean;
  readonly hanging?: boolean;
  readonly processExitCode?: number;
  readonly processStdout?: string;
  readonly provider?: ProviderKind;
  readonly runtimeSource?: ServerProviderRuntimeSource;
  readonly timeout?: Duration.Duration;
  readonly antigravityCodeWindowTimeout?: Duration.Duration;
  readonly antigravityCodeWindowCloseSignal?: Effect.Effect<void>;
  readonly antigravityTimeout?: Duration.Duration;
  readonly antigravityAuthenticationProbeInterval?: Duration.Duration;
  readonly antigravityAuthenticationSettleTimeout?: Duration.Duration;
  readonly beforeAntigravityOutputPublication?: Effect.Effect<void>;
  readonly afterAntigravityCodeWindowInputClosed?: Effect.Effect<void>;
  readonly onSpawn?: (command: CapturedCommand) => void;
  readonly onStdinChunk?: (command: CapturedCommand, chunk: Uint8Array) => void;
  readonly ptyOutputChunks?: ReadonlyArray<string>;
  readonly ptyOutputDelayMs?: number;
  readonly onPtyReady?: (emitData: (data: string) => void) => void;
  readonly processForCommand?: (command: CapturedCommand) => {
    readonly code?: number;
    readonly delayMs?: number;
    readonly exitOnWrite?: boolean;
    readonly hanging?: boolean;
    readonly stdout?: string;
    readonly onKill?: () => void;
  };
  readonly onKill?: () => void;
  readonly droidAuthenticationProbe?: typeof probeDroidAcpAuthentication;
  readonly modelsAvailable?: boolean;
  readonly listModelsHanging?: boolean;
  readonly initiallyAuthenticated?: boolean;
  readonly requiresProviderAccount?: boolean | null;
  readonly installationState?:
    | ServerProviderInstallationState
    | (() => ServerProviderInstallationState | null);
  readonly onListModels?: (input: {
    readonly provider: ProviderKind;
    readonly binaryPath?: string;
    readonly cwd?: string;
  }) => void;
}) {
  let connectionState: ServerProviderConnectionState | undefined;
  const connectionStateWaiters = new Set<
    (state: ServerProviderConnectionState | undefined) => void
  >();
  let authenticated = input?.initiallyAuthenticated ?? false;
  let refreshCalls = 0;
  const status = (): ServerProviderStatus => ({
    provider: input?.provider ?? "claudeAgent",
    status: authenticated ? "ready" : "error",
    available: input?.available ?? true,
    authStatus: authenticated ? "authenticated" : "unauthenticated",
    ...(input?.requiresProviderAccount === null
      ? {}
      : input?.requiresProviderAccount !== undefined
        ? { requiresProviderAccount: input.requiresProviderAccount }
        : input?.provider === "codex"
          ? { requiresProviderAccount: true }
          : {}),
    checkedAt: new Date().toISOString(),
    ...(connectionState ? { connectionState } : {}),
  });
  const providerHealthLayer = Layer.succeed(ProviderHealth, {
    getStatuses: Effect.sync(() => [status()]),
    refresh: Effect.sync(() => {
      refreshCalls += 1;
      // The first refresh is the preflight. A completed sign-in is verified by
      // the following refresh, unless the fixture began authenticated.
      if (refreshCalls > 1 && input?.hanging !== true) authenticated = true;
      return [status()];
    }),
    updateProvider: () => Effect.die("unused"),
    setConnectionState: (_provider, state) =>
      Effect.sync(() => {
        connectionState = state ?? undefined;
        for (const waiter of [...connectionStateWaiters]) waiter(connectionState);
        return [status()];
      }),
    streamChanges: Stream.empty,
  } satisfies ProviderHealthShape);
  const providerDiscoveryLayer = Layer.succeed(ProviderDiscoveryService, {
    getComposerCapabilities: () => Effect.die("unused"),
    listCommands: () => Effect.die("unused"),
    listSkills: () => Effect.die("unused"),
    listPlugins: () => Effect.die("unused"),
    readPlugin: () => Effect.die("unused"),
    listModels: ({ provider, binaryPath, cwd }) =>
      input?.listModelsHanging
        ? Effect.never
        : Effect.sync(() => {
            input?.onListModels?.({
              provider,
              ...(binaryPath ? { binaryPath } : {}),
              ...(cwd ? { cwd } : {}),
            });
            return {
              models:
                input?.modelsAvailable === false
                  ? []
                  : [{ slug: `${provider}-test-model`, name: `${provider} test model` }],
              source: "test",
              cached: false,
            };
          }),
    listAgents: () => Effect.die("unused"),
  } satisfies ProviderDiscoveryServiceShape);
  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const captured = command as unknown as CapturedCommand;
      input?.onSpawn?.(captured);
      const process = input?.processForCommand?.(captured);
      const handle = makeHandle({
        ...(process?.delayMs !== undefined ? { delayMs: process.delayMs } : {}),
        ...(process?.code !== undefined
          ? { code: process.code }
          : input?.processExitCode !== undefined
            ? { code: input.processExitCode }
            : {}),
        ...(process?.hanging !== undefined
          ? { hanging: process.hanging }
          : input?.hanging !== undefined
            ? { hanging: input.hanging }
            : {}),
        ...(process?.onKill
          ? { onKill: process.onKill }
          : input?.onKill
            ? { onKill: input.onKill }
            : {}),
        ...(process?.stdout
          ? { stdout: process.stdout }
          : input?.processStdout
            ? { stdout: input.processStdout }
            : {}),
      });
      return Effect.succeed(handle);
    }),
  );
  const ptyLayer = Layer.succeed(PtyAdapter, {
    spawn: (ptyInput: PtySpawnInput) =>
      Effect.sync(() => {
        const captured: CapturedCommand = {
          command: ptyInput.shell,
          args: ptyInput.args ?? [],
          options: { cwd: ptyInput.cwd },
        };
        input?.onSpawn?.(captured);
        const configured = input?.processForCommand?.(captured);
        const hanging = configured?.hanging ?? input?.hanging ?? false;
        const stdout = configured?.stdout ?? input?.processStdout ?? "browser opened";
        const outputChunks = input?.ptyOutputChunks ?? (stdout ? [stdout] : []);
        const exitCode = configured?.code ?? input?.processExitCode ?? 0;
        const onKill = configured?.onKill ?? input?.onKill;
        let exited = false;
        const dataListeners = new Set<(data: string) => void>();
        const exitListeners = new Set<
          (event: { exitCode: number; signal: number | null }) => void
        >();
        input?.onPtyReady?.((data) => {
          for (const listener of dataListeners) listener(data);
        });
        const emitExit = () => {
          if (exited) return;
          exited = true;
          for (const listener of exitListeners) listener({ exitCode, signal: null });
        };
        const process: PtyProcess = {
          pid: 42,
          write: (data) => {
            input?.onStdinChunk?.(captured, encoder.encode(data));
            if (configured?.exitOnWrite) emitExit();
          },
          resize: () => undefined,
          kill: () => {
            onKill?.();
            emitExit();
          },
          pause: () => undefined,
          resume: () => undefined,
          onData: (listener) => {
            dataListeners.add(listener);
            if (outputChunks.length > 0) {
              const emit = () => {
                if (!dataListeners.has(listener)) return;
                for (const chunk of outputChunks) listener(chunk);
              };
              if (input?.ptyOutputDelayMs) setTimeout(emit, input.ptyOutputDelayMs);
              else queueMicrotask(emit);
            }
            return () => dataListeners.delete(listener);
          },
          onExit: (listener) => {
            exitListeners.add(listener);
            if (!hanging) {
              const emit = () => exitListeners.has(listener) && emitExit();
              if (configured?.delayMs) setTimeout(emit, configured.delayMs);
              else queueMicrotask(emit);
            }
            return () => exitListeners.delete(listener);
          },
        };
        return process;
      }),
  } satisfies PtyAdapterShape);
  const providerRuntimeLayer = Layer.succeed(ProviderRuntimeManager, {
    prepareInstall: () => Effect.die("unused"),
    install: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    repair: () => Effect.die("unused"),
    rollback: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    getSnapshot: (provider) =>
      Effect.succeed({
        provider,
        managedExecutablePath: null,
        managedVersion: null,
        previousReleaseAvailable: false,
        bundled: false,
        canInstall: false,
        installationState:
          typeof input?.installationState === "function"
            ? input.installationState()
            : (input?.installationState ?? null),
      }),
    resolve: (provider, configured) =>
      Effect.succeed({
        source: input?.available === false ? "missing" : (input?.runtimeSource ?? "system"),
        executable:
          input?.available === false
            ? null
            : configured?.trim() ||
              (provider === "claudeAgent"
                ? "claude"
                : provider === "antigravity"
                  ? "agy"
                  : provider),
        managedVersion: null,
        canInstall: false,
        canRepair: false,
        canRollback: false,
        canRemove: false,
        message: null,
      }),
    streamChanges: Stream.empty,
  } satisfies ProviderRuntimeManagerShape);
  const layer = makeProviderConnectionLive({
    ...(input?.timeout ? { timeout: input.timeout } : {}),
    ...(input?.antigravityCodeWindowTimeout
      ? { antigravityCodeWindowTimeout: input.antigravityCodeWindowTimeout }
      : {}),
    ...(input?.antigravityCodeWindowCloseSignal
      ? { antigravityCodeWindowCloseSignal: input.antigravityCodeWindowCloseSignal }
      : {}),
    ...(input?.antigravityTimeout ? { antigravityTimeout: input.antigravityTimeout } : {}),
    ...(input?.antigravityAuthenticationProbeInterval
      ? {
          antigravityAuthenticationProbeInterval: input.antigravityAuthenticationProbeInterval,
        }
      : {}),
    ...(input?.antigravityAuthenticationSettleTimeout
      ? {
          antigravityAuthenticationSettleTimeout: input.antigravityAuthenticationSettleTimeout,
        }
      : {}),
    ...(input?.beforeAntigravityOutputPublication
      ? { beforeAntigravityOutputPublication: input.beforeAntigravityOutputPublication }
      : {}),
    ...(input?.afterAntigravityCodeWindowInputClosed
      ? { afterAntigravityCodeWindowInputClosed: input.afterAntigravityCodeWindowInputClosed }
      : {}),
    ...(input?.droidAuthenticationProbe
      ? { droidAuthenticationProbe: input.droidAuthenticationProbe }
      : {}),
  }).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(Layer.succeed(ServerConfig, TEST_CONFIG)),
    Layer.provideMerge(providerHealthLayer),
    Layer.provideMerge(providerDiscoveryLayer),
    Layer.provideMerge(providerRuntimeLayer),
    Layer.provideMerge(spawnerLayer),
    Layer.provideMerge(ptyLayer),
  );
  const waitForConnectionState = (
    predicate: (state: ServerProviderConnectionState | undefined) => boolean,
  ) => {
    if (predicate(connectionState)) return Promise.resolve(connectionState);
    return new Promise<ServerProviderConnectionState | undefined>((resolve) => {
      const waiter = (state: ServerProviderConnectionState | undefined) => {
        if (!predicate(state)) return;
        connectionStateWaiters.delete(waiter);
        resolve(state);
      };
      connectionStateWaiters.add(waiter);
    });
  };
  return { layer, getConnectionState: () => connectionState, waitForConnectionState };
}

describe("provider connection command allowlist", () => {
  it("uses Codex browser login with fixed argv", () => {
    expect(expectedMethodForProvider("codex")).toBe("codex_browser");
    expect(providerConnectionCommandArgs("codex", "codex_browser")).toEqual(["login"]);
    expect(providerConnectionCommandArgs("codex", "codex_device_code")).toEqual([
      "login",
      "--device-auth",
    ]);
  });

  it("uses normal Claude account login by default and keeps explicit alternatives", () => {
    expect(expectedMethodForProvider("claudeAgent")).toBe("claude_account");
    expect(providerConnectionCommandArgs("claudeAgent", "claude_account")).toEqual([
      "auth",
      "login",
    ]);
    expect(providerConnectionCommandArgs("claudeAgent", "claude_sso")).toEqual([
      "auth",
      "login",
      "--sso",
    ]);
    expect(providerConnectionCommandArgs("claudeAgent", "claude_console")).toEqual([
      "auth",
      "login",
      "--console",
    ]);
  });

  it("uses Cursor browser login with fixed argv", () => {
    expect(expectedMethodForProvider("cursor")).toBe("cursor_browser");
    expect(providerConnectionCommandArgs("cursor", "cursor_browser")).toEqual(["login"]);
  });

  it("selects Antigravity's provider-owned browser login strategy", () => {
    expect(expectedMethodForProvider("antigravity")).toBe("antigravity_browser");
    expect(providerConnectionCommandArgs("antigravity", "antigravity_browser")).toEqual([]);
  });

  it("uses Grok's provider-owned browser login", () => {
    expect(expectedMethodForProvider("grok")).toBe("grok_browser");
    expect(providerConnectionCommandArgs("grok", "grok_browser")).toEqual(["login", "--oauth"]);
  });

  it("uses Droid's ACP device-pairing authentication", () => {
    expect(expectedMethodForProvider("droid")).toBe("droid_device_pairing");
    expect(providerConnectionCommandArgs("droid", "droid_device_pairing")).toEqual([
      "exec",
      "--output-format",
      "acp",
    ]);
  });

  it("does not construct commands for mismatched or unsupported providers", () => {
    expect(providerConnectionCommandArgs("codex", "claude_console")).toBeNull();
    expect(providerConnectionCommandArgs("claudeAgent", "claude_subscription")).toBeNull();
    expect(providerConnectionCommandArgs("cursor", "codex_browser")).toBeNull();
    expect(expectedMethodForProvider("opencode")).toBeNull();
  });
});

describe("Codex authorization output parsing", () => {
  const authorizationUrl =
    "https://auth.openai.com/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=test-state&code_challenge=test-challenge&code_challenge_method=S256";

  it("accepts only an official PKCE browser authorization URL", () => {
    expect(parseCodexOAuthAuthorizationUrl(`Open this URL:\n${authorizationUrl}\n`)).toBe(
      authorizationUrl,
    );
    expect(
      parseCodexOAuthAuthorizationUrl(
        authorizationUrl.replace("auth.openai.com", "auth.openai.com.example.com"),
      ),
    ).toBeNull();
    expect(
      parseCodexOAuthAuthorizationUrl(authorizationUrl.replace("code_challenge", "ignored")),
    ).toBeNull();
    expect(
      parseCodexOAuthAuthorizationUrl(
        authorizationUrl.replace(
          "http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
          "https%3A%2F%2Fexample.com%2Fcallback",
        ),
      ),
    ).toBeNull();
  });

  it("extracts the official device page and bounded one-time code", () => {
    expect(
      parseCodexDeviceAuthorization(
        "1. Open this link\n\u001B[34mhttps://auth.openai.com/codex/device\u001B[0m\n2. Enter this one-time code\n\u001B[34mABCD-EFGH\u001B[0m\n",
      ),
    ).toEqual({
      authorizationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    });
    expect(
      parseCodexDeviceAuthorization(
        "https://auth.openai.com.example.com/codex/device\nnot-a-device-code",
      ),
    ).toEqual({});
  });
});

describe("Grok OAuth authorization URL parsing", () => {
  const authorizationUrl =
    "https://auth.x.ai/oauth2/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A50418%2Fcallback&state=test-state&code_challenge=test-challenge";

  it("accepts the exact xAI authorization route with a loopback callback", () => {
    expect(parseGrokOAuthAuthorizationUrl(`Open this URL:\n${authorizationUrl}\n`)).toBe(
      authorizationUrl,
    );
  });

  it("rejects lookalike hosts and callbacks that are not local", () => {
    expect(
      parseGrokOAuthAuthorizationUrl(
        authorizationUrl.replace("auth.x.ai", "auth.x.ai.example.com"),
      ),
    ).toBeNull();
    expect(
      parseGrokOAuthAuthorizationUrl(
        authorizationUrl.replace("127.0.0.1%3A50418", "example.com%3A50418"),
      ),
    ).toBeNull();
    expect(parseGrokOAuthAuthorizationUrl(`${authorizationUrl}#unexpected-fragment`)).toBeNull();
  });
});

describe("Antigravity OAuth authorization URL parsing", () => {
  const authorizationUrl =
    "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&client_id=test-client&state=test-state&code_challenge=test-challenge&code_challenge_method=S256";

  it("accepts Google's authorization route only for Antigravity's callback", () => {
    expect(parseAntigravityOAuthAuthorizationUrl(`Open this URL:\n${authorizationUrl}\n`)).toBe(
      authorizationUrl,
    );
  });

  it("rejects lookalike Google hosts, foreign callbacks, and incomplete PKCE", () => {
    expect(
      parseAntigravityOAuthAuthorizationUrl(
        authorizationUrl.replace("accounts.google.com", "accounts.google.com.example.com"),
      ),
    ).toBeNull();
    expect(
      parseAntigravityOAuthAuthorizationUrl(
        authorizationUrl.replace(
          "antigravity.google%2Foauth-callback",
          "example.com%2Foauth-callback",
        ),
      ),
    ).toBeNull();
    expect(
      parseAntigravityOAuthAuthorizationUrl(
        authorizationUrl.replace("code_challenge_method=S256", "code_challenge_method=plain"),
      ),
    ).toBeNull();
  });

  it("uses a sandboxed no-task print bootstrap with an impossible per-operation model", () => {
    expect(antigravityAuthenticationCommandArgs("operation-1")).toEqual([
      "--sandbox",
      "--mode",
      "plan",
      "--model",
      "__scient_auth_only_operation-1",
      "--print-timeout",
      "600s",
      "--print",
      "Authenticate this Antigravity CLI only. Do not inspect or modify files and do not perform a task.",
    ]);
  });
});

describe("ProviderConnectionLive", () => {
  it("waits for the exact installation operation before starting sign-in", async () => {
    const onSpawn = vi.fn();
    let installationState: ServerProviderInstallationState = {
      operationId: "trusted-plan-transition",
      operation: "install",
      status: "downloading",
      startedAt: "2026-07-23T10:00:00.000Z",
      finishedAt: null,
      message: "Downloading Codex.",
    };
    const fixture = makeConnectionTestLayer({
      provider: "codex",
      installationState: () => installationState,
      onSpawn,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        yield* connection.startAfterInstallation({
          provider: "codex",
          method: "codex_browser",
          installationOperationId: "trusted-plan-transition",
        });
        yield* Effect.sleep(Duration.millis(20));
        expect(onSpawn).not.toHaveBeenCalled();
        installationState = {
          ...installationState,
          status: "installed",
          finishedAt: "2026-07-23T10:00:02.000Z",
          message: "Codex is installed and verified.",
        };
        const connected = fixture.waitForConnectionState((state) => state?.status === "connected");
        yield* Effect.promise(() => connected);
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: "codex", args: ["login"] }),
    );
  });

  it.each(["failed", "cancelled"] as const)(
    "does not start sign-in after the exact installation operation is %s",
    async (status) => {
      const onSpawn = vi.fn();
      const fixture = makeConnectionTestLayer({
        provider: "codex",
        installationState: {
          operationId: `trusted-plan-${status}`,
          operation: "install",
          status,
          startedAt: "2026-07-23T10:00:00.000Z",
          finishedAt: "2026-07-23T10:00:02.000Z",
          message: `Installation ${status}.`,
        },
        onSpawn,
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          const connection = yield* ProviderConnection;
          yield* connection.startAfterInstallation({
            provider: "codex",
            method: "codex_browser",
            installationOperationId: `trusted-plan-${status}`,
          });
          yield* Effect.sleep(Duration.millis(40));
        }).pipe(Effect.provide(fixture.layer)),
      );

      expect(onSpawn).not.toHaveBeenCalled();
    },
  );

  it("starts sign-in only after the exact requested installation succeeds", async () => {
    const onSpawn = vi.fn();
    const installationState = {
      operationId: "trusted-plan-1",
      operation: "install",
      status: "installed",
      startedAt: "2026-07-23T10:00:00.000Z",
      finishedAt: "2026-07-23T10:00:02.000Z",
      message: "Codex is installed and verified.",
    } satisfies ServerProviderInstallationState;
    const fixture = makeConnectionTestLayer({
      provider: "codex",
      installationState,
      onSpawn,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        yield* connection.startAfterInstallation({
          provider: "codex",
          method: "codex_browser",
          installationOperationId: "different-plan",
        });
        yield* Effect.sleep(Duration.millis(20));
        expect(onSpawn).not.toHaveBeenCalled();
        yield* connection.startAfterInstallation({
          provider: "codex",
          method: "codex_browser",
          installationOperationId: "trusted-plan-1",
        });
        const connected = fixture.waitForConnectionState((state) => state?.status === "connected");
        yield* Effect.promise(() => connected);
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: "codex", args: ["login"] }),
    );
  });

  it("publishes Codex's official device page and one-time code", async () => {
    const fixture = makeConnectionTestLayer({
      provider: "codex",
      hanging: true,
      processStdout:
        "1. Open this link\nhttps://auth.openai.com/codex/device\n2. Enter this one-time code\nABCD-EFGH\n",
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const codePublished = fixture.waitForConnectionState(
          (state) => state?.userCode === "ABCD-EFGH",
        );
        const started = yield* connection.start({
          provider: "codex",
          method: "codex_device_code",
        });
        const operationId = started.providers[0]?.connectionState?.operationId;
        yield* Effect.promise(() => codePublished);
        expect(fixture.getConnectionState()).toMatchObject({
          authorizationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
        });
        yield* connection.cancel({ provider: "codex", operationId: operationId! });
      }).pipe(Effect.provide(fixture.layer)),
    );
  });

  it("runs managed Antigravity's browser-auth bootstrap and verifies models", async () => {
    const onSpawn = vi.fn();
    const onAuthenticationKill = vi.fn();
    const onListModels = vi.fn();
    let modelProbeCount = 0;
    const fixture = makeConnectionTestLayer({
      provider: "antigravity",
      runtimeSource: "managed",
      onSpawn,
      onListModels,
      processForCommand: ({ args }) => {
        if (args.includes("--print")) {
          return { hanging: true, onKill: onAuthenticationKill };
        }
        modelProbeCount += 1;
        return modelProbeCount === 1
          ? { code: 1, stdout: "Error: Please sign in to view available models.\n" }
          : { code: 0, stdout: "Gemini 3.5 Flash (High)\n" };
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        yield* connection.start({
          provider: "antigravity",
          method: "antigravity_browser",
        });
        yield* Effect.sleep(Duration.millis(650));
        expect(fixture.getConnectionState()?.status).toBe("connected");
      }).pipe(Effect.provide(fixture.layer)),
    );

    const authenticationSpawn = onSpawn.mock.calls.find(([spawn]) =>
      (spawn as { args: ReadonlyArray<string> }).args.includes("--print"),
    )?.[0] as CapturedCommand | undefined;
    expect(authenticationSpawn).toMatchObject({
      command: "agy",
      options: { cwd: TEST_PROVIDER_PROBE_CWD },
    });
    expect(authenticationSpawn?.args).toEqual(
      expect.arrayContaining(["--sandbox", "--mode", "plan", "--model", "--print"]),
    );
    expect(authenticationSpawn?.args[4]).toMatch(/^__scient_auth_only_[0-9a-f-]+$/u);
    expect(
      onSpawn.mock.calls
        .map(([spawn]) => spawn as CapturedCommand)
        .filter((spawn) => spawn.args.includes("models")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          options: expect.objectContaining({ cwd: TEST_PROVIDER_PROBE_CWD }),
        }),
      ]),
    );
    expect(onAuthenticationKill).toHaveBeenCalledTimes(1);
    expect(onListModels).toHaveBeenCalledWith({
      provider: "antigravity",
      binaryPath: "agy",
      cwd: TEST_PROVIDER_PROBE_CWD,
    });
  });

  it("publishes only a validated transient Google OAuth URL for Antigravity", async () => {
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&client_id=test-client&state=test-state&code_challenge=test-challenge&code_challenge_method=S256";
    const fixture = makeConnectionTestLayer({
      provider: "antigravity",
      hanging: true,
      processStdout: `Authentication required:\n${authorizationUrl}\n`,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const authorizationUrlPublished = fixture.waitForConnectionState(
          (state) => state?.authorizationUrl === authorizationUrl,
        );
        const started = yield* connection.start({
          provider: "antigravity",
          method: "antigravity_browser",
        });
        const operationId = started.providers[0]?.connectionState?.operationId;
        yield* Effect.promise(() => authorizationUrlPublished);
        expect(fixture.getConnectionState()?.authorizationUrl).toBe(authorizationUrl);
        yield* connection.cancel({ provider: "antigravity", operationId: operationId! });
        expect(fixture.getConnectionState()?.authorizationUrl).toBeUndefined();
      }).pipe(Effect.provide(fixture.layer)),
    );
  });

  it("coalesces flooded PTY output while preserving a fragmented OAuth URL", async () => {
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&client_id=test-client&state=test-state&code_challenge=test-challenge&code_challenge_method=S256";
    const splitAt = Math.floor(authorizationUrl.length / 2);
    const fixture = makeConnectionTestLayer({
      provider: "antigravity",
      hanging: true,
      ptyOutputChunks: [
        ...Array.from({ length: 2_000 }, (_, index) => `noise-${index}\n`),
        authorizationUrl.slice(0, splitAt),
        authorizationUrl.slice(splitAt),
      ],
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const authorizationUrlPublished = fixture.waitForConnectionState(
          (state) => state?.authorizationUrl === authorizationUrl,
        );
        const started = yield* connection.start({
          provider: "antigravity",
          method: "antigravity_browser",
        });
        const operationId = started.providers[0]?.connectionState?.operationId;
        yield* Effect.promise(() => authorizationUrlPublished);
        expect(fixture.getConnectionState()?.authorizationUrl).toBe(authorizationUrl);
        yield* connection.cancel({ provider: "antigravity", operationId: operationId! });
        yield* Effect.sleep(Duration.millis(10));
        expect(fixture.getConnectionState()?.status).toBe("cancelled");
        expect(fixture.getConnectionState()?.authorizationUrl).toBeUndefined();
      }).pipe(Effect.provide(fixture.layer)),
    );
  });

  it("settles a claimed URL publication before the code deadline publishes verifying", async () => {
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&client_id=test-client&state=test-state&code_challenge=test-challenge&code_challenge_method=S256";
    let closeCodeWindow!: () => void;
    let releasePublication!: () => void;
    let markPublicationClaimed!: () => void;
    let markInputClosed!: () => void;
    const codeWindowCloseSignal = new Promise<void>((resolve) => {
      closeCodeWindow = resolve;
    });
    const publicationRelease = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const publicationClaimed = new Promise<void>((resolve) => {
      markPublicationClaimed = resolve;
    });
    const inputClosed = new Promise<void>((resolve) => {
      markInputClosed = resolve;
    });
    const fixture = makeConnectionTestLayer({
      provider: "antigravity",
      hanging: true,
      processStdout: `Authentication required:\n${authorizationUrl}\n`,
      antigravityCodeWindowCloseSignal: Effect.promise(() => codeWindowCloseSignal),
      beforeAntigravityOutputPublication: Effect.sync(markPublicationClaimed).pipe(
        Effect.andThen(Effect.promise(() => publicationRelease)),
      ),
      afterAntigravityCodeWindowInputClosed: Effect.sync(markInputClosed),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const verifyingPublished = fixture.waitForConnectionState(
          (state) => state?.status === "verifying",
        );
        const cancelledPublished = fixture.waitForConnectionState(
          (state) => state?.status === "cancelled",
        );
        const started = yield* connection.start({
          provider: "antigravity",
          method: "antigravity_browser",
        });
        const operationId = started.providers[0]?.connectionState?.operationId;
        yield* Effect.promise(() => publicationClaimed);
        yield* Effect.sync(closeCodeWindow);
        yield* Effect.promise(() => inputClosed);
        const lateSubmission = yield* Effect.result(
          connection.submitAuthorizationCode({
            provider: "antigravity",
            operationId: operationId!,
            authorizationCode: "4/test-code-after-deadline",
          }),
        );
        expect(lateSubmission._tag).toBe("Failure");
        if (lateSubmission._tag === "Failure") {
          expect(lateSubmission.failure.reason).toBe("authorization_code_not_accepted");
        }
        yield* Effect.sync(releasePublication);
        yield* Effect.promise(() => verifyingPublished);
        expect(fixture.getConnectionState()?.status).toBe("verifying");
        expect(fixture.getConnectionState()?.authorizationUrl).toBeUndefined();
        yield* connection.cancel({ provider: "antigravity", operationId: operationId! });
        yield* Effect.promise(() => cancelledPublished);
        expect(fixture.getConnectionState()?.status).toBe("cancelled");
        expect(fixture.getConnectionState()?.authorizationUrl).toBeUndefined();
      }).pipe(Effect.provide(fixture.layer)),
    );
  });

  it("cancels an already-claimed URL publication without allowing stale state", async () => {
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&client_id=test-client&state=test-state&code_challenge=test-challenge&code_challenge_method=S256";
    let releasePublication!: () => void;
    let markPublicationClaimed!: () => void;
    let emitPtyData!: (data: string) => void;
    const publicationRelease = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const publicationClaimed = new Promise<void>((resolve) => {
      markPublicationClaimed = resolve;
    });
    const fixture = makeConnectionTestLayer({
      provider: "antigravity",
      hanging: true,
      processStdout: `Authentication required:\n${authorizationUrl}\n`,
      beforeAntigravityOutputPublication: Effect.sync(markPublicationClaimed).pipe(
        Effect.andThen(Effect.promise(() => publicationRelease)),
      ),
      onPtyReady: (emitData) => {
        emitPtyData = emitData;
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const cancelledPublished = fixture.waitForConnectionState(
          (state) => state?.status === "cancelled",
        );
        const started = yield* connection.start({
          provider: "antigravity",
          method: "antigravity_browser",
        });
        const operationId = started.providers[0]?.connectionState?.operationId;
        yield* Effect.promise(() => publicationClaimed);
        const cancellation = yield* connection
          .cancel({ provider: "antigravity", operationId: operationId! })
          .pipe(Effect.forkChild);
        yield* Fiber.join(cancellation);
        yield* Effect.promise(() => cancelledPublished);
        expect(fixture.getConnectionState()?.status).toBe("cancelled");
        expect(fixture.getConnectionState()?.authorizationUrl).toBeUndefined();

        yield* Effect.sync(() => {
          releasePublication();
          emitPtyData(`late output:\n${authorizationUrl}\n`);
        });
        yield* Effect.promise(() => Promise.resolve());
        expect(fixture.getConnectionState()?.status).toBe("cancelled");
        expect(fixture.getConnectionState()?.authorizationUrl).toBeUndefined();
      }).pipe(Effect.provide(fixture.layer)),
    );
  });

  it("closes Antigravity code entry on schedule even when the PTY hangs", async () => {
    const onKill = vi.fn();
    const fixture = makeConnectionTestLayer({
      provider: "antigravity",
      antigravityCodeWindowTimeout: Duration.millis(20),
      antigravityTimeout: Duration.millis(50),
      processForCommand: ({ args }) =>
        args.includes("--print")
          ? { hanging: true, onKill }
          : {
              code: 1,
              hanging: false,
              stdout: "Please sign in to view available models.\n",
            },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const verifyingPublished = fixture.waitForConnectionState(
          (state) => state?.status === "verifying",
        );
        const failedPublished = fixture.waitForConnectionState(
          (state) => state?.status === "failed",
        );
        const started = yield* connection.start({
          provider: "antigravity",
          method: "antigravity_browser",
        });
        const operationId = started.providers[0]?.connectionState?.operationId;
        yield* Effect.promise(() => verifyingPublished);
        expect(fixture.getConnectionState()?.status).toBe("verifying");
        const lateSubmission = yield* Effect.result(
          connection.submitAuthorizationCode({
            provider: "antigravity",
            operationId: operationId!,
            authorizationCode: "4/test-code-after-deadline",
          }),
        );
        expect(lateSubmission._tag).toBe("Failure");
        if (lateSubmission._tag === "Failure") {
          expect(lateSubmission.failure.reason).toBe("authorization_code_not_accepted");
        }
        yield* Effect.promise(() => failedPublished);
        expect(fixture.getConnectionState()?.status).toBe("failed");
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onKill).toHaveBeenCalledTimes(1);
  });

  it("preserves a pre-deadline code through Antigravity's verification grace", async () => {
    let authenticationVisible = false;
    const submittedChunks: Uint8Array[] = [];
    const fixture = makeConnectionTestLayer({
      provider: "antigravity",
      antigravityCodeWindowTimeout: Duration.millis(200),
      antigravityTimeout: Duration.millis(300),
      antigravityAuthenticationProbeInterval: Duration.millis(5),
      processForCommand: ({ args }) =>
        args.includes("--print")
          ? { hanging: true }
          : authenticationVisible
            ? { code: 0, hanging: false, stdout: "Gemini 3.5 Flash (High)\n" }
            : {
                code: 1,
                hanging: false,
                stdout: "Please sign in to view available models.\n",
              },
      onStdinChunk: (command, chunk) => {
        if (command.args.includes("--print")) submittedChunks.push(chunk);
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const verifyingPublished = fixture.waitForConnectionState(
          (state) => state?.status === "verifying",
        );
        const connectedPublished = fixture.waitForConnectionState(
          (state) => state?.status === "connected",
        );
        const started = yield* connection.start({
          provider: "antigravity",
          method: "antigravity_browser",
        });
        const operationId = started.providers[0]?.connectionState?.operationId;
        const submissionFiber = yield* connection
          .submitAuthorizationCode({
            provider: "antigravity",
            operationId: operationId!,
            authorizationCode: "4/test-code-before-deadline",
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => verifyingPublished);
        expect(fixture.getConnectionState()?.status).toBe("verifying");
        authenticationVisible = true;
        yield* Fiber.join(submissionFiber);
        yield* Effect.promise(() => connectedPublished);
        expect(fixture.getConnectionState()?.status).toBe("connected");
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(Buffer.concat(submittedChunks.map((chunk) => Buffer.from(chunk))).toString("utf8")).toBe(
      "4/test-code-before-deadline\n",
    );
  });

  it("accepts authentication that settles just after Antigravity's browser process exits", async () => {
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&client_id=test-client&state=test-state&code_challenge=test-challenge&code_challenge_method=S256";
    let authenticationVisible = false;
    const fixture = makeConnectionTestLayer({
      provider: "antigravity",
      antigravityTimeout: Duration.millis(250),
      antigravityAuthenticationProbeInterval: Duration.millis(5),
      antigravityAuthenticationSettleTimeout: Duration.millis(150),
      processForCommand: ({ args }) =>
        args.includes("--print")
          ? {
              code: 1,
              delayMs: 20,
              stdout: `Authentication required:\n${authorizationUrl}\n`,
            }
          : authenticationVisible
            ? { code: 0, stdout: "Gemini 3.5 Flash (High)\n" }
            : {
                code: 1,
                stdout: "Please sign in to view available models.\n",
              },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const connectedPublished = fixture.waitForConnectionState(
          (state) => state?.status === "connected",
        );
        yield* connection.start({
          provider: "antigravity",
          method: "antigravity_browser",
        });
        yield* Effect.sleep(Duration.millis(45));
        authenticationVisible = true;
        yield* Effect.promise(() => connectedPublished);
        expect(fixture.getConnectionState()?.status).toBe("connected");
      }).pipe(Effect.provide(fixture.layer)),
    );
  });

  it("delivers one transient authorization code only to the active Antigravity PTY", async () => {
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&client_id=test-client&state=test-state&code_challenge=test-challenge&code_challenge_method=S256";
    const submittedChunks: Uint8Array[] = [];
    let codeSubmitted = false;
    const fixture = makeConnectionTestLayer({
      provider: "antigravity",
      listModelsHanging: true,
      processForCommand: ({ args }) =>
        args.includes("--print")
          ? {
              hanging: true,
              stdout: `Authentication required:\n${authorizationUrl}\n`,
            }
          : codeSubmitted
            ? { code: 0, stdout: "Gemini 3.5 Flash (High)\n" }
            : { code: 1, stdout: "Please sign in to view available models.\n" },
      onStdinChunk: (command, chunk) => {
        if (command.args.includes("--print")) {
          submittedChunks.push(chunk);
          codeSubmitted = true;
        }
      },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const started = yield* connection.start({
          provider: "antigravity",
          method: "antigravity_browser",
        });
        const operationId = started.providers[0]?.connectionState?.operationId;
        yield* Effect.sleep(Duration.millis(10));

        const stale = yield* Effect.result(
          connection.submitAuthorizationCode({
            provider: "antigravity",
            operationId: "stale-operation",
            authorizationCode: "4/test-code-stale",
          }),
        );
        expect(stale._tag).toBe("Failure");
        if (stale._tag === "Failure") expect(stale.failure.reason).toBe("operation_not_found");

        yield* connection.submitAuthorizationCode({
          provider: "antigravity",
          operationId: operationId!,
          authorizationCode: "4/test-code-123",
        });
        const submitted = Buffer.concat(
          submittedChunks.map((chunk) => Buffer.from(chunk)),
        ).toString("utf8");
        expect(submitted).toBe("4/test-code-123\n");

        const duplicate = yield* Effect.result(
          connection.submitAuthorizationCode({
            provider: "antigravity",
            operationId: operationId!,
            authorizationCode: "4/test-code-456",
          }),
        );
        expect(duplicate._tag).toBe("Failure");
        if (duplicate._tag === "Failure") {
          expect(duplicate.failure.reason).toBe("authorization_code_already_submitted");
        }
        expect(fixture.getConnectionState()).not.toHaveProperty("authorizationCode");
        yield* connection.cancel({ provider: "antigravity", operationId: operationId! });
      }).pipe(Effect.provide(fixture.layer)),
    );
  });

  it("rejects a code when Antigravity exits before confirming authentication", async () => {
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&client_id=test-client&state=test-state&code_challenge=test-challenge&code_challenge_method=S256";
    const fixture = makeConnectionTestLayer({
      provider: "antigravity",
      processForCommand: ({ args }) =>
        args.includes("--print")
          ? {
              hanging: true,
              exitOnWrite: true,
              stdout: `Authentication required:\n${authorizationUrl}\n`,
            }
          : { code: 1, stdout: "Please sign in to view available models.\n" },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const started = yield* connection.start({
          provider: "antigravity",
          method: "antigravity_browser",
        });
        const operationId = started.providers[0]?.connectionState?.operationId;
        yield* Effect.sleep(Duration.millis(10));
        const submission = yield* Effect.result(
          connection.submitAuthorizationCode({
            provider: "antigravity",
            operationId: operationId!,
            authorizationCode: "4/test-code-123",
          }),
        );
        expect(submission._tag).toBe("Failure");
        if (submission._tag === "Failure") {
          expect(submission.failure.reason).toBe("authorization_code_not_accepted");
        }
      }).pipe(Effect.provide(fixture.layer)),
    );
  });

  it("ignores a delayed PTY flood after an Antigravity attempt is cancelled", async () => {
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&client_id=test-client&state=test-state&code_challenge=test-challenge&code_challenge_method=S256";
    const fixture = makeConnectionTestLayer({
      provider: "antigravity",
      hanging: true,
      ptyOutputDelayMs: 30,
      ptyOutputChunks: [
        ...Array.from({ length: 20_000 }, (_, index) => `late-noise-${index}\n`),
        `Authentication required:\n${authorizationUrl}\n`,
      ],
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const started = yield* connection.start({
          provider: "antigravity",
          method: "antigravity_browser",
        });
        const operationId = started.providers[0]?.connectionState?.operationId;
        yield* Effect.sleep(Duration.millis(10));
        yield* connection.cancel({ provider: "antigravity", operationId: operationId! });
        yield* Effect.sleep(Duration.millis(50));
        expect(fixture.getConnectionState()?.status).toBe("cancelled");
        expect(fixture.getConnectionState()?.authorizationUrl).toBeUndefined();
      }).pipe(Effect.provide(fixture.layer)),
    );
  });

  it("rejects a code after the Antigravity stdin has closed during verification", async () => {
    const fixture = makeConnectionTestLayer({
      provider: "antigravity",
      listModelsHanging: true,
      processForCommand: ({ args }) =>
        args.includes("models")
          ? { code: 0, stdout: "Gemini 3.5 Flash (High)\n" }
          : { code: 0, stdout: "Authentication complete.\n" },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const started = yield* connection.start({
          provider: "antigravity",
          method: "antigravity_browser",
        });
        const operationId = started.providers[0]?.connectionState?.operationId;
        yield* Effect.sleep(Duration.millis(20));
        expect(fixture.getConnectionState()?.status).toBe("verifying");
        const late = yield* Effect.result(
          connection.submitAuthorizationCode({
            provider: "antigravity",
            operationId: operationId!,
            authorizationCode: "4/test-code-late",
          }),
        );
        expect(late._tag).toBe("Failure");
        if (late._tag === "Failure") {
          expect(late.failure.reason).toBe("authorization_code_not_accepted");
        }
        yield* connection.cancel({ provider: "antigravity", operationId: operationId! });
      }).pipe(Effect.provide(fixture.layer)),
    );
  });

  it("starts Grok's browser login with the resolved executable", async () => {
    const onSpawn = vi.fn();
    const fixture = makeConnectionTestLayer({
      provider: "grok",
      runtimeSource: "managed",
      onSpawn,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        yield* connection.start({ provider: "grok", method: "grok_browser" });
        yield* Effect.sleep(Duration.millis(20));
        expect(fixture.getConnectionState()?.status).toBe("connected");
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "grok",
        args: ["--no-auto-update", "login", "--oauth"],
      }),
    );
  });

  it("uses direct OAuth with a system Grok runtime too", async () => {
    const onSpawn = vi.fn();
    const fixture = makeConnectionTestLayer({ provider: "grok", onSpawn });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        yield* connection.start({ provider: "grok", method: "grok_browser" });
        yield* Effect.sleep(Duration.millis(20));
        expect(fixture.getConnectionState()?.status).toBe("connected");
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: "grok", args: ["login", "--oauth"] }),
    );
  });

  it("publishes only a validated transient Grok OAuth URL while sign-in is active", async () => {
    const authorizationUrl =
      "https://auth.x.ai/oauth2/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A50418%2Fcallback&state=test-state&code_challenge=test-challenge";
    const fixture = makeConnectionTestLayer({
      provider: "grok",
      hanging: true,
      processStdout: `Complete sign-in at:\n${authorizationUrl}\n`,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const started = yield* connection.start({ provider: "grok", method: "grok_browser" });
        const operationId = started.providers[0]?.connectionState?.operationId;
        yield* Effect.sleep(Duration.millis(10));
        expect(fixture.getConnectionState()?.authorizationUrl).toBe(authorizationUrl);
        yield* connection.cancel({ provider: "grok", operationId: operationId! });
        expect(fixture.getConnectionState()?.authorizationUrl).toBeUndefined();
      }).pipe(Effect.provide(fixture.layer)),
    );
  });

  it("ends a rejected Grok OAuth flow with actionable retry guidance", async () => {
    const fixture = makeConnectionTestLayer({
      provider: "grok",
      processExitCode: 1,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        yield* connection.start({ provider: "grok", method: "grok_browser" });
        yield* Effect.sleep(Duration.millis(20));
        expect(fixture.getConnectionState()?.status).toBe("failed");
        expect(fixture.getConnectionState()?.message).toContain("fresh secure browser sign-in");
      }).pipe(Effect.provide(fixture.layer)),
    );
  });

  it("cancels Grok OAuth and kills the waiting callback process", async () => {
    const onKill = vi.fn();
    const fixture = makeConnectionTestLayer({
      provider: "grok",
      hanging: true,
      onKill,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const started = yield* connection.start({
          provider: "grok",
          method: "grok_browser",
        });
        const operationId = started.providers[0]?.connectionState?.operationId;
        expect(operationId).toBeTruthy();
        yield* Effect.sleep(Duration.millis(5));
        yield* connection.cancel({ provider: "grok", operationId: operationId! });
        expect(fixture.getConnectionState()?.status).toBe("cancelled");
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onKill).toHaveBeenCalledTimes(1);
  });

  it("times out Grok OAuth and kills the waiting callback process", async () => {
    const onKill = vi.fn();
    const fixture = makeConnectionTestLayer({
      provider: "grok",
      hanging: true,
      timeout: Duration.millis(5),
      onKill,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        yield* connection.start({ provider: "grok", method: "grok_browser" });
        yield* Effect.sleep(Duration.millis(20));
        expect(fixture.getConnectionState()?.status).toBe("failed");
        expect(fixture.getConnectionState()?.message).toContain("timed out");
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onKill).toHaveBeenCalledTimes(1);
  });

  it("runs Droid's authentication-only ACP handshake before verification", async () => {
    const droidAuthenticationProbe = vi.fn(() => Effect.succeed({ methodId: "device-pairing" }));
    const fixture = makeConnectionTestLayer({
      provider: "droid",
      droidAuthenticationProbe,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        yield* connection.start({ provider: "droid", method: "droid_device_pairing" });
        yield* Effect.sleep(Duration.millis(20));
        expect(fixture.getConnectionState()?.status).toBe("connected");
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(droidAuthenticationProbe).toHaveBeenCalledWith(
      expect.objectContaining({ binaryPath: "droid", cwd: TEST_PROVIDER_PROBE_CWD }),
    );
  });

  it("starts terminal-equivalent Claude login and verifies before connecting", async () => {
    const onSpawn = vi.fn();
    const onListModels = vi.fn();
    const fixture = makeConnectionTestLayer({ onSpawn, onListModels });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const started = yield* connection.start({
          provider: "claudeAgent",
          method: "claude_account",
        });
        expect(started.providers[0]?.connectionState?.operationId).toBeTruthy();
        yield* Effect.sleep(Duration.millis(20));
        expect(fixture.getConnectionState()?.status).toBe("connected");
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(onSpawn.mock.calls[0]?.[0]).toMatchObject({
      command: "claude",
      args: ["auth", "login"],
    });
    expect(onListModels).toHaveBeenCalledWith({
      provider: "claudeAgent",
      binaryPath: "claude",
      cwd: TEST_PROVIDER_PROBE_CWD,
    });
  });

  it("does not report connected when authenticated model discovery is empty", async () => {
    const fixture = makeConnectionTestLayer({ modelsAvailable: false });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        yield* connection.start({
          provider: "claudeAgent",
          method: "claude_console",
        });
        yield* Effect.sleep(Duration.millis(20));
        expect(fixture.getConnectionState()?.status).toBe("failed");
        expect(fixture.getConnectionState()?.message).toContain("model catalog");
      }).pipe(Effect.provide(fixture.layer)),
    );
  });

  it("cancels an active sign-in and kills its process", async () => {
    const onKill = vi.fn();
    const fixture = makeConnectionTestLayer({ hanging: true, onKill });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const started = yield* connection.start({
          provider: "claudeAgent",
          method: "claude_console",
        });
        const operationId = started.providers[0]?.connectionState?.operationId;
        expect(operationId).toBeTruthy();
        yield* Effect.sleep(Duration.millis(5));
        yield* connection.cancel({ provider: "claudeAgent", operationId: operationId! });
        expect(fixture.getConnectionState()?.status).toBe("cancelled");
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onKill).toHaveBeenCalledTimes(1);
  });

  it("rejects sign-in before spawning when the provider is not installed", async () => {
    const onSpawn = vi.fn();
    const fixture = makeConnectionTestLayer({ available: false, onSpawn });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        return yield* Effect.result(
          connection.start({
            provider: "claudeAgent",
            method: "claude_console",
          }),
        );
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.reason).toBe("provider_not_installed");
    }
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it("returns the existing operation for a duplicate start", async () => {
    const fixture = makeConnectionTestLayer({ hanging: true });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const started = yield* connection.start({
          provider: "claudeAgent",
          method: "claude_console",
        });
        const duplicate = yield* connection.start({
          provider: "claudeAgent",
          method: "claude_account",
        });
        const operationId = started.providers[0]?.connectionState?.operationId;
        expect(duplicate.providers[0]?.connectionState?.operationId).toBe(operationId);
        yield* connection.cancel({ provider: "claudeAgent", operationId: operationId! });
      }).pipe(Effect.provide(fixture.layer)),
    );
  });

  it("does not spawn sign-in when a fresh preflight finds an existing account", async () => {
    const onSpawn = vi.fn();
    const fixture = makeConnectionTestLayer({ initiallyAuthenticated: true, onSpawn });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        return yield* connection.start({ provider: "claudeAgent", method: "claude_account" });
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(result.providers[0]?.authStatus).toBe("authenticated");
    expect(result.providers[0]?.connectionState).toBeUndefined();
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it("never applies the Codex-only reauthentication override to another provider", async () => {
    const onSpawn = vi.fn();
    const fixture = makeConnectionTestLayer({ initiallyAuthenticated: true, onSpawn });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        return yield* connection.start({
          provider: "claudeAgent",
          method: "claude_account",
          mode: "reauthenticate",
        });
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(result.providers[0]?.authStatus).toBe("authenticated");
    expect(result.providers[0]?.connectionState).toBeUndefined();
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it("starts a fresh Codex login when runtime recovery explicitly requests reauthentication", async () => {
    const onSpawn = vi.fn();
    const fixture = makeConnectionTestLayer({
      provider: "codex",
      initiallyAuthenticated: true,
      onSpawn,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        yield* connection.start({
          provider: "codex",
          method: "codex_browser",
          mode: "reauthenticate",
        });
        yield* Effect.sleep(Duration.millis(20));
        expect(fixture.getConnectionState()?.status).toBe("connected");
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: "codex", args: ["login"] }),
    );
  });

  it("refuses official Codex reauthentication for a custom Codex provider", async () => {
    const onSpawn = vi.fn();
    const fixture = makeConnectionTestLayer({
      provider: "codex",
      initiallyAuthenticated: true,
      requiresProviderAccount: false,
      onSpawn,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        return yield* Effect.result(
          connection.start({
            provider: "codex",
            method: "codex_browser",
            mode: "reauthenticate",
          }),
        );
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.reason).toBe("invalid_method");
    }
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it("fails closed when Codex account ownership is unknown", async () => {
    const onSpawn = vi.fn();
    const fixture = makeConnectionTestLayer({
      provider: "codex",
      initiallyAuthenticated: true,
      requiresProviderAccount: null,
      onSpawn,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        return yield* Effect.result(
          connection.start({
            provider: "codex",
            method: "codex_browser",
            mode: "reauthenticate",
          }),
        );
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.reason).toBe("invalid_method");
    }
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it("can start a fresh operation after cancellation fully releases the provider", async () => {
    const onSpawn = vi.fn();
    const fixture = makeConnectionTestLayer({ hanging: true, onSpawn });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const first = yield* connection.start({
          provider: "claudeAgent",
          method: "claude_account",
        });
        const firstOperationId = first.providers[0]?.connectionState?.operationId;
        yield* Effect.sleep(Duration.millis(5));
        yield* connection.cancel({
          provider: "claudeAgent",
          operationId: firstOperationId!,
        });

        const second = yield* connection.start({
          provider: "claudeAgent",
          method: "claude_sso",
        });
        const secondOperationId = second.providers[0]?.connectionState?.operationId;
        expect(secondOperationId).toBeTruthy();
        expect(secondOperationId).not.toBe(firstOperationId);
        yield* Effect.sleep(Duration.millis(5));
        yield* connection.cancel({
          provider: "claudeAgent",
          operationId: secondOperationId!,
        });
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onSpawn).toHaveBeenCalledTimes(2);
    expect(onSpawn.mock.calls[1]?.[0]).toMatchObject({
      args: ["auth", "login", "--sso"],
    });
  });

  it("times out and kills a sign-in that never finishes", async () => {
    const onKill = vi.fn();
    const fixture = makeConnectionTestLayer({
      hanging: true,
      timeout: Duration.millis(5),
      onKill,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        yield* connection.start({
          provider: "claudeAgent",
          method: "claude_console",
        });
        yield* Effect.sleep(Duration.millis(20));
        expect(fixture.getConnectionState()?.status).toBe("failed");
        expect(fixture.getConnectionState()?.message).toContain("timed out");
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onKill).toHaveBeenCalledTimes(1);
  });
});
