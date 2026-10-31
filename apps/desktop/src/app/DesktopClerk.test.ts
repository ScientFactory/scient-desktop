// @effect-diagnostics nodeBuiltinImport:off - Clerk storage tests use a real temporary state directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePathLayer from "@effect/platform-node/NodePath";
// SCIENT-FORK:START scient-deferred-auth
import { codexAuthHandoffUrl } from "@t3tools/shared/codexAuthHandoff";
// SCIENT-FORK:END scient-deferred-auth
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeEach, vi } from "vite-plus/test";

const clerkStateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-clerk-"));
afterAll(() => {
  NodeFS.rmSync(clerkStateDir, { recursive: true, force: true });
});

const { createClerkBridgeMock, requestSingleInstanceLockMock, storageAdapter, storageMock } =
  vi.hoisted(() => ({
    createClerkBridgeMock: vi.fn(),
    requestSingleInstanceLockMock: vi.fn(() => true),
    storageAdapter: {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    storageMock: vi.fn(),
  }));

vi.mock("@clerk/electron", () => ({
  createClerkBridge: createClerkBridgeMock,
}));

vi.mock("@clerk/electron/storage", () => ({
  storage: storageMock,
}));
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";

const ignoreWebLinks = DesktopWebLinks.DesktopWebLinks.of({
  receive: () => Effect.void,
  setRendererReady: () => Effect.void,
});

const layerDesktopClerk = (
  isDevelopment = true,
  events: string[] = [],
  platform: NodeJS.Platform = "darwin",
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = FileSystem.layerNoop({
    exists: () => Effect.succeed(false),
  }),
  shell: ElectronShell.ElectronShell["Service"] = {
    openExternal: () => Effect.succeed(true),
    openSystemSettings: () => Effect.succeed(false),
    copyText: () => Effect.void,
    // SCIENT-FORK:START desktop-shell-copy-png
    copyPng: () => Effect.succeed(true),
    // SCIENT-FORK:END desktop-shell-copy-png
  },
  listeners = new Map<string, (...args: unknown[]) => void>(),
) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: clerkStateDir,
    isDevelopment,
    appDataDirectory: "/tmp/app-data",
    // SCIENT-FORK:START desktop-state-isolation
    userDataDirName: isDevelopment ? "scient-next-dev" : "scient-next",
    legacyUserDataDirName: "__scient_next_legacy_disabled__",
    path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
    // SCIENT-FORK:END desktop-state-isolation
    platform,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  const electronApp = {
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`setPath:${name}:${value}`);
      }),
    requestSingleInstanceLock: Effect.sync(() => {
      events.push("requestSingleInstanceLock");
      return requestSingleInstanceLockMock();
    }),
    quit: Effect.sync(() => {
      events.push("quit");
    }),
    on: (name: string, listener: (...args: unknown[]) => void) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          events.push(`on:${name}`);
          listeners.set(name, listener);
        }),
        () =>
          Effect.sync(() => {
            listeners.delete(name);
          }),
      ).pipe(Effect.asVoid),
  } as unknown as ElectronApp.ElectronApp["Service"];

  return DesktopClerk.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodePathLayer.layerPosix,
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        Layer.succeed(ElectronShell.ElectronShell, shell),
        fileSystemLayer,
      ),
    ),
  );
};

