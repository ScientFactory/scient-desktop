import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AccountId,
  BrowserProfileId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  defaultAccountControls,
  defaultBrowserProfileRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { AccountsService } from "../../../scient/accounts/AccountsService.ts";
import { fakeAccounts } from "../../../scient/accounts/Accounts.testkit.ts";
import * as Preview from "../../../preview/Manager.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewControlsHandlers from "./handlers.ts";
import { PreviewControlsToolkit } from "./tools.ts";

it.effect("lists no tab a user signs in on, nor a university's own sign-in page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("preview-controls-signing");
      const profileId = BrowserProfileId.make("default");
      const manager = yield* Preview.make.pipe(
        Effect.provide(
          Layer.merge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-signing-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
            NodeCrypto.layer,
          ),
        ),
      );
      const site = yield* manager.open({ threadId, url: "https://example.com/login", profileId });
      const idp = yield* manager.open({
        threadId,
        url: "https://idp.example.edu/login?AuthState=private",
        profileId,
      });
      const fake = fakeAccounts({
        profiles: [defaultBrowserProfileRecord(profileId)],
        accounts: [
          {
            accountId: AccountId.make("acc_university_fixture"),
            name: "Example University",
            details: {
              kind: "website",
              sites: ["example.edu", "https://idp.example.edu"],
              institution: {
                name: "Example University",
                entityId: "https://idp.example.edu/entity",
                domain: "example.edu",
              },
            },
            secrets: {},
            controls: defaultAccountControls("website"),
            status: "ready",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      yield* fake.service.setAttempt({
        attemptId: "attempt-1",
        threadId,
        tabId: site.tabId,
        accountId: AccountId.make("acc_site_fixture"),
        state: "person",
      });
      const dependencies = Layer.mergeAll(
        PreviewAutomationBroker.layer.pipe(
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
        Layer.succeed(Preview.PreviewManager, manager),
        Layer.succeed(AccountsService, fake.service),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("preview-signing-environment"),
          requestNamespace: "preview-signing",
          thread: {
            threadId,
            providerSessionId: "preview-signing",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["preview"] as const),
          issuedAt: 0,
        }),
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () =>
            Effect.succeed(
              McpToolAccessTestkit.idleThreadProjection(
                McpToolAccessTestkit.liveThreadShell(threadId),
              ),
            ),
        }),
      );
      const toolkit = yield* PreviewControlsToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(PreviewControlsHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const list = toolkit
        .handle("scient_preview_list", {})
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      const listed = (yield* list).at(-1)?.result;
      expect(listed).toMatchObject({ sessions: [] });
      expect(JSON.stringify(listed)).not.toContain("AuthState");
      // Once the sign-in ends, its tab is listed again; the sign-in page never is.
      yield* fake.service.removeAttempt("attempt-1");
      expect((yield* list).at(-1)?.result).toMatchObject({
        sessions: [expect.objectContaining({ tabId: site.tabId })],
      });
      expect(JSON.stringify((yield* list).at(-1)?.result)).not.toContain(idp.tabId);
    }),
  ),
);
