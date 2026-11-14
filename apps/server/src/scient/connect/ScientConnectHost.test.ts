import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { ScientConnectHostStatus } from "@t3tools/contracts";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as CloudLink from "../../cloud/CloudLink.ts";
import { RelayRequestError } from "../../cloud/relayResponse.ts";
import * as ServerConfig from "../../config.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import { make, SCIENT_CONNECT_OFF_SECRET } from "./ScientConnectHost.ts";

/** A fake computer: tokens are `token-<account>`, and links wait on `gate` when one is set. */
function makeComputer() {
  const secrets = new Map<string, Uint8Array>();
  const computer = {
    linkedAccount: null as string | null,
    links: [] as Array<string>,
    gate: null as Deferred.Deferred<void> | null,
    fail: [] as Array<RelayRequestError>,
  };
  const store: ServerSecretStore.ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(ServerSecretStore.ServerSecretStore, store),
    Layer.effect(
      ServerConfig.ServerConfig,
      ServerConfig.ServerConfig.pipe(
        Effect.map((config) => ServerConfig.ServerConfig.of({ ...config, mode: "desktop" })),
      ),
    ).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "scient-connect-host-" })),
      Layer.provide(NodeServices.layer),
    ),
    ManagedPolicy.layerTest(),
    Layer.mock(HttpServer.HttpServer)({
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
    }),
    Layer.mock(RelayClient.RelayClient)({
      resolve: Effect.succeed({
        status: "available",
        executablePath: "/tools/cloudflared",
        source: "managed",
        version: RelayClient.CLOUDFLARED_VERSION,
      }),
    }),
    Layer.mock(CloudLink.CloudLink)({
      linkState: () =>
        Effect.sync(() => ({
          linked: computer.linkedAccount !== null,
          cloudUserId: computer.linkedAccount,
          relayUrl: null,
          relayIssuer: null,
          managedTunnelActive: computer.linkedAccount !== null,
          publishAgentActivity: false,
        })),
      unlink: () =>
        Effect.sync(() => {
          computer.linkedAccount = null;
          return { ok: true, endpointRuntimeStatus: { status: "disabled" } } as const;
        }),
      linkWithAccessToken: ({ accessToken, stillWanted }) =>
        Effect.gen(function* () {
          computer.links.push(accessToken);
          if (computer.gate !== null) yield* Deferred.await(computer.gate);
          const failure = computer.fail.shift();
          if (failure !== undefined) return yield* failure;
          if (!(yield* stillWanted)) return "abandoned" as const;
          computer.linkedAccount = accessToken.replace("token-", "");
          return "linked" as const;
        }),
    }),
  );
  return { computer, secrets, layer };
}

const untilStatus =
  (predicate: (status: ScientConnectHostStatus) => boolean) =>
  (status: Stream.Stream<ScientConnectHostStatus>) =>
    status.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));

const lend = (accountId: string, turnOn = false) => ({
  accountId,
  token: `token-${accountId}`,
  turnOn,
});

describe("ScientConnectHost", () => {
  it.effect("links once a window lends a sign-in, then leaves a connected computer alone", () => {
    const { computer, layer } = makeComputer();
    return Effect.gen(function* () {
      const host = yield* make({ cloudConfigured: true });
      yield* untilStatus((status) => status.phase === "needs-authorization")(host.status);
      const status = yield* host.authorize(lend("A"));
      expect(status).toMatchObject({ phase: "connected", linkedAccountId: "A" });
      yield* host.authorize(lend("A"));
      expect(computer.links).toEqual(["token-A"]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("Off holds: a link in progress never applies, and only Turn on links again", () => {
    const { computer, secrets, layer } = makeComputer();
    return Effect.gen(function* () {
      const host = yield* make({ cloudConfigured: true });
      yield* untilStatus((status) => status.phase === "needs-authorization")(host.status);
      computer.gate = yield* Deferred.make<void>();
      const pending = yield* Effect.forkChild(host.authorize(lend("A")));
      yield* untilStatus((status) => status.phase === "linking")(host.status);
      const off = yield* host.turnOff;
      yield* Deferred.succeed(computer.gate, undefined);
      yield* Fiber.await(pending);
      expect(off).toMatchObject({ off: true, phase: "idle" });
      expect(computer.linkedAccount).toBeNull();
      expect(secrets.has(SCIENT_CONNECT_OFF_SECRET)).toBe(true);

      computer.gate = null;
      yield* host.authorize(lend("A"));
      expect(computer.linkedAccount).toBeNull();
      const on = yield* host.authorize(lend("A", true));
      expect(on).toMatchObject({ off: false, phase: "connected", linkedAccountId: "A" });
      expect(secrets.has(SCIENT_CONNECT_OFF_SECRET)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("moves the computer to the account that signs in, even mid-setup", () => {
    const { computer, layer } = makeComputer();
    return Effect.gen(function* () {
      const host = yield* make({ cloudConfigured: true });
      yield* untilStatus((status) => status.phase === "needs-authorization")(host.status);
      computer.gate = yield* Deferred.make<void>();
      const first = yield* Effect.forkChild(host.authorize(lend("A")));
      yield* untilStatus((status) => status.phase === "linking")(host.status);
      computer.gate = null;
      const moved = yield* host.authorize(lend("B"));
      yield* Fiber.await(first);
      expect(moved).toMatchObject({ phase: "connected", linkedAccountId: "B" });
      expect(computer.linkedAccount).toBe("B");

      const back = yield* host.authorize(lend("A"));
      expect(back).toMatchObject({ phase: "connected", linkedAccountId: "A" });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("waits for the person at the account's computer limit", () => {
    const { computer, layer } = makeComputer();
    return Effect.gen(function* () {
      const host = yield* make({ cloudConfigured: true });
      yield* untilStatus((status) => status.phase === "needs-authorization")(host.status);
      computer.fail.push(
        new RelayRequestError({ rejection: "forbidden", description: "limit", linkLimit: 3 }),
      );
      const blocked = yield* host.authorize(lend("A"));
      expect(blocked).toMatchObject({
        phase: "blocked",
        block: { reason: "limit", maxTunnels: 3 },
      });
      yield* host.authorize(lend("A"));
      expect(computer.links).toHaveLength(1);
      const retried = yield* host.authorize(lend("A", true));
      expect(retried).toMatchObject({ phase: "connected", linkedAccountId: "A" });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("retries a busy relay later with a fresh sign-in", () => {
    const { computer, layer } = makeComputer();
    return Effect.gen(function* () {
      const host = yield* make({ cloudConfigured: true });
      const first = yield* untilStatus((status) => status.phase === "needs-authorization")(
        host.status,
      );
      computer.fail.push(new RelayRequestError({ rejection: "unavailable", description: "busy" }));
      const attempt = yield* Effect.forkChild(host.authorize(lend("A")));
      yield* untilStatus((status) => status.phase === "waiting-to-retry")(host.status);
      yield* TestClock.adjust("10 seconds");
      const asked = yield* untilStatus(
        (status) =>
          status.phase === "needs-authorization" &&
          status.authorizationRequest > first.authorizationRequest,
      )(host.status);
      expect(asked.phase).toBe("needs-authorization");
      yield* host.authorize(lend("A"));
      yield* Fiber.join(attempt);
      expect(computer.linkedAccount).toBe("A");
      expect(computer.links).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("leaves servers that are not the desktop app's own alone", () => {
    const { computer, layer } = makeComputer();
    return Effect.gen(function* () {
      const host = yield* make({ cloudConfigured: false });
      const status = yield* host.authorize(lend("A", true));
      expect(status.managed).toBe(false);
      expect(computer.links).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});
