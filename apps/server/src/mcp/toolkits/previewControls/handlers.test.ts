import { PreviewAutomationControlInterruptedError } from "@t3tools/contracts";
import { SERVER_BROWSER_AUTOMATION_CLIENT_ID } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  BrowserProfileId,
  DEFAULT_SERVER_SETTINGS,
  defaultBrowserProfileRecord,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { AccountsService } from "../../../scient/accounts/AccountsService.ts";
import { fakeAccounts } from "../../../scient/accounts/agent/AccountsService.testkit.ts";
import * as Preview from "../../../preview/Manager.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewControlsHandlers from "./handlers.ts";
import { PreviewControlsToolkit } from "./tools.ts";

it.effect.each([
  { name: "project opt-in", globalAccess: false, projectAccess: true },
  { name: "project opt-out", globalAccess: true, projectAccess: false },
])("list and close respect the credential for a $name", ({ globalAccess, projectAccess }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const projectId = ProjectId.make("preview-controls-project");
      const threadId = ThreadId.make("preview-controls-thread");
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        enableAgentBrowserAccess: globalAccess,
        projectSettingsOverrides: {
          [projectId]: { enableAgentBrowserAccess: projectAccess },
        },
      };
      const effective = resolveProjectSettings(settings, projectId).settings;
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("preview-controls-environment"),
        requestNamespace: "preview-controls-provider-session",
        thread: {
          threadId,
          providerSessionId: "preview-controls-provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(effective.enableAgentBrowserAccess ? ["preview"] : []),
        issuedAt: 0,
      };
      const manager = yield* Preview.make.pipe(
        Effect.provide(
          Layer.merge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-controls-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
            NodeCrypto.layer,
          ),
        ),
      );
      const tab = yield* manager.open({ threadId, url: "http://localhost:3000" });
      const layerDependencies = Layer.mergeAll(
        PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer)),
        Layer.succeed(Preview.PreviewManager, manager),
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(settings),
          committedCustomModels: () => settings.customModels,
        }),
      );
      const toolkit = yield* PreviewControlsToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(PreviewControlsHandlers.layer).pipe(
            Layer.provide(layerDependencies),
          ),
        ),
      );
      const listed = yield* toolkit
        .handle("scient_preview_list", {})
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
      const closed = yield* toolkit
        .handle("scient_preview_close", { tabId: tab.tabId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
      if (projectAccess) {
        expect(listed.at(-1)?.result).toMatchObject({ sessions: [tab], nextCursor: null });
        expect(closed.at(-1)?.result).toEqual({});
        expect((yield* manager.list({ threadId })).sessions).toEqual([]);
      } else {
        for (const result of [listed, closed]) {
          expect(result.at(-1)?.result).toMatchObject({
            _tag: "PreviewAutomationUnavailableError",
            capability: "preview",
            threadId,
          });
        }
        expect((yield* manager.list({ threadId })).sessions).toEqual([tab]);
      }
    }),
  ),
);

it.effect("close reports why the server browser refused to close a tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("preview-controls-thread");
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("preview-controls-environment"),
        requestNamespace: "preview-controls-provider-session",
        thread: {
          threadId,
          providerSessionId: "preview-controls-provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["preview"]),
        issuedAt: 0,
      };
      const manager = yield* Preview.make.pipe(
        Effect.provide(
          Layer.merge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-controls-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
            NodeCrypto.layer,
          ),
        ),
      );
      const tab = yield* manager.open({
        threadId,
        url: "http://localhost:3000",
        runtime: "server",
      });
      const layerDependencies = Layer.mergeAll(
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
          invoke: () =>
            Effect.fail(
              new PreviewAutomationControlInterruptedError({
                operation: "close",
                environmentId: scope.environmentId,
                threadId,
                providerSessionId: "preview-controls-provider-session",
                providerInstanceId: ProviderInstanceId.make("codex"),
                clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
                connectionId: "server-browser-connection",
                requestId: "close-request",
                tabId: tab.tabId,
                timeoutMs: 1_000,
                remoteTag: "PreviewAutomationControlInterruptedError",
                remoteMessageLength: 0,
                cause: null,
                reason: "agentMismatch",
              }),
            ),
        }),
        Layer.succeed(Preview.PreviewManager, manager),
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            enableAgentBrowserAccess: true,
          }),
          committedCustomModels: () => DEFAULT_SERVER_SETTINGS.customModels,
        }),
      );
      const toolkit = yield* PreviewControlsToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(PreviewControlsHandlers.layer).pipe(
            Layer.provide(layerDependencies),
          ),
        ),
      );

      const closed = yield* toolkit
        .handle("scient_preview_close", { tabId: tab.tabId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

      expect(closed.at(-1)?.result).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
    }),
  ),
);

it.effect("list hides and close refuses tabs in profiles this session may not see", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("preview-controls-thread");
      const workId = BrowserProfileId.make("work");
      const privateId = BrowserProfileId.make("private");
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("preview-controls-environment"),
        requestNamespace: "preview-controls-provider-session",
        thread: {
          threadId,
          providerSessionId: "preview-controls-provider-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["preview"]),
        issuedAt: 0,
      };
      const manager = yield* Preview.make.pipe(
        Effect.provide(
          Layer.merge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-controls-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
            NodeCrypto.layer,
          ),
        ),
      );
      const work = yield* manager.open({
        threadId,
        url: "http://localhost:3000",
        profileId: workId,
      });
      const hidden = yield* manager.open({
        threadId,
        url: "http://localhost:3001",
        profileId: privateId,
      });
      const tools = (agentAccess: boolean) => {
        const dependencies = Layer.mergeAll(
          PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer)),
          Layer.succeed(Preview.PreviewManager, manager),
          Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
          McpToolAccessTestkit.liveThreadsLayer,
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              enableAgentBrowserAccess: true,
            }),
            committedCustomModels: () => DEFAULT_SERVER_SETTINGS.customModels,
          }),
          Layer.succeed(
            AccountsService,
            fakeAccounts({
              agentAccess,
              profiles: [
                defaultBrowserProfileRecord(workId),
                { ...defaultBrowserProfileRecord(privateId), access: "off" },
              ],
            }).service,
          ),
          Layer.mock(ProjectionStoreV2)({
            getThreadRecords: () => Effect.succeed(idleThreadProjection(liveThreadShell(threadId))),
          }),
        );
        return PreviewControlsToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(PreviewControlsHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
          Effect.map((toolkit) => ({
            list: toolkit
              .handle("scient_preview_list", {})
              .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies)),
            close: (tabId: string) =>
              toolkit
                .handle("scient_preview_close", { tabId })
                .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies)),
          })),
        );
      };
      const off = yield* tools(false);
      expect((yield* off.list).at(-1)?.result).toMatchObject({ sessions: [] });
      const on = yield* tools(true);
      expect((yield* on.list).at(-1)?.result).toMatchObject({ sessions: [work], nextCursor: null });
      expect((yield* on.close(hidden.tabId)).at(-1)?.result).toMatchObject({
        _tag: "AccountsError",
        reason: "denied",
      });
      expect((yield* on.close(work.tabId)).at(-1)?.result).toEqual({});
      expect((yield* manager.list({ threadId })).sessions).toEqual([hidden]);
    }),
  ),
);
