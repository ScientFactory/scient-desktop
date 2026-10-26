import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../../../config.ts";
import { Effect, Layer, Stream } from "effect";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { AccountsService } from "../../../scient/accounts/AccountsService.ts";
import { makeHarness } from "../../../scient/accounts/AccountsTestkit.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  idleThreadProjection,
  liveThreadShell,
  liveThreadsLayer,
} from "../../McpToolAccess.testkit.ts";
import { PreviewAutomationBroker } from "../../PreviewAutomationBroker.ts";
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
          invoke: <A>(request: { operation: string }) =>
            Effect.sync(() => {
              if (request.operation !== "status") actions++;
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
            .handle("preview_click", { selector: "button" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit.handle("preview_type", { text: "query" }).pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit.handle("preview_press", { key: "Enter" }).pipe(Stream.unwrap, Stream.runDrain),
        () => toolkit.handle("preview_scroll", { deltaY: 1 }).pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_evaluate", { tabId: "work-tab", expression: "document.title" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_hover", { selector: "button" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_select", { selector: "select", values: [] })
            .pipe(Stream.unwrap, Stream.runDrain),
        () =>
          toolkit
            .handle("preview_drag", { source: "#source", target: "#target" })
            .pipe(Stream.unwrap, Stream.runDrain),
        () => toolkit.handle("preview_upload", { paths: [] }).pipe(Stream.unwrap, Stream.runDrain),
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
      yield* run(toolkit.handle("preview_click", { selector: "button" })).pipe(
        Effect.provide(dependencies),
      );
      expect(actions).toBe(1);
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
      yield* run(legacy.handle("preview_click", { selector: "button" })).pipe(Effect.provide(base));
      expect(actions).toBe(2);
    }).pipe(Effect.scoped),
);
