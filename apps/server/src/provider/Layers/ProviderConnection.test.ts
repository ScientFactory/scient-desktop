import type { ServerProviderConnectionState, ServerProviderStatus } from "@synara/contracts";
import { Duration, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it, vi } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../../config";
import { ServerSettingsService } from "../../serverSettings";
import { ProviderConnection } from "../Services/ProviderConnection";
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
    stdout: input.hanging ? Stream.never : Stream.make(encoder.encode("browser opened")),
    stderr: input.hanging ? Stream.never : Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function makeConnectionTestLayer(input?: {
  readonly available?: boolean;
  readonly hanging?: boolean;
  readonly timeout?: Duration.Duration;
  readonly onSpawn?: (command: { command: string; args: ReadonlyArray<string> }) => void;
  readonly onKill?: () => void;
}) {
  let connectionState: ServerProviderConnectionState | undefined;
  let authenticated = false;
  const status = (): ServerProviderStatus => ({
    provider: "claudeAgent",
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
  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const captured = command as unknown as { command: string; args: ReadonlyArray<string> };
      input?.onSpawn?.(captured);
      return Effect.succeed(
        makeHandle({
          ...(input?.hanging !== undefined ? { hanging: input.hanging } : {}),
          ...(input?.onKill ? { onKill: input.onKill } : {}),
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
        source: input?.available === false ? "missing" : "system",
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

  const layer = makeProviderConnectionLive(
    input?.timeout ? { timeout: input.timeout } : undefined,
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(Layer.succeed(ServerConfig, TEST_CONFIG)),
    Layer.provideMerge(providerHealthLayer),
    Layer.provideMerge(providerRuntimeLayer),
    Layer.provideMerge(spawnerLayer),
  );
  return { layer, getConnectionState: () => connectionState };
}

describe("provider connection command allowlist", () => {
  it("uses Codex browser login with fixed argv", () => {
    expect(expectedMethodForProvider("codex")).toBe("codex_browser");
    expect(providerConnectionCommandArgs("codex", "codex_browser")).toEqual(["login"]);
  });

  it("uses Claude subscription login with fixed argv", () => {
    expect(expectedMethodForProvider("claudeAgent")).toBe("claude_subscription");
    expect(providerConnectionCommandArgs("claudeAgent", "claude_subscription")).toEqual([
      "auth",
      "login",
      "--claudeai",
    ]);
  });

  it("uses Cursor browser login with fixed argv", () => {
    expect(expectedMethodForProvider("cursor")).toBe("cursor_browser");
    expect(providerConnectionCommandArgs("cursor", "cursor_browser")).toEqual(["login"]);
  });

  it("uses Antigravity's provider-owned browser authentication probe", () => {
    expect(expectedMethodForProvider("antigravity")).toBe("antigravity_browser");
    expect(providerConnectionCommandArgs("antigravity", "antigravity_browser")).toEqual(["models"]);
  });

  it("does not construct commands for mismatched or unsupported providers", () => {
    expect(providerConnectionCommandArgs("codex", "claude_subscription")).toBeNull();
    expect(providerConnectionCommandArgs("cursor", "codex_browser")).toBeNull();
    expect(expectedMethodForProvider("opencode")).toBeNull();
  });
});

describe("ProviderConnectionLive", () => {
  it("starts Claude login with fixed argv and verifies before connecting", async () => {
    const onSpawn = vi.fn();
    const fixture = makeConnectionTestLayer({ onSpawn });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const started = yield* connection.start({
          provider: "claudeAgent",
          method: "claude_subscription",
        });
        expect(started.providers[0]?.connectionState?.operationId).toBeTruthy();
        yield* Effect.sleep(Duration.millis(20));
        expect(fixture.getConnectionState()?.status).toBe("connected");
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(onSpawn.mock.calls[0]?.[0]).toMatchObject({
      command: "claude",
      args: ["auth", "login", "--claudeai"],
    });
  });

  it("cancels an active sign-in and kills its process", async () => {
    const onKill = vi.fn();
    const fixture = makeConnectionTestLayer({ hanging: true, onKill });

    await Effect.runPromise(
      Effect.gen(function* () {
        const connection = yield* ProviderConnection;
        const started = yield* connection.start({
          provider: "claudeAgent",
          method: "claude_subscription",
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
            method: "claude_subscription",
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
          method: "claude_subscription",
        });
        const duplicate = yield* Effect.result(
          connection.start({
            provider: "claudeAgent",
            method: "claude_subscription",
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
          method: "claude_subscription",
        });
        yield* Effect.sleep(Duration.millis(20));
        expect(fixture.getConnectionState()?.status).toBe("failed");
        expect(fixture.getConnectionState()?.message).toContain("timed out");
      }).pipe(Effect.provide(fixture.layer)),
    );

    expect(onKill).toHaveBeenCalledTimes(1);
  });
});
