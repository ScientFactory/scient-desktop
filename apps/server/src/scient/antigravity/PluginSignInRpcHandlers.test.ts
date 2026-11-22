import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  type OrchestrationV2ProviderThread,
  ProviderSessionId,
  ProviderThreadId,
  RpcScopeAuthorization,
  ThreadId,
  WS_METHODS,
  WsPluginSignInOpenRpc,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { RpcGroup, RpcTest } from "effect/rpc";

import type * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import { makePluginSignInRpcHandlers } from "./PluginSignInRpcHandlers.ts";

const threadId = ThreadId.make("thread-plugin-sign-in");
const providerThreadId = ProviderThreadId.make("provider-thread-plugin-sign-in");
const input = { threadId, providerThreadId, attemptId: "attempt-1" };

const harness = (options: { readonly live: boolean }) => {
  const opened: Array<unknown> = [];
  const providerThread = {
    id: providerThreadId,
    providerSessionId: ProviderSessionId.make("provider-session-plugin-sign-in"),
  } as OrchestrationV2ProviderThread;
  const threadManagement = {
    getThreadRecords: () => Effect.succeed({ providerThreads: [providerThread] }),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"];
  const providerSessions = {
    get: () =>
      Effect.succeed(
        options.live
          ? Option.some({
              scientPluginSignIn: {
                open: (request: unknown) =>
                  Effect.sync(() => {
                    opened.push(request);
                    return { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" };
                  }),
              },
            })
          : Option.none(),
      ),
  } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"];
  const group = RpcGroup.make(WsPluginSignInOpenRpc).middleware(RpcScopeAuthorization);
  const layer = group.toLayer(
    makePluginSignInRpcHandlers({
      observeRpcEffect: (_method, effect) => effect,
      threadManagement,
      providerSessions,
    }),
  );
  const client = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
    RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(layer, RpcAuthorization.layer(scopes))),
    );
  return { client, opened, providerThread };
};

it.effect("opens a plugin sign-in only with the provider management grant", () =>
  Effect.gen(function* () {
    const { client, opened, providerThread } = harness({ live: true });
    const operator = yield* client([AuthOrchestrationOperateScope]);
    expect(yield* operator[WS_METHODS.pluginSignInOpen](input).pipe(Effect.flip)).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthProvidersManageScope,
    });
    expect(opened).toEqual([]);
    const manager = yield* client([AuthProvidersManageScope]);
    expect(yield* manager[WS_METHODS.pluginSignInOpen](input)).toEqual({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    });
    expect(opened).toEqual([{ threadId, providerThread, attemptId: "attempt-1" }]);
  }).pipe(Effect.scoped),
);

it.effect("reports an ended agent session as an expired sign-in", () =>
  Effect.gen(function* () {
    const manager = yield* harness({ live: false }).client([AuthProvidersManageScope]);
    expect(yield* manager[WS_METHODS.pluginSignInOpen](input).pipe(Effect.flip)).toMatchObject({
      _tag: "PluginSignInError",
      reason: "expired",
    });
  }).pipe(Effect.scoped),
);