describe("DesktopClerk", () => {
  beforeEach(() => {
    createClerkBridgeMock.mockReset();
    requestSingleInstanceLockMock.mockReset().mockReturnValue(true);
    storageMock.mockReset();
  });

  it.each([
    // SCIENT-FORK:START desktop-state-isolation — Scient resolves userData to its own directories and never adopts a T3 one
    {
      name: "packaged macOS",
      isDevelopment: false,
      platform: "darwin" as const,
      userData: "/tmp/app-data/scient-next",
    },
    {
      name: "packaged Linux",
      isDevelopment: false,
      platform: "linux" as const,
      userData: "/tmp/app-data/scient-next",
    },
    {
      name: "packaged Windows",
      isDevelopment: false,
      platform: "win32" as const,
      userData: "/tmp/app-data/scient-next",
    },
    {
      name: "development",
      isDevelopment: true,
      platform: "win32" as const,
      userData: "/tmp/t3-state/electron-userdata",
    },
    // SCIENT-FORK:END desktop-state-isolation
  ])(
    "creates the bridge before startup can yield to the event loop ($name)",
    ({ isDevelopment, platform, userData }) => {
      const events: string[] = [];
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockImplementation(() => {
        events.push("createClerkBridge");
        return { cleanup: vi.fn(), isPrimaryInstance: true };
      });
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The assertion IS that the layer builds synchronously; it.effect would mask a regression to async.
      Effect.runSync(
        Effect.scoped(
          Layer.build(
            layerDesktopClerk(isDevelopment, events, platform, DesktopPreReadyFileSystem.layer),
          ),
        ),
      );

      assert.deepEqual(events, [
        `setPath:userData:${userData}`,
        "requestSingleInstanceLock",
        "on:second-instance",
        "on:open-url",
        "createClerkBridge",
      ]);
      assert.deepEqual(storageMock.mock.calls, [
        [{ path: NodePath.join(NodePath.resolve(clerkStateDir), "clerk") }],
      ]);
      assert.notStrictEqual(createClerkBridgeMock.mock.calls[0]?.[0]?.storage, storageAdapter);
    },
  );

  it.effect.each(["before configure", "after configure"] as const)(
    "reveals the running window when a second instance launches %s",
    (entry) => {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
      const quit = vi.fn();
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const revealed = Promise.withResolvers<unknown>();
      const window = { id: 1 };
      const electronApp = {
        quit: Effect.sync(quit),
        on: (eventName: string, listener: (...args: unknown[]) => void) =>
          Effect.sync(() => {
            listeners.set(eventName, listener);
          }),
      } as unknown as ElectronApp.ElectronApp["Service"];
      const electronWindow = {
        currentMainOrFirst: Effect.succeedSome(window),
        reveal: (value: unknown) => Effect.sync(() => revealed.resolve(value)),
      } as unknown as ElectronWindow.ElectronWindow["Service"];

      return Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        if (entry === "before configure") listeners.get("second-instance")?.({}, ["t3"]);
        yield* clerk.configure;

        assert.equal(quit.mock.calls.length, 0);
        if (entry === "after configure") listeners.get("second-instance")!({}, ["t3"]);
        assert.strictEqual(yield* Effect.promise(() => revealed.promise), window);
      }).pipe(
        Effect.scoped,
        Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, undefined, listeners)),
        Effect.provideService(ElectronApp.ElectronApp, electronApp),
        Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
        Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
      );
    },
  );

  // SCIENT-FORK:START restored-sole-guards - upstream's snap dropped this; the mutation it guards passed every other desktop test.

  // regression: 3e01c4bc57 Migrate desktop auth to Clerk bridge (#3092) - sole guard: skipping bridge.cleanup() on release passed every other desktop test
  it.effect("acquires and releases the SDK bridge with the layer", () => {
    const cleanup = vi.fn();
    const events: string[] = [];
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementation(() => {
      events.push("createClerkBridge");
      return { cleanup, isPrimaryInstance: true };
    });

    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(layerDesktopClerk(true, events)));

      assert.deepEqual(createClerkBridgeMock.mock.calls, [
        [
          {
            storage: storageAdapter,
            manageSingleInstanceLock: false,
            passkeys: true,
            renderer: { scheme: "scient-next-dev", host: "app" },
          },
        ],
      ]);
      assert.equal(cleanup.mock.calls.length, 1);
      assert.deepEqual(events, [
        "setPath:userData:/tmp/t3-state/electron-userdata",
        "requestSingleInstanceLock",
        "on:second-instance",
        "on:open-url",
        "createClerkBridge",
      ]);
      storageMock.mockClear();
      createClerkBridgeMock.mockClear();
    });
  });
  // SCIENT-FORK:END restored-sole-guards

  it.effect("delivers each queued startup link once, before later links", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const received: string[] = [];
    // SCIENT-FORK:START scient-url-scheme
    const first = "scient://new?prompt=first";
    const second = "scient://threads/env-1/thread-1";
    const later = "scient://new?prompt=later";
    const launchPair = "scient://pair?pairingUrl=https%3A%2F%2Fvps.example.com%2F%23token%3Dabc";
    // SCIENT-FORK:END scient-url-scheme
    const delivered = Promise.withResolvers<void>();
    const electronApp = {
      on: (name: string, listener: (...args: unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(name, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      listeners.get("second-instance")?.({}, ["t3", first]);
      listeners.get("second-instance")?.({}, ["t3", second]);
      listeners.get("open-url")?.({ preventDefault: () => undefined }, launchPair);
      assert.deepEqual(received, []);

      yield* clerk.configure;
      listeners.get("second-instance")!({}, ["t3", later]);
      yield* Effect.promise(() => delivered.promise);

      assert.deepEqual(received, [launchPair, first, second, later]);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, undefined, listeners)),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
      Effect.provideService(
        DesktopWebLinks.DesktopWebLinks,
        DesktopWebLinks.DesktopWebLinks.of({
          receive: (url) =>
            Effect.sync(() => {
              received.push(url);
              if (url === later) delivered.resolve();
            }),
          setRendererReady: () => Effect.void,
        }),
      ),
    );
  });

  // SCIENT-FORK:START scient-url-scheme — the renderer origin follows Scient's development and production schemes
  it.effect.each(
    [
      { isDevelopment: true, scheme: "scient-next-dev" },
      { isDevelopment: false, scheme: "scient" },
    ].map(({ isDevelopment, scheme }) => ({
      caseTitle: `configures the SDK with the ${scheme} renderer origin`,
      isDevelopment,
      scheme,
    })),
  )("$caseTitle", ({ isDevelopment, scheme }) =>
    Effect.gen(function* () {
      const bridge = { cleanup: vi.fn(), isPrimaryInstance: true };
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue(bridge);

      yield* Effect.scoped(Layer.build(layerDesktopClerk(isDevelopment)));
      assert.deepEqual(storageMock.mock.calls, [[{ path: "/tmp/t3-state" }]]);
      assert.deepEqual(createClerkBridgeMock.mock.calls, [
        [
          {
            storage: storageAdapter,
            manageSingleInstanceLock: false,
            passkeys: true,
            renderer: { scheme, host: "app" },
          },
        ],
      ]);
      storageMock.mockClear();
      createClerkBridgeMock.mockClear();
    }),
  );
  // SCIENT-FORK:END scient-url-scheme

  it.effect.each(["darwin", "win32", "linux"] as const)(
    "quits a second launch before initializing Clerk or the application runtime on %s",
    (platform) =>
      Effect.gen(function* () {
        requestSingleInstanceLockMock.mockReturnValueOnce(false);
        createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
        const events: string[] = [];
        const runtime = layerDesktopClerk(false, events, platform).pipe(
          Layer.flatMap(() =>
            Layer.effectDiscard(
              Effect.sync(() => {
                events.push("initializeApplicationRuntime");
              }),
            ),
          ),
        );
        const exit = yield* Effect.exit(Effect.scoped(Layer.build(runtime)));

        assert.isTrue(Exit.hasInterrupts(exit));
        assert.deepEqual(events, [
          // SCIENT-FORK:START desktop-state-isolation
          "setPath:userData:/tmp/app-data/scient-next",
          // SCIENT-FORK:END desktop-state-isolation
          "requestSingleInstanceLock",
          "quit",
        ]);
        assert.equal(createClerkBridgeMock.mock.calls.length, 0);
        assert.equal(storageMock.mock.calls.length, 0);
      }),
  );
});

