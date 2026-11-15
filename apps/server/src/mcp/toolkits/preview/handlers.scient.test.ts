import { expect, it } from "@effect/vitest";
import {
  AccountId,
  EnvironmentId,
  ProjectId,
  PreviewAutomationTimeoutError,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationOperation,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../../../config.ts";
import { Deferred, Duration, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { AccountsService } from "../../../scient/accounts/AccountsService.ts";
import { makeHarness } from "../../../scient/accounts/Accounts.testkit.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  idleThreadProjection,
  liveThreadShell,
  liveThreadsLayer,
} from "../../McpToolAccess.testkit.ts";
import {
  PREVIEW_AUTOMATION_DEFAULT_TIMEOUT_MS,
  PreviewAutomationBroker,
  type PreviewAutomationInvokeInput,
} from "../../PreviewAutomationBroker.ts";
import { layerStandard, layerSnapshot } from "./handlers.ts";
import { PreviewStandardToolkit, PreviewSnapshotToolkit } from "./tools.ts";

it.effect(
  "revoking an open tab blocks every preview action and hides its current-page metadata without prompting",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("accounts-preview-thread");
      const shell = liveThreadShell(threadId);
      const status: PreviewAutomationStatus = {
        available: true,
        visible: true,
        tabId: "work-tab",
        url: "https://example.com",
        title: "Private page",
        loading: true,
        dialog: { type: "alert", message: "Private dialog", defaultValue: "" },
        downloads: [
          {
            fileName: "private.txt",
            path: "/synthetic/private.txt",
            sizeBytes: 1,
            url: "https://example.com",
            completedAt: "2026-10-26T00:00:00.000Z",
          },
        ],
        profiles: [
          { id: "work", name: "Work" },
          { id: "default", name: "Default" },
        ],
        defaultProfileId: "work",
        tabs: [
          { tabId: "work-tab", url: "https://example.com", profileId: "work" },
          { tabId: "default-tab", url: null, profileId: "default" },
        ],
      };
      const { service } = yield* makeHarness();
      let actions = 0;
      const targets: Array<string | undefined> = [];
      const base = Layer.mergeAll(
        liveThreadsLayer,
        NodeServices.layer,
        ServerConfig.layerTest(process.cwd(), { prefix: "accounts-preview-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        Layer.succeed(McpInvocationContext, {
          environmentId: EnvironmentId.make("accounts-preview-environment"),
          requestNamespace: "accounts-preview",
          issuedAt: 0,
          client: undefined,
          capabilities: new Set(["preview"] as const),
          thread: {
            threadId,
            providerSessionId: "accounts-preview",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
        }),
        Layer.mock(PreviewAutomationBroker)({
          invoke: <A>(request: { operation: string; tabId?: string }) =>
            Effect.sync(() => {
              if (request.operation !== "status") {
                actions++;
                targets.push(request.tabId);
              }
              return (request.operation === "click" ? {} : status) as A;
            }),
        }),
      );
      const dependencies = Layer.mergeAll(
        base,
        Layer.succeed(AccountsService, service),
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
        }),
      );
      const toolkit = yield* PreviewStandardToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(layerStandard).pipe(Layer.provide(dependencies)),
        ),
      );
      const snapshot = yield* PreviewSnapshotToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(layerSnapshot).pipe(Layer.provide(dependencies)),
        ),
      );
      const run = <A, E, R>(effect: Effect.Effect<Stream.Stream<A, E, R>, E, R>) =>
        effect.pipe(Stream.unwrap, Stream.runCollect);
      const calls = [
        () =>
          toolkit
            .handle("preview_navigate", { url: "https://example.com" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_act", { action: "click", selector: "button" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_act", { action: "type", text: "query" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_act", { action: "press", key: "Enter" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_act", { action: "scroll", deltaY: 1 })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_evaluate", { tabId: "work-tab", expression: "document.title" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_act", { action: "hover", selector: "button" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_act", { action: "select", selector: "select", values: [] })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_act", { action: "drag", source: "#source", target: "#target" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_act", { action: "upload", paths: [] })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit.handle("preview_dialog", { accept: true }).pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit.handle("preview_resize", { mode: "fill" }).pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_set_appearance", { colorScheme: "dark" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_wait_for", { selector: "button" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () => toolkit.handle("preview_recording_start", {}).pipe(Stream.unwrap, Stream.runDrain),
        () => toolkit.handle("preview_recording_stop", {}).pipe(Stream.unwrap, Stream.runDrain),
        () => snapshot.handle("preview_snapshot", {}).pipe(Stream.unwrap, Stream.runDrain),
      ];
      yield* service.setControls({ target: { type: "profile", profileId: "work" }, access: "ask" });
      yield* run(toolkit.handle("preview_act", { action: "click", selector: "button" })).pipe(
        Effect.provide(dependencies),
      );
      expect(actions).toBe(1);
      // The check reads the current tab, but an unnamed tab stays unnamed for the browser.
      expect(targets).toEqual([undefined]);
      for (const revoke of [
        service.setAgentAccess(false),
        service.setAgentAccess(true).pipe(
          Effect.andThen(
            service.setControls({
              target: { type: "profile", profileId: "work" },
              access: "off",
            }),
          ),
        ),
        service.setControls({
          target: { type: "profile", profileId: "work" },
          access: "allowed",
          scope: { type: "projects", projectIds: [ProjectId.make("excluded-project")] },
        }),
      ]) {
        yield* revoke;
        for (const call of calls) {
          const error = yield* call().pipe(Effect.flip, Effect.provide(dependencies));
          expect(error).toMatchObject({ _tag: "AccountsError", reason: "denied" });
        }
        const response = yield* run(toolkit.handle("preview_status", {})).pipe(
          Effect.provide(dependencies),
        );
        const filtered = response.at(-1)?.result;
        expect(filtered).toMatchObject({ tabId: null, url: null, title: null, loading: false });
        expect(filtered).not.toHaveProperty("dialog");
        expect(filtered).not.toHaveProperty("downloads");
        expect(filtered).not.toHaveProperty("defaultProfileId");
        expect(filtered).not.toMatchObject({
          tabs: expect.arrayContaining([expect.objectContaining({ profileId: "work" })]),
        });
      }
      expect(actions).toBe(1);
      expect((yield* service.snapshot).approvals).toEqual([]);
      const legacy = yield* PreviewStandardToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(layerStandard).pipe(Layer.provide(base))),
      );
      yield* run(legacy.handle("preview_act", { action: "click", selector: "button" })).pipe(
        Effect.provide(base),
      );
      expect(actions).toBe(2);
    }).pipe(Effect.scoped),
);

