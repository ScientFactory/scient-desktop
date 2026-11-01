import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { __testing } from "./McpSessionRegistry.ts";

it.effect(
  "releases session cache owners on expiry, exact, thread and global revocation; observers are scoped",
  () =>
    Effect.gen(function* () {
      let now = 1000;
      const registry = yield* __testing.make({ now: () => now, livenessWindowMs: 100 }).pipe(
        Effect.provideService(
          HttpServer.HttpServer,
          HttpServer.HttpServer.of({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
            serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
          }),
        ),
        Effect.provideService(
          ServerEnvironment,
          ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("synthetic")),
            getDescriptor: Effect.die("unused"),
          }),
        ),
        Effect.provide(NodeServices.layer),
      );
      const revoked: string[] = [];
      const reasons: string[] = [];
      yield* registry.onRevoke!((id, reason) =>
        Effect.sync(() => {
          revoked.push(id);
          reasons.push(reason);
        }),
      );
      const threadId = ThreadId.make("synthetic-thread");
      const input = {
        threadId,
        providerInstanceId: ProviderInstanceId.make("synthetic-agent"),
        capabilities: new Set<never>(),
      };
      const expiring = yield* registry.issue(input);
      now += 101;
      expect(yield* registry.resolve(expiring.config.authorizationHeader.slice(7))).toBeUndefined();
      expect(revoked).toEqual([expiring.config.providerSessionId]);
      expect(reasons).toEqual(["expired"]);
      const exact = yield* registry.issue(input);
      yield* registry.revokeProviderSession(exact.config.providerSessionId);
      const byThread = yield* registry.issue(input);
      yield* registry.revokeThread(threadId);
      const all = yield* registry.issue(input);
      yield* registry.revokeAll;
      expect(new Set(revoked)).toEqual(
        new Set([expiring, exact, byThread, all].map((value) => value.config.providerSessionId)),
      );
      expect(reasons.slice(1).every((reason) => reason === "revoked")).toBe(true);
      let scoped = 0;
      yield* Effect.scoped(
        registry.onRevoke!(() =>
          Effect.sync(() => {
            scoped++;
          }),
        ),
      );
      yield* registry.issue(input);
      yield* registry.revokeAll;
      expect(scoped).toBe(0);
    }),
);
