import * as Effect from "effect/Effect";
import type { ThreadId } from "@t3tools/contracts";
import type { PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

export const observeEnvironmentKeepAwake = Effect.fn(
  "clientRuntime.state.observeEnvironmentKeepAwake",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadIds: readonly ThreadId[];
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer: yield* Effect.serviceOption(ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
    group: "scientKeepAwake",
    method: "POST",
    url: (urls) => urls.observe(),
    timeoutMs: 8_000,
    request: ({ client, headers }) =>
      client.observe({ headers, payload: { threadIds: input.threadIds, includeLocalWork: false } }),
  });
});
