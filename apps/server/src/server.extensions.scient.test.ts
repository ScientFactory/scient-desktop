import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WS_METHODS } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  NodeHttpServerTest,
  buildAppUnderTest,
  getWsServerUrl,
  withWsRpcClient,
} from "./server.testkit.ts";

it.live("opens the extensions change feed on the default test server", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest();
    const wsUrl = yield* getWsServerUrl("/ws");
    // Nothing changes, so a healthy feed stays open with nothing to say.
    const exit = yield* Effect.scoped(
      withWsRpcClient(wsUrl, (client) =>
        client[WS_METHODS.extensionsSubscribeChanges]({}).pipe(
          Stream.runHead,
          Effect.timeoutOption("300 millis"),
        ),
      ),
    ).pipe(Effect.exit);
    assert.isTrue(Exit.isSuccess(exit), String(exit));
    if (Exit.isSuccess(exit)) assert.isTrue(Option.isNone(exit.value));
  }).pipe(
    Effect.provide(
      NodeHttpServerTest.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer)),
      ),
    ),
  ),
);