// SCIENT-FORK:START scient-deferred-auth — Scient defers provider auth deep links and ChatGPT handoff, and holds default-browser activation
it.effect("deferred provider auth deep links do not navigate or start authentication", () => {
  storageMock.mockReturnValue(storageAdapter);
  createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const revealed = Promise.withResolvers<void>();
  const loadURL = vi.fn(async (_url: string) => undefined);
  const window = { loadURL };
  const electronApp = {
    on: (name: string, listener: (...args: unknown[]) => void) =>
      Effect.sync(() => {
        listeners.set(name, listener);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];
  const electronWindow = {
    currentMainOrFirst: Effect.succeedSome(window),
    reveal: () => Effect.sync(() => revealed.resolve()),
  } as unknown as ElectronWindow.ElectronWindow["Service"];
  return Effect.gen(function* () {
    const clerk = yield* DesktopClerk.DesktopClerk;
    yield* clerk.configure;
    const event = { preventDefault: vi.fn() };
    listeners.get("open-url")!(event, "scient-next-dev://app/auth/callback?code=clerk-code");
    listeners.get("open-url")!(event, "scient://app/welcome");
    assert.equal(loadURL.mock.calls.length, 0);
    assert.equal(event.preventDefault.mock.calls.length, 0);
    listeners.get("second-instance")!({}, [
      "t3",
      "scient-next-dev://app/settings/providers?instanceId=work&code=never-forward",
    ]);
    yield* Effect.promise(() => revealed.promise);
    assert.deepEqual(loadURL.mock.calls, []);
    listeners.get("open-url")!(event, "scient-next-dev://app/welcome#agents:machine-id");
    listeners.get("open-url")!(event, "https://example.com");
    listeners.get("open-file")!(event, "/tmp/report.html");
    assert.equal(event.preventDefault.mock.calls.length, 0);
  }).pipe(
    Effect.scoped,
    Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, undefined, listeners)),
    Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
    Effect.provideService(ElectronApp.ElectronApp, electronApp),
    Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
  );
});