it.effect(
  "no agent reads or drives a tab while the user signs in there, nor a university's sign-in after",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("accounts-signing-thread");
      const shell = liveThreadShell(threadId);
      let url = "https://example.com/login";
      const status = (): PreviewAutomationStatus => ({
        available: true,
        visible: true,
        tabId: "sign-in-tab",
        url,
        title: "Sign in",
        loading: false,
        profiles: [{ id: "default", name: "Main" }],
        tabs: [{ tabId: "sign-in-tab", url, profileId: "default" }],
      });
      const { service } = yield* makeHarness();
      const reached: string[] = [];
      const dependencies = Layer.mergeAll(
        liveThreadsLayer,
        NodeServices.layer,
        ServerConfig.layerTest(process.cwd(), { prefix: "accounts-signing-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        Layer.succeed(McpInvocationContext, {
          environmentId: EnvironmentId.make("accounts-signing-environment"),
          requestNamespace: "accounts-signing",
          issuedAt: 0,
          client: undefined,
          capabilities: new Set(["preview"] as const),
          thread: {
            threadId,
            providerSessionId: "accounts-signing",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
        }),
        Layer.mock(PreviewAutomationBroker)({
          invoke: <A>(request: { operation: string }) =>
            Effect.sync(() => {
              if (request.operation !== "status") reached.push(request.operation);
              return (request.operation === "status" ? status() : {}) as A;
            }),
        }),
        Layer.succeed(AccountsService, service),
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
        }),
      );
      const toolkit = yield* PreviewStandardToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(layerStandard).pipe(Layer.provide(dependencies)),
        ),
      );
      const snapshot = yield* PreviewSnapshotToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(layerSnapshot).pipe(Layer.provide(dependencies)),
        ),
      );
      const reads = [
        () =>
          snapshot
            .handle("preview_snapshot", { tabId: "sign-in-tab" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_evaluate", { tabId: "sign-in-tab", expression: "document.body" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_wait_for", { tabId: "sign-in-tab", selector: "input" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_act", { tabId: "sign-in-tab", action: "click", selector: "a" })
            .pipe(Stream.unwrap, Stream.runDrain),
        // Opening would reuse the tab, named or current.
        () =>
          toolkit
            .handle("preview_open", { tabId: "sign-in-tab", url: "https://example.org/" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_open", { url: "https://example.org/" })
            .pipe(Stream.unwrap, Stream.runDrain),
      ];
      const refused = Effect.forEach(reads, (read) =>
        read().pipe(
          Effect.flip,
          Effect.provide(dependencies),
          Effect.map((error) => (error as { message?: string }).message),
        ),
      );
      const attempt = {
        attemptId: "attempt-1",
        threadId: ThreadId.make("user-thread"),
        tabId: "sign-in-tab",
        accountId: AccountId.make("acc_signing_fixture"),
      };
      // Typing, a person finishing, a code waiting: every state of an attempt is closed.
      for (const state of ["typing", "person", "pending"] as const) {
        yield* service.setAttempt({ ...attempt, state });
        expect(yield* refused).toEqual(
          reads.map(() => "The user is signing in on this tab. Wait for scient_account_sign_in."),
        );
      }
      expect(reached).toEqual([]);
      // Listing shows neither the tab nor its address, to the agent that started it or another.
      for (const thread of [attempt.threadId, ThreadId.make("another-thread")]) {
        const listed = yield* toolkit.handle("preview_status", {}).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provideService(McpInvocationContext, {
            environmentId: EnvironmentId.make("accounts-signing-environment"),
            requestNamespace: "accounts-signing",
            issuedAt: 0,
            client: undefined,
            capabilities: new Set(["preview"] as const),
            thread: {
              threadId: thread,
              providerSessionId: "accounts-signing",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
          }),
          Effect.provide(dependencies),
        );
        const status = listed.at(-1)?.result;
        expect(status).toMatchObject({ tabId: null, url: null, title: null, tabs: [] });
        expect(JSON.stringify(status)).not.toContain("example.com/login");
      }
      yield* service.removeAttempt(attempt.attemptId);
      // Once it ends, the agent's read reaches the browser again.
      yield* snapshot
        .handle("preview_snapshot", { tabId: "sign-in-tab" })
        .pipe(Stream.unwrap, Stream.runDrain, Effect.exit, Effect.provide(dependencies));
      expect(reached).toEqual(["snapshot"]);
      // Afterwards, the tab on a university's learned sign-in page stays closed.
      yield* service.save({
        name: "Example University",
        details: {
          kind: "website",
          sites: ["example.edu", "https://idp.example.edu"],
          institution: {
            name: "Example University",
            entityId: "https://idp.example.edu/shibboleth",
            domain: "example.edu",
          },
        },
        secrets: {},
      });
      url = "https://idp.example.edu/simplesaml/login";
      expect(yield* refused).toHaveLength(reads.length);
      expect(reached).toEqual(["snapshot"]);
    }).pipe(Effect.scoped),
);

it.effect("the account check before an action spends the action's budget, not its own", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("accounts-budget-thread");
    const shell = liveThreadShell(threadId);
    const environmentId = EnvironmentId.make("accounts-budget-environment");
    const status: PreviewAutomationStatus = {
      available: true,
      visible: true,
      tabId: "work-tab",
      url: "https://example.com",
      title: "Page",
      loading: false,
      profiles: [{ id: "work", name: "Work" }],
      tabs: [{ tabId: "work-tab", url: "https://example.com", profileId: "work" }],
    };
    const { service } = yield* makeHarness();
    // How long each operation takes in the browser; one that runs past its budget times out then.
    const takes: Partial<Record<PreviewAutomationOperation, number>> = {};
    // The budgets each action reached the browser with: the broker's and the one its host reads.
    const dispatched: Array<{ envelope: number | undefined; input: number | undefined }> = [];
    let reached = Deferred.makeUnsafe<void>();
    const dependencies = Layer.mergeAll(
      liveThreadsLayer,
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "accounts-budget-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      Layer.succeed(McpInvocationContext, {
        environmentId,
        requestNamespace: "accounts-budget",
        issuedAt: 0,
        client: undefined,
        capabilities: new Set(["preview"] as const),
        thread: {
          threadId,
          providerSessionId: "accounts-budget",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      }),
      Layer.mock(PreviewAutomationBroker)({
        invoke: <A>(request: PreviewAutomationInvokeInput) => {
          const dispatch = Effect.sync(() => {
            if (request.operation !== "status")
              dispatched.push({
                envelope: request.timeoutMs,
                input: (request.input as { timeoutMs?: number }).timeoutMs,
              });
          });
          const budgetMs = request.timeoutMs ?? PREVIEW_AUTOMATION_DEFAULT_TIMEOUT_MS;
          const spentMs = takes[request.operation] ?? 0;
          // Signalled just before the browser's timer starts, so the clock moves past it.
          const sleep = (ms: number) =>
            Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.sleep(ms)));
          return spentMs <= budgetMs
            ? dispatch.pipe(Effect.andThen(sleep(spentMs)), Effect.as(status as A))
            : dispatch.pipe(
                Effect.andThen(sleep(budgetMs)),
                Effect.andThen(
                  new PreviewAutomationTimeoutError({
                    operation: request.operation,
                    environmentId,
                    threadId,
                    clientId: "server-browser",
                    connectionId: "accounts-budget-connection",
                    requestId: "preview-1",
                    timeoutMs: budgetMs,
                  }),
                ),
              );
        },
      }),
      Layer.succeed(AccountsService, service),
      Layer.mock(ProjectionStoreV2)({
        getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
      }),
    );
    const toolkit = yield* PreviewStandardToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(layerStandard).pipe(Layer.provide(dependencies)),
      ),
    );
    yield* service.setControls({ target: { type: "profile", profileId: "work" }, access: "ask" });
    const waitFor = Effect.fn(function* (
      ms: Partial<Record<PreviewAutomationOperation, number>>,
      timeoutMs?: number,
    ) {
      Object.assign(takes, ms);
      dispatched.length = 0;
      reached = Deferred.makeUnsafe<void>();
      const call = yield* Effect.timed(
        toolkit
          .handle("preview_wait_for", {
            selector: "#done",
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          })
          .pipe(Stream.unwrap, Stream.runDrain, Effect.flip),
      ).pipe(Effect.provide(dependencies), Effect.forkChild);
      // The handler reads real files before it reaches the browser; move the clock once it has.
      yield* Deferred.await(reached);
      yield* TestClock.adjust("20 minutes");
      const [took, error] = yield* Fiber.join(call);
      return { tookMs: Duration.toMillis(took), error: error._tag, dispatched: [...dispatched] };
    });
    // A slow check leaves the wait what remains, in the browser's own timer too.
    expect(yield* waitFor({ status: 2_000, waitFor: Number.POSITIVE_INFINITY }, 5_000)).toEqual({
      tookMs: 5_000,
      error: "PreviewAutomationTimeoutError",
      dispatched: [{ envelope: 3_000, input: 3_000 }],
    });
    // The agent left the budget to the default, which the browser then reads as given.
    expect(yield* waitFor({ status: 2_000 })).toEqual({
      tookMs: PREVIEW_AUTOMATION_DEFAULT_TIMEOUT_MS,
      error: "PreviewAutomationTimeoutError",
      dispatched: [
        {
          envelope: PREVIEW_AUTOMATION_DEFAULT_TIMEOUT_MS - 2_000,
          input: PREVIEW_AUTOMATION_DEFAULT_TIMEOUT_MS - 2_000,
        },
      ],
    });
    // A check that used the whole budget sends nothing; a stuck one ends with the agent's budget.
    expect(yield* waitFor({ status: 5_000 }, 5_000)).toEqual({
      tookMs: 5_000,
      error: "PreviewAccountCheckTimeoutError",
      dispatched: [],
    });
    expect(yield* waitFor({ status: Number.POSITIVE_INFINITY }, 5_000)).toEqual({
      tookMs: 5_000,
      error: "PreviewAutomationTimeoutError",
      dispatched: [],
    });
  }).pipe(Effect.scoped),
);
