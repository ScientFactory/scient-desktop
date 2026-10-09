// @vitest-environment happy-dom
import { it } from "@effect/vitest";
import { RegistryContext } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type ConnectionCatalogEntry,
  type NetworkStatus,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { Persistence } from "@t3tools/client-runtime/platform";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import {
  BoundedThreadSnapshotLoader,
  type ThreadSnapshotLoader,
} from "@t3tools/client-runtime/state/threads";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadStreamItem,
  ThreadId,
  WsRpcGroup,
  type ServerConfig,
} from "@t3tools/contracts";
import { threadShellFromProjection } from "@t3tools/shared/orchestrationV2ThreadShell";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/reactivity";
import { HttpClient, HttpClientResponse } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { act, useId, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";
import {
  clearComposerDraftsEnvironment,
  DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import {
  resolveThreadDetailRef,
  useThreadProjection,
  useThreadShell,
  useThreadStatus,
} from "../state/entities";
import { environmentThreadDetails, environmentThreadShells } from "../state/threads";
import { makeThreadProjectionFixture } from "../test-fixtures";
import { ThreadRouteView } from "./ThreadRouteView";

type ConnectionLayer = Layer.Layer<
  | EnvironmentRegistry.EnvironmentRegistry
  | Persistence.EnvironmentCacheStore
  | ThreadSnapshotLoader
  | ShellSnapshotLoader.ShellSnapshotLoader
  | HttpClient.HttpClient
>;
const controls = vi.hoisted(
  (): { layer?: ConnectionLayer; navigate: ReturnType<typeof vi.fn> } => ({
    navigate: vi.fn(),
  }),
);

// The route and its real web/shared atoms stay mounted; only the heavy chat
// presentation and the external connection transport are replaced.
vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.suspend(() => {
        if (!controls.layer) throw new Error("Route transport was not initialized");
        return controls.layer;
      }),
    ),
  };
});
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => controls.navigate,
}));
vi.mock("./ui/sidebar", () => ({
  SidebarInset: ({ children }: PropsWithChildren) => <div>{children}</div>,
}));
vi.mock("./ChatView", () => ({
  default: function DetailConsumer({
    environmentId,
    threadId,
  }: {
    environmentId: EnvironmentId;
    threadId: ThreadId;
  }) {
    const instanceId = useId();
    const ref = { environmentId, threadId };
    const shell = useThreadShell(ref);
    const reserved = useComposerDraftStore((state) => state.getDraftSessionByRef(ref));
    const detailRef = resolveThreadDetailRef(ref, {
      shellExists: shell !== null,
      waitForShell: reserved !== null,
    });
    const detail = useThreadProjection(detailRef);
    const status = useThreadStatus(detailRef);
    return (
      <div data-chat-thread={threadId} data-detail-status={status} data-instance={instanceId}>
        {detail?.projection.thread.title ?? "Waiting for detail"}
      </div>
    );
  },
}));

const environmentId = EnvironmentId.make("route-environment");
const projection = makeThreadProjectionFixture();
const ref = { environmentId, threadId: projection.thread.id };
const target = { kind: "server" as const, threadRef: ref };
const encodeShell = Schema.encodeSync(OrchestrationV2ShellSnapshot);
const encodeBounded = Schema.encodeSync(OrchestrationV2ThreadBoundedSnapshot);
const encodeStreamItem = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));
const encodeShellItem = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2ShellStreamItem));
const connectionTarget = new PrimaryConnectionTarget({
  environmentId,
  label: "Controlled route transport",
  httpBaseUrl: "https://route.example.test",
  wsBaseUrl: "wss://route.example.test/ws",
});
const serverConfig: ServerConfig = {
  environment: {
    environmentId,
    label: connectionTarget.label,
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true, connectionProbe: true },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "/synthetic/route",
  keybindingsConfigPath: "/synthetic/route/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/synthetic/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
  shellResumeCompletionMarker: true,
  threadResumeCompletionMarker: true,
};

