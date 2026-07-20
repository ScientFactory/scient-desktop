import type {
  ProviderKind,
  ServerProviderConnectionState,
  ServerProviderRuntimeSource,
  ServerProviderStatus,
} from "@synara/contracts";
import { Duration, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it, vi } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../../config";
import { ServerSettingsService } from "../../serverSettings";
import { PtyAdapter, type PtyAdapterShape } from "../../terminal/Services/PTY";
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
  expectedMethodForProvider,
  makeProviderConnectionLive,
  providerConnectionCommandArgs,
} from "./ProviderConnection";

const encoder = new TextEncoder();

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

function makeHandle(input: {
  readonly code?: number;
  readonly hanging?: boolean;
  readonly stdout?: string;
  onKill?: () => void;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(41),
    exitCode: input.hanging
      ? Effect.never
      : Effect.succeed(ChildProcessSpawner.ExitCode(input.code ?? 0)),
    isRunning: Effect.succeed(Boolean(input.hanging)),
    kill: () => Effect.sync(() => input.onKill?.()),
    stdin: Sink.drain,
    stdout: input.hanging
      ? Stream.never
      : Stream.make(encoder.encode(input.stdout ?? "browser opened")),
    stderr: input.hanging ? Stream.never : Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function makeConnectionTestLayer(input?: {
  readonly available?: boolean;
  readonly hanging?: boolean;
  readonly processStdout?: string;
  readonly provider?: ProviderKind;
  readonly runtimeSource?: ServerProviderRuntimeSource;
  readonly timeout?: Duration.Duration;
  readonly onSpawn?: (command: { command: string; args: ReadonlyArray<string> }) => void;
  readonly onKill?: () => void;
  readonly onPtySpawn?: (input: unknown) => void;
  readonly onPtyKill?: () => void;
  readonly droidAuthenticationProbe?: typeof probeDroidAcpAuthentication;
  readonly modelsAvailable?: boolean;
  readonly onListModels?: (input: {
    readonly provider: ProviderKind;
    readonly binaryPath?: string;
  }) => void;
}) {
  let connectionState: ServerProviderConnectionState | undefined;
  let authenticated = false;
  const status = (): ServerProviderStatus => ({
    provider: input?.provider ?? "claudeAgent",
    status: authenticated ? "ready" : "error",
    available: input?.available ?? true,
    authStatus: authenticated ? "authenticated" : "unauthenticated",
    checkedAt: new Date().toISOString(),
    ...(connectionState ? { connectionState } : {}),
  });
  const providerHealthLayer = Layer.succeed(ProviderHealth, {
    getStatuses: Effect.sync(() => [status()]),
    refresh: Effect.sync(() => {
      authenticated = true;
      return [status()];
    }),
    updateProvider: () => Effect.die("unused"),
    setConnectionState: (_provider, state) =>
      Effect.sync(() => {
        connectionState = state ?? undefined;
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
    listModels: ({ provider, binaryPath }) =>
      Effect.sync(() => {
        input?.onListModels?.({ provider, ...(binaryPath ? { binaryPath } : {}) });
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
      const captured = command as unknown as { command: string; args: ReadonlyArray<string> };
      input?.onSpawn?.(captured);
      return Effect.succeed(
        makeHandle({
          ...(input?.hanging !== undefined ? { hanging: input.hanging } : {}),
          ...(input?.onKill ? { onKill: input.onKill } : {}),
          ...(input?.processStdout ? { stdout: input.processStdout } : {}),
        }),
      );
    }),
  );
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
        installationState: null,
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
  const ptyLayer = Layer.succeed(PtyAdapter, {
    spawn: (spawnInput) =>
      Effect.sync(() => {
        input?.onPtySpawn?.(spawnInput);
        return {
          pid: 42,
          write: () => undefined,
          resize: () => undefined,
          kill: () => input?.onPtyKill?.(),
          pause: () => undefined,
          resume: () => undefined,
          onData: () => () => undefined,
          onExit: () => () => undefined,
        };
      }),
  } satisfies PtyAdapterShape);

  const layer = makeProviderConnectionLive({
    ...(input?.timeout ? { timeout: input.timeout } : {}),
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
  return { layer, getConnectionState: () => connectionState };
}

describe("provider connection command allowlist", () => {
  it("uses Codex browser login with fixed argv", () => {
    expect(expectedMethodForProvider("codex")).toBe("codex_browser");
    expect(providerConnectionCommandArgs("codex", "codex_browser")).toEqual(["login"]);
  });

  it("uses Claude Console login with fixed argv", () => {
    expect(expectedMethodForProvider("claudeAgent")).toBe("claude_console");
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

  it("launches Antigravity's provider-owned TTY login", () => {
    expect(expectedMethodForProvider("antigravity")).toBe("antigravity_browser");
    expect(providerConnectionCommandArgs("antigravity", "antigravity_browser")).toEqual([]);
  });

  it("uses Grok's provider-owned browser login", () => {
    expect(expectedMethodForProvider("grok")).toBe("grok_browser");
    expect(providerConnectionCommandArgs("grok", "grok_browser")).toEqual(["login"]);
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

describe("ProviderConnectionLive", () => {
  it("runs managed Antigravity login in a PTY and verifies models before connecting", async () => {
    const onPtySpawn = vi.fn();
    const onPtyKill = vi.fn();
    const fixture = makeConnectionTestLayer({
      provider: "antigravity",
      runtimeSource: "managed",
      processStdout: "Gemini 3.5 Flash (High)\n",
      onPtySpawn,
      onPtyKill,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        yield* connection.start({
          provider: "antigravity",
          method: "antigravity_browser",
        });
        yield* Effect.sleep(Duration.millis(30));
        expect(fixture.getConnectionState()?.status).toBe("connected");
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onPtySpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        shell: "agy",
        args: [],
        env: expect.objectContaining({ AGY_CLI_DISABLE_AUTO_UPDATE: "true" }),
      }),
    );
    expect(onPtyKill).toHaveBeenCalledTimes(1);
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
      expect.objectContaining({ command: "grok", args: ["--no-auto-update", "login"] }),
    );
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
      expect.objectContaining({ binaryPath: "droid", cwd: "/tmp" }),
    );
  });

  it("starts Claude login with fixed argv and verifies before connecting", async () => {
    const onSpawn = vi.fn();
    const onListModels = vi.fn();
    const fixture = makeConnectionTestLayer({ onSpawn, onListModels });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const started = yield* connection.start({
          provider: "claudeAgent",
          method: "claude_console",
        });
        expect(started.providers[0]?.connectionState?.operationId).toBeTruthy();
        yield* Effect.sleep(Duration.millis(20));
        expect(fixture.getConnectionState()?.status).toBe("connected");
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(onSpawn.mock.calls[0]?.[0]).toMatchObject({
      command: "claude",
      args: ["auth", "login", "--console"],
    });
    expect(onListModels).toHaveBeenCalledWith({
      provider: "claudeAgent",
      binaryPath: "claude",
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

  it("rejects a duplicate operation for the same provider", async () => {
    const fixture = makeConnectionTestLayer({ hanging: true });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const started = yield* connection.start({
          provider: "claudeAgent",
          method: "claude_console",
        });
        const duplicate = yield* Effect.result(
          connection.start({
            provider: "claudeAgent",
            method: "claude_console",
          }),
        );
        expect(duplicate._tag).toBe("Failure");
        if (duplicate._tag === "Failure") {
          expect(duplicate.failure.reason).toBe("already_running");
        }
        const operationId = started.providers[0]?.connectionState?.operationId;
        yield* connection.cancel({ provider: "claudeAgent", operationId: operationId! });
      }).pipe(Effect.provide(fixture.layer)),
    );
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
