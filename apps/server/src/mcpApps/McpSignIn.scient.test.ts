import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as McpSignIn from "./McpSignIn.ts";

const instanceId = ProviderInstanceId.make("codex-chat-sign-in");
const providerThread = {
  id: ProviderThreadId.make("provider-thread-chat-sign-in"),
  providerInstanceId: instanceId,
  providerSessionId: ProviderSessionId.make("provider-session-chat-sign-in"),
};
const input = {
  threadId: ThreadId.make("thread-chat-sign-in"),
  providerThreadId: providerThread.id,
  server: "linear",
};

it.effect("refreshes the instance's inventory after a chat sign-in finishes", () =>
  Effect.gen(function* () {
    const refreshed = yield* Deferred.make<ProviderInstanceId>();
    const completed: Array<string | undefined> = [];
    const layer = McpSignIn.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed({ providerThreads: [providerThread] }) as never,
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () =>
              Effect.succeed(
                Option.some({
                  mcpSignIn: {
                    start: () => Effect.succeed({ authorizationUrl: "https://linear.example/a" }),
                    complete: ({ callbackUrl }: { readonly callbackUrl: string | undefined }) =>
                      Effect.sync(() => {
                        completed.push(callbackUrl);
                      }),
                  },
                }) as never,
              ),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            refreshInstance: (id) => Deferred.succeed(refreshed, id).pipe(Effect.as([])),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const signIn = yield* McpSignIn.McpSignIn;
      yield* signIn.complete(input);
      assert.deepEqual(completed, [undefined]);
      assert.strictEqual(yield* Deferred.await(refreshed), instanceId);
    }).pipe(Effect.provide(layer));
  }),
);