function makeTransport(input?: { active?: boolean }) {
  const httpStarted = Deferred.makeUnsafe<void>();
  const httpReply = Deferred.makeUnsafe<Response>();
  const socketStarted = Deferred.makeUnsafe<void>();
  const urls: string[] = [];
  let publishThread: ((item: OrchestrationV2ThreadStreamItem) => Effect.Effect<void>) | undefined;
  let publishShell: ((item: OrchestrationV2ShellStreamItem) => Effect.Effect<void>) | undefined;
  const archived = {
    ...projection,
    thread: { ...projection.thread, archivedAt: DateTime.makeUnsafe("2026-01-02T00:00:00Z") },
  };
  const other = {
    ...projection,
    thread: { ...projection.thread, id: ThreadId.make("other-thread") },
  };
  const shell: OrchestrationV2ShellSnapshot = {
    schemaVersion: 1,
    snapshotSequence: 1,
    projects: [
      {
        id: projection.thread.projectId,
        title: "Synthetic project",
        workspaceRoot: "/synthetic/route",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    threads: [
      threadShellFromProjection(other),
      ...(input?.active ? [threadShellFromProjection(projection)] : []),
    ],
    archivedThreads: [],
  };
  const encodedShell = encodeShell(shell);
  const httpClient = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      urls.push(url.pathname);
      if (url.pathname === "/api/orchestration/shell") {
        return HttpClientResponse.fromWeb(request, Response.json(encodedShell));
      }
      expect(url.pathname).toBe(`/api/orchestration/threads/${ref.threadId}/bounded`);
      yield* Deferred.succeed(httpStarted, undefined);
      return HttpClientResponse.fromWeb(request, yield* Deferred.await(httpReply));
    }),
  );
  const registryLayer = Layer.effect(
    EnvironmentRegistry.EnvironmentRegistry,
    Effect.gen(function* () {
      const protocol = yield* RpcClient.Protocol.make((write) =>
        Effect.succeed({
          supportsAck: false,
          supportsTransferables: false,
          codecFor: RpcSerialization.json.codecFor,
          send: (clientId, request) =>
            Effect.gen(function* () {
              if (request._tag !== "Request") return;
              if (request.tag === ORCHESTRATION_V2_WS_METHODS.subscribeThread) {
                publishThread = (item) =>
                  Effect.gen(function* () {
                    const encoded = yield* encodeStreamItem(item);
                    yield* write(clientId, {
                      _tag: "Chunk",
                      requestId: request.id,
                      values: [encoded],
                    });
                  }).pipe(Effect.orDie);
                yield* Deferred.succeed(socketStarted, undefined);
                yield* publishThread({ kind: "synchronized" });
                return;
              }
              if (request.tag === ORCHESTRATION_V2_WS_METHODS.subscribeShell) {
                publishShell = (item) =>
                  Effect.gen(function* () {
                    const encoded = yield* encodeShellItem(item);
                    yield* write(clientId, {
                      _tag: "Chunk",
                      requestId: request.id,
                      values: [encoded],
                    });
                  }).pipe(Effect.orDie);
                yield* publishShell({ kind: "synchronized" });
                return;
              }
              return yield* Effect.die(new Error(`Unexpected route RPC: ${request.tag}`));
            }),
        }),
      );
      const client = yield* RpcClient.make(WsRpcGroup).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      );
      const session: RpcSession = {
        client,
        initialConfig: Effect.succeed(serverConfig),
        subscribeServerConfig: client.subscribeServerConfig,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: connectionTarget,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.some(session)),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
          Option.some({
            environmentId,
            label: connectionTarget.label,
            target: connectionTarget,
            httpBaseUrl: connectionTarget.httpBaseUrl,
            socketUrl: connectionTarget.wsBaseUrl,
            httpAuthorization: null,
          }),
        ),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const entry: ConnectionCatalogEntry = {
        target: connectionTarget,
        profile: Option.none(),
        enabled: true,
      };
      return EnvironmentRegistry.EnvironmentRegistry.of({
        entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
          new Map([[environmentId, entry]]),
        ),
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        start: Effect.void,
        register: () => Effect.die("Unexpected registration"),
        registerPlatform: () => Effect.die("Unexpected registration"),
        reconcilePlatform: () => Effect.die("Unexpected reconciliation"),
        remove: () => Effect.die("Unexpected removal"),
        removeRoute: () => Effect.die("Unexpected route removal"),
        reorderRoutes: () => Effect.die("Unexpected route reorder"),
        removeRelayEnvironments: () => Effect.die("Unexpected removal"),
        retryNow: () => Effect.void,
        setEnabled: () => Effect.die("Unexpected toggle"),
        setCompatibility: () => Effect.die("Unexpected compatibility update"),
        state: () => SubscriptionRef.get(supervisor.state),
        stateChanges: () => SubscriptionRef.changes(supervisor.state),
        run: (_id, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        runStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_id, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      });
    }),
  );
  const cacheLayer = Layer.succeed(
    Persistence.EnvironmentCacheStore,
    Persistence.EnvironmentCacheStore.of({
      loadShell: () => Effect.succeedNone,
      saveShell: () => Effect.void,
      loadThread: () => Effect.succeedNone,
      saveThread: () => Effect.void,
      removeThread: () => Effect.void,
      loadServerConfig: () => Effect.succeedNone,
      saveServerConfig: () => Effect.void,
      loadVcsRefs: () => Effect.succeedNone,
      saveVcsRefs: () => Effect.void,
      removeVcsRefs: () => Effect.void,
      clearVcsRefs: () => Effect.void,
      clear: () => Effect.void,
    }),
  );
  return {
    layer: Layer.mergeAll(
      registryLayer,
      cacheLayer,
      BoundedThreadSnapshotLoader.layer,
      ShellSnapshotLoader.layer,
    ).pipe(Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, httpClient))),
    httpStarted,
    httpReply,
    socketStarted,
    urls,
    reply: (response: Response) => Deferred.succeed(httpReply, response),
    present: () =>
      Response.json(
        encodeBounded({
          snapshotSequence: 7,
          projection: archived,
          historyCursor: null,
          hasMoreHistory: false,
          latestLocalTurnOrdinal: null,
        }),
      ),
    publish: (item: OrchestrationV2ThreadStreamItem) => {
      if (!publishThread) throw new Error("Thread subscription has not started");
      return publishThread(item);
    },
    publishShell: (item: OrchestrationV2ShellStreamItem) => {
      if (!publishShell) throw new Error("Shell subscription has not started");
      return publishShell(item);
    },
    archived,
  };
}

