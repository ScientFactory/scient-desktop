import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  keepAwakeThreadKey,
  type KeepAwakeDocument,
} from "@t3tools/contracts";
import {
  BearerConnectionTarget,
  BearerConnectionProfile,
  BearerConnectionCredential,
  RelayConnectionTarget,
  SshConnectionTarget,
  SshConnectionProfile,
} from "@t3tools/client-runtime/connection";
import {
  type ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
} from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { DesktopBackendPool } from "../../backend/DesktopBackendPool.ts";
import { DesktopConnectionCatalogStore } from "../../app/DesktopConnectionCatalogStore.ts";
import { KeepAwakeRemote, KeepAwakeRemoteError } from "./remote.ts";
import * as Source from "./source.ts";

vi.mock("electron", () => ({}));
const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("thread");
const batch = { environmentId, groups: [] };
const document: KeepAwakeDocument = {
  settings: { mode: "system" },
  threads: [
    {
      key: keepAwakeThreadKey(environmentId, threadId),
      title: "Thread",
      once: true,
      startedAt: null,
    },
  ],
};
const bearerCatalog = (
  origin = "https://first.test",
  token = "first-token",
): ConnectionCatalogDocument => ({
  ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
  targets: [new BearerConnectionTarget({ environmentId, label: "Remote", connectionId: "route" })],
  profiles: [
    new BearerConnectionProfile({
      environmentId,
      label: "Remote",
      connectionId: "route",
      httpBaseUrl: origin,
      wsBaseUrl: origin.replace("https:", "wss:"),
    }),
  ],
  credentials: [{ connectionId: "route", credential: new BearerConnectionCredential({ token }) }],
});
const setup = Effect.fn("KeepAwakeSourceTest.setup")(function* (
  initial = bearerCatalog(),
  descriptorId = environmentId,
  gatewayFails = false,
) {
  const catalog = yield* Ref.make(initial);
  const requests: { url: string; authorization: string | undefined }[] = [];
  const gatewayCalls: string[] = [];
  const source = yield* Source.KeepAwakeSource.pipe(
    Effect.provide(
      Source.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(DesktopBackendPool)({ list: Effect.succeed([]) }),
            Layer.mock(DesktopConnectionCatalogStore)({
              get: Ref.get(catalog).pipe(Effect.map((value) => Option.some(JSON.stringify(value)))),
            }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.sync(() => {
                  requests.push({ url: request.url, authorization: request.headers.authorization });
                  const value =
                    request.method === "GET"
                      ? {
                          environmentId: descriptorId,
                          label: "Remote",
                          platform: "linux",
                          serverVersion: "1",
                          capabilities: {},
                        }
                      : batch;
                  return HttpClientResponse.fromWeb(request, Response.json(value));
                }),
              ),
            ),
            Layer.succeed(KeepAwakeRemote, {
              observe: (id, ids) =>
                Effect.suspend(() => {
                  gatewayCalls.push(id);
                  assert.deepEqual(ids, [threadId]);
                  return gatewayFails
                    ? Effect.fail(new KeepAwakeRemoteError({ cause: "Window closed" }))
                    : Effect.succeed(batch);
                }),
            }),
          ),
        ),
      ),
    ),
  );
  return { source, catalog, requests, gatewayCalls };
});

it.effect(
  "reads a fresh catalog and uses changed endpoints and credentials on the next observation",
  () =>
    Effect.gen(function* () {
      const { source, catalog, requests } = yield* setup();
      assert.isUndefined((yield* source.observe(document))[0]!.error);
      yield* Ref.set(catalog, bearerCatalog("https://changed.test", "changed-token"));
      assert.isUndefined((yield* source.observe(document))[0]!.error);
      assert.deepEqual(
        requests.filter((request) => request.authorization !== undefined),
        [
          {
            url: "https://first.test/api/scient/keep-awake/observe",
            authorization: "Bearer first-token",
          },
          {
            url: "https://changed.test/api/scient/keep-awake/observe",
            authorization: "Bearer changed-token",
          },
        ],
      );
    }),
);

it.effect("does not send credentials when the endpoint belongs to another environment", () =>
  Effect.gen(function* () {
    const { source, requests } = yield* setup(bearerCatalog(), EnvironmentId.make("other"));
    assert.isDefined((yield* source.observe(document))[0]!.error);
    assert.equal(requests.length, 1);
    assert.isUndefined(requests[0]!.authorization);
  }),
);

it.effect.each(["ssh", "relay", "dpop"] as const)(
  "uses the current authenticated connection runtime for %s",
  (kind) =>
    Effect.gen(function* () {
      const initial = bearerCatalog();
      const catalog: ConnectionCatalogDocument =
        kind === "relay"
          ? { ...initial, targets: [new RelayConnectionTarget({ environmentId, label: "Remote" })] }
          : kind === "ssh"
            ? {
                ...initial,
                targets: [
                  new SshConnectionTarget({
                    environmentId,
                    label: "Remote",
                    connectionId: "route",
                  }),
                ],
                profiles: [
                  new SshConnectionProfile({
                    environmentId,
                    label: "Remote",
                    connectionId: "route",
                    target: { alias: "host", hostname: "host", username: null, port: null },
                  }),
                ],
              }
            : {
                ...initial,
                profiles: [
                  new BearerConnectionProfile({
                    environmentId,
                    label: "Remote",
                    connectionId: "route",
                    httpBaseUrl: "https://first.test",
                    wsBaseUrl: "wss://first.test",
                    authorization: "t3-connect",
                  }),
                ],
              };
      const { source, requests, gatewayCalls } = yield* setup(catalog);
      assert.isUndefined((yield* source.observe(document))[0]!.error);
      assert.deepEqual(gatewayCalls, [environmentId]);
      assert.isEmpty(requests);
    }),
);

it.effect("reports an unavailable remote runtime without using legacy credentials", () =>
  Effect.gen(function* () {
    const { source } = yield* setup(
      {
        ...bearerCatalog(),
        targets: [new RelayConnectionTarget({ environmentId, label: "Remote" })],
      },
      environmentId,
      true,
    );
    assert.isDefined((yield* source.observe(document))[0]!.error);
  }),
);

it.effect("does not poll disabled connections", () =>
  Effect.gen(function* () {
    const { source, requests, gatewayCalls } = yield* setup({
      ...bearerCatalog(),
      disabledEnvironmentIds: [environmentId],
    });
    assert.isDefined((yield* source.observe(document))[0]!.error);
    assert.isEmpty(requests);
    assert.isEmpty(gatewayCalls);
  }),
);