it.effect.each(["startup", "open-url", "early-second-instance"] as const)(
  "rejects deferred ChatGPT handoff through the desktop %s handler",
  (entry) =>
    Effect.gen(function* () {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
      const authorize = new URL("https://auth.openai.com/api/accounts/authorize");
      authorize.search = new URLSearchParams({
        client_id: "dynamic_agent_client",
        response_type: "code",
        redirect_uri: "http://127.0.0.1:19999/auth/callback",
        state: "a".repeat(43),
        code_challenge_method: "S256",
        code_challenge: "b".repeat(43),
      }).toString();
      const link = codexAuthHandoffUrl(
        {
          authorizationUrl: authorize.toString(),
          returnUrl: "http://127.0.0.1:3773/welcome#agents:remote-one",
          environmentId: EnvironmentId.make("remote-one"),
          instanceId: ProviderInstanceId.make("work"),
          flowId: "flow-one",
        },
        true,
      );
      const openExternal = vi.fn(() => Effect.die("Deferred auth must not open a browser"));
      const shell = ElectronShell.ElectronShell.of({
        openExternal,
        openSystemSettings: () => Effect.succeed(false),
        copyText: () => Effect.void,
        copyPng: () => Effect.succeed(true),
      });
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const electronApp = {
        whenReady: Effect.void,
        on: (name: string, listener: (...args: unknown[]) => void) =>
          Effect.sync(() => {
            listeners.set(name, listener);
          }),
      } as unknown as ElectronApp.ElectronApp["Service"];
      yield* Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        if (entry === "early-second-instance") {
          listeners.get("second-instance")?.({}, ["t3", link]);
        }
        yield* clerk.configure;
        if (entry === "open-url") {
          const event = { preventDefault: vi.fn() };
          listeners.get("open-url")!(event, link);
          assert.equal(event.preventDefault.mock.calls.length, 0);
        }
        assert.equal(openExternal.mock.calls.length, 0);
      }).pipe(
        Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, shell, listeners)),
        Effect.provideService(HostProcess.Arguments, entry === "startup" ? ["t3", link] : ["t3"]),
        Effect.provideService(ElectronApp.ElectronApp, electronApp),
        Effect.provide(
          Layer.mock(ElectronWindow.ElectronWindow)({ currentMainOrFirst: Effect.succeedNone }),
        ),
        Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
      );
    }).pipe(Effect.scoped),
);

it.effect("hands Scient app links to the renderer while browser activation stays held", () =>
  Effect.gen(function* () {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const electronApp = {
      whenReady: Effect.void,
      on: (name: string, listener: (...args: unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(name, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const received: Array<string> = [];
    const pairLink = "scient://pair?pairingUrl=https%3A%2F%2Fvps.example.com%2F%23token%3Dabc";
    yield* Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* clerk.configure;
      const open = (url: string) => {
        const event = { preventDefault: vi.fn() };
        listeners.get("open-url")!(event, url);
        return event.preventDefault.mock.calls.length;
      };
      // Scient's default-browser activation is held.
      assert.strictEqual(open("https://example.com/page"), 0);
      assert.strictEqual(open("http://localhost:3000/"), 0);
      assert.strictEqual(open("scient://new?prompt=hi"), 1);
      assert.strictEqual(open("scient-next-dev://threads/env-1/thread-1"), 1);
      assert.strictEqual(open("t3code://new?prompt=hi"), 0);
      assert.strictEqual(open(pairLink), 1);
      assert.strictEqual(open("scient://pair"), 0);
      assert.strictEqual(open(pairLink.replace("scient:", "t3code:")), 0);
      // Unregistered app identities and other protocols retain their handling.
      assert.strictEqual(open("mailto:hello@example.com"), 0);
      assert.strictEqual(open("t3code://somewhere-else"), 0);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(received, [
        "scient://new?prompt=hi",
        "scient-next-dev://threads/env-1/thread-1",
        pairLink,
      ]);
    }).pipe(
      Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, undefined, listeners)),
      Effect.provideService(HostProcess.Arguments, ["t3"]),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
      Effect.provideService(
        DesktopWebLinks.DesktopWebLinks,
        DesktopWebLinks.DesktopWebLinks.of({
          receive: (url) => Effect.sync(() => void received.push(url)),
          setRendererReady: () => Effect.void,
        }),
      ),
    );
  }).pipe(Effect.scoped),
);
// SCIENT-FORK:END scient-deferred-auth