let root: Root;
let host: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
let transport: ReturnType<typeof makeTransport>;
function inAct<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    let settle: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const action = yield* Effect.forkScoped(
      effect.pipe(Effect.ensuring(Effect.sync(() => settle()))),
    );
    yield* Effect.promise(() => act(() => completion));
    return yield* Fiber.join(action);
  });
}
function waitForStatus(status: string) {
  return AtomRegistry.toStream(registry, environmentThreadDetails.statusAtom(ref)).pipe(
    Stream.filter((value) => value === status),
    Stream.runHead,
    Effect.timeout("3 seconds"),
  );
}
function waitForStarted(signal: Deferred.Deferred<void>) {
  return Deferred.await(signal).pipe(Effect.timeout("1 second"));
}
function renderRoute() {
  return inAct(
    Effect.sync(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <ThreadRouteView target={target} />
        </RegistryContext.Provider>,
      ),
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  controls.navigate.mockClear();
  clearComposerDraftsEnvironment(environmentId);
  useSidebarPendingFileDropStore.setState({ pending: [] });
  transport = makeTransport();
  controls.layer = transport.layer;
  registry = AtomRegistry.make();
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  registry.dispose();
  clearComposerDraftsEnvironment(environmentId);
  useSidebarPendingFileDropStore.setState({ pending: [] });
  vi.unstubAllGlobals();
});

describe("ThreadRouteView canonical detail admission", () => {
  it.live(
    "mounts an archived route and loads its real HTTP detail despite an active-only shell",
    () =>
      Effect.gen(function* () {
        yield* renderRoute();
        expect(host.querySelector(`[data-chat-thread="${ref.threadId}"]`)).not.toBeNull();
        yield* waitForStarted(transport.httpStarted);
        yield* inAct(
          Effect.gen(function* () {
            yield* transport.reply(transport.present());
            yield* waitForStatus("live");
          }),
        );
        expect(host.textContent).toBe("Thread");
        expect(registry.get(environmentThreadDetails.threadAtom(ref))?.projection).toEqual(
          transport.archived,
        );
        expect(transport.urls).toContain(`/api/orchestration/threads/${ref.threadId}/bounded`);
        expect(controls.navigate).not.toHaveBeenCalled();
      }),
  );
  it.live("keeps a delayed target mounted without deleting pending drops or redirecting", () =>
    Effect.gen(function* () {
      const drop = useSidebarPendingFileDropStore
        .getState()
        .queuePendingFileDrop({ threadRef: ref, files: [new File(["retained"], "draft.txt")] });
      yield* renderRoute();
      yield* waitForStarted(transport.httpStarted);
      expect(host.textContent).toBe("Waiting for detail");
      expect(controls.navigate).not.toHaveBeenCalled();
      expect(useSidebarPendingFileDropStore.getState().pending.map((entry) => entry.id)).toEqual([
        drop,
      ]);
      yield* inAct(
        Effect.gen(function* () {
          yield* transport.reply(transport.present());
          yield* waitForStatus("live");
        }),
      );
      expect(host.textContent).toBe("Thread");
    }),
  );
  it.live("cleans only the missing target after authoritative HTTP absence", () =>
    Effect.gen(function* () {
      const store = useSidebarPendingFileDropStore.getState();
      store.queuePendingFileDrop({ threadRef: ref, files: [new File(["target"], "target.txt")] });
      const otherDrop = store.queuePendingFileDrop({
        threadRef: { environmentId, threadId: ThreadId.make("other-thread") },
        files: [new File(["other"], "other.txt")],
      });
      yield* renderRoute();
      yield* waitForStarted(transport.httpStarted);
      yield* inAct(
        Effect.gen(function* () {
          yield* transport.reply(
            Response.json(
              {
                _tag: "EnvironmentResourceNotFoundError",
                code: "not_found",
                reason: "thread_not_found",
                traceId: "synthetic-missing",
              },
              { status: 404 },
            ),
          );
          yield* waitForStatus("deleted");
        }),
      );
      expect(host.querySelector("[data-chat-thread]")).toBeNull();
      expect(controls.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/", replace: true });
      expect(useSidebarPendingFileDropStore.getState().pending.map((entry) => entry.id)).toEqual([
        otherDrop,
      ]);
    }),
  );
  it.live("keeps the route and files through a transient HTTP failure and real RPC fallback", () =>
    Effect.gen(function* () {
      const drop = useSidebarPendingFileDropStore
        .getState()
        .queuePendingFileDrop({ threadRef: ref, files: [new File(["retained"], "draft.txt")] });
      yield* renderRoute();
      yield* waitForStarted(transport.httpStarted);
      yield* inAct(
        Effect.gen(function* () {
          yield* transport.reply(new Response("unavailable", { status: 503 }));
          yield* waitForStarted(transport.socketStarted);
        }),
      );
      expect(host.querySelector("[data-chat-thread]")).not.toBeNull();
      expect(controls.navigate).not.toHaveBeenCalled();
      expect(useSidebarPendingFileDropStore.getState().pending.map((entry) => entry.id)).toEqual([
        drop,
      ]);
      yield* inAct(
        Effect.gen(function* () {
          yield* transport.publish({
            kind: "snapshot",
            snapshotSequence: 7,
            projection: transport.archived,
          });
          yield* waitForStatus("live");
        }),
      );
      expect(host.textContent).toBe("Thread");
    }),
  );
  it.live("retires a decoded HTTP tombstone through the canonical detail status", () =>
    Effect.gen(function* () {
      useSidebarPendingFileDropStore
        .getState()
        .queuePendingFileDrop({ threadRef: ref, files: [new File(["target"], "target.txt")] });
      yield* renderRoute();
      yield* waitForStarted(transport.httpStarted);
      yield* inAct(
        Effect.gen(function* () {
          yield* transport.reply(
            Response.json(
              encodeBounded({
                snapshotSequence: 7,
                projection: {
                  ...transport.archived,
                  thread: {
                    ...transport.archived.thread,
                    deletedAt: DateTime.makeUnsafe("2026-01-03T00:00:00Z"),
                  },
                },
                historyCursor: null,
                hasMoreHistory: false,
                latestLocalTurnOrdinal: null,
              }),
            ),
          );
          yield* waitForStatus("deleted");
        }),
      );
      expect(host.querySelector("[data-chat-thread]")).toBeNull();
      expect(registry.get(environmentThreadDetails.threadAtom(ref))).toBeNull();
      expect(controls.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/", replace: true });
      expect(useSidebarPendingFileDropStore.getState().pending).toEqual([]);
    }),
  );
  it.live("retains the ordinary active route and acquires one shared target load", () =>
    Effect.gen(function* () {
      transport = makeTransport({ active: true });
      controls.layer = transport.layer;
      yield* renderRoute();
      yield* waitForStarted(transport.httpStarted);
      yield* inAct(
        Effect.gen(function* () {
          yield* transport.reply(transport.present());
          yield* waitForStatus("live");
        }),
      );
      expect(host.textContent).toBe("Thread");
      expect(transport.urls.filter((url) => url.endsWith("/bounded"))).toHaveLength(1);
      expect(controls.navigate).not.toHaveBeenCalled();
    }),
  );
  it.live(
    "keeps a reserved draft target mounted without polling its intentionally absent detail",
    () =>
      Effect.gen(function* () {
        useComposerDraftStore
          .getState()
          .setProjectDraftThreadId(
            { environmentId, projectId: projection.thread.projectId },
            DraftId.make("reserved-draft"),
            { threadId: ref.threadId },
          );
        yield* renderRoute();
        expect(host.querySelector("[data-chat-thread]")).not.toBeNull();
        expect(host.querySelector("[data-detail-status]")?.getAttribute("data-detail-status")).toBe(
          "empty",
        );
        expect(transport.urls.filter((url) => url.includes(`/threads/${ref.threadId}`))).toEqual(
          [],
        );
        expect(controls.navigate).not.toHaveBeenCalled();
        expect(useComposerDraftStore.getState().getDraftSessionByRef(ref)?.threadId).toBe(
          ref.threadId,
        );
      }),
  );
  it.live(
    "preserves the draft consumer instance while promotion acquires canonical server detail",
    () =>
      Effect.gen(function* () {
        const draftId = DraftId.make("promoting-draft");
        useComposerDraftStore
          .getState()
          .setProjectDraftThreadId(
            { environmentId, projectId: projection.thread.projectId },
            draftId,
            {
              threadId: ref.threadId,
            },
          );
        const renderDraft = () =>
          root.render(
            <RegistryContext.Provider value={registry}>
              <ThreadRouteView target={{ kind: "draft", draftId }} />
            </RegistryContext.Provider>,
          );
        yield* inAct(Effect.sync(renderDraft));
        yield* inAct(
          AtomRegistry.toStream(
            registry,
            environmentThreadShells.environmentThreadsAtom(environmentId),
          ).pipe(
            Stream.filter((threads) => threads.length > 0),
            Stream.runHead,
            Effect.timeout("3 seconds"),
          ),
        );
        const instance = host.querySelector("[data-chat-thread]")?.getAttribute("data-instance");
        expect(instance).toBeDefined();
        expect(transport.urls.filter((url) => url.includes(`/threads/${ref.threadId}`))).toEqual(
          [],
        );
        const startedShell = {
          ...threadShellFromProjection(projection),
          latestUserMessageAt: projection.thread.createdAt,
        };
        yield* inAct(
          Effect.gen(function* () {
            yield* transport.publishShell({
              kind: "thread.updated",
              sequence: 2,
              location: "active",
              thread: startedShell,
            });
            yield* waitForStarted(transport.httpStarted);
            yield* transport.reply(transport.present());
            yield* waitForStatus("live");
          }),
        );
        expect(controls.navigate).toHaveBeenCalledWith({
          to: "/$environmentId/$threadId",
          params: ref,
          replace: true,
        });
        yield* renderRoute();
        expect(host.querySelector("[data-chat-thread]")?.getAttribute("data-instance")).toBe(
          instance,
        );
        expect(transport.urls.filter((url) => url.endsWith("/bounded"))).toHaveLength(1);
      }),
  );
});
