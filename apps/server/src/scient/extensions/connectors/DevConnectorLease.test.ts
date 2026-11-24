// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off -- The home route over a real loopback socket.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";

import * as ServerConfig from "../../../config.ts";
import { ConnectorRuntime } from "../ExtensionsServices.ts";
import { loadDevConnectorBroker, makeLayer } from "./DevConnectorLease.ts";

const mac = (key: string, text: string) =>
  NodeCrypto.createHmac("sha256", key).update(text).digest("base64url");
const NONCE = "n".repeat(32);

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = NodeNet.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as NodeNet.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** A home on disk as `pnpm dev:identity setup` leaves it, and a dev app copied from it. */
const makeDirs = Effect.promise(async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dev-connector-lease-"));
  const homeStateDir = NodePath.join(root, "home", "scient-next-dev");
  const devAppStateDir = NodePath.join(root, "candidate", "scient-next-dev");
  await NodeFSP.mkdir(homeStateDir, { recursive: true });
  await NodeFSP.mkdir(devAppStateDir, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "home", "dev-identity-home.json"), "{}");
  await NodeFSP.writeFile(NodePath.join(devAppStateDir, "dev-identity.json"), "{}");
  await NodeFSP.writeFile(
    NodePath.join(devAppStateDir, "dev-connector-broker.json"),
    JSON.stringify({
      version: 1,
      homeStateDir,
      connectors: { con_linear: { url: "https://mcp.linear.example/mcp" } },
    }),
  );
  return { root, homeStateDir, devAppStateDir };
});

const serveHome = (stateDir: string, homeStateDir: string, port: number) =>
  Layer.build(
    HttpRouter.serve(makeLayer(homeStateDir), { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.effect(
            ServerConfig.ServerConfig,
            Effect.map(ServerConfig.ServerConfig, (config) => ({
              ...config,
              stateDir,
              port,
              host: undefined,
            })),
          ).pipe(Layer.provide(ServerConfig.layerTest(stateDir, { prefix: "dev-lease" }))),
          Layer.mock(ConnectorRuntime)({
            leaseForDevApp: (request) =>
              Effect.succeed({
                status: "ok",
                accessToken: request.staleTokenHash === undefined ? "token-1" : "token-2",
                grantId: "grant-1",
              }),
          }),
        ),
      ),
      Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port })),
      Layer.provide(NodeServices.layer),
    ),
  );

it.live("lends only to a caller holding the home's token, in a bounded request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { homeStateDir, devAppStateDir } = yield* makeDirs;
      const port = yield* Effect.promise(freePort);
      yield* serveHome(homeStateDir, homeStateDir, port);
      const leasePath = NodePath.join(homeStateDir, "dev-connector-lease.json");
      const endpoint = JSON.parse(yield* Effect.promise(() => NodeFSP.readFile(leasePath, "utf8")));
      expect(endpoint).toMatchObject({ version: 1, host: "127.0.0.1", port });
      expect((yield* Effect.promise(() => NodeFSP.stat(leasePath))).mode & 0o777).toBe(0o600);
      const post = (authorization: string | undefined, body: string) =>
        Effect.promise(() =>
          fetch(`http://127.0.0.1:${String(port)}/dev-identity/connector-lease`, {
            method: "POST",
            headers: {
              ...(authorization === undefined ? {} : { authorization }),
              "x-scient-lease-nonce": NONCE,
            },
            body,
          }),
        );
      const request = JSON.stringify({ connectorId: "con_linear", url: "https://x" });
      const signed = `Bearer ${mac(String(endpoint.token), `scient-lease-request\n${NONCE}`)}`;
      expect((yield* post(undefined, request)).status).toBe(403);
      expect((yield* post(signed.replace("Bearer", "Basic"), request)).status).toBe(403);
      // The token itself is not what a request presents.
      expect((yield* post(`Bearer ${String(endpoint.token)}`, request)).status).toBe(403);
      expect((yield* post(signed, "x".repeat(5_000))).status).toBe(400);
      const ok = yield* post(signed, request);
      expect(ok.status).toBe(200);
      const okBody = yield* Effect.promise(() => ok.text());
      expect(ok.headers.get("x-scient-lease-proof")).toBe(
        mac(String(endpoint.token), `scient-lease-response\n${NONCE}\n${okBody}`),
      );

      // A dev app asks through the same route; a refused token travels only as its hash.
      const broker = loadDevConnectorBroker(devAppStateDir)!;
      expect(broker.binds("con_linear", "https://mcp.linear.example/mcp")).toBe(true);
      expect(broker.binds("con_linear", "https://elsewhere")).toBe(false);
      expect(
        yield* broker.lease({ connectorId: "con_linear", url: "https://mcp.linear.example/mcp" }),
      ).toEqual({ status: "ok", accessToken: "token-1", grantId: "grant-1" });
      expect(
        yield* broker.lease({
          connectorId: "con_linear",
          url: "https://mcp.linear.example/mcp",
          staleTokenHash: "c".repeat(43),
        }),
      ).toEqual({ status: "ok", accessToken: "token-2", grantId: "grant-1" });
    }),
  ),
);

it.live("removes its endpoint when the home stops, and mounts nothing elsewhere", () =>
  Effect.gen(function* () {
    const { homeStateDir, devAppStateDir } = yield* makeDirs;
    const port = yield* Effect.promise(freePort);
    yield* Effect.scoped(serveHome(homeStateDir, homeStateDir, port));
    const broker = loadDevConnectorBroker(devAppStateDir)!;
    expect(
      yield* broker.lease({ connectorId: "con_linear", url: "https://mcp.linear.example/mcp" }),
    ).toEqual({ status: "home-closed" });

    // Any other app's state, even beside a home record, gets no route and no endpoint.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const otherPort = yield* Effect.promise(freePort);
        yield* serveHome(devAppStateDir, homeStateDir, otherPort);
        const answered = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${String(otherPort)}/dev-identity/connector-lease`, {
            method: "POST",
            body: "{}",
          }),
        );
        expect(answered.status).toBe(404);
        const files = yield* Effect.promise(() => NodeFSP.readdir(devAppStateDir));
        expect(files).not.toContain("dev-connector-lease.json");
      }),
    );
  }),
);

it("reads no binding in an app that never took a copy", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dev-connector-lease-"));
  await NodeFSP.writeFile(
    NodePath.join(root, "dev-connector-broker.json"),
    JSON.stringify({ version: 1, homeStateDir: root, connectors: {} }),
  );
  expect(loadDevConnectorBroker(root)).toBeUndefined();
});

it.live("trusts no answer from a listener that cannot prove it holds the home's token", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { homeStateDir, devAppStateDir } = yield* makeDirs;
      // What a stale endpoint file can lead to: another process on the old port.
      const impostor = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeHttp.Server>((resolve) => {
              // It signs its answer with all it was given: the request's own MAC.
              const server = NodeHttp.createServer((request, response) => {
                const body = JSON.stringify({
                  status: "ok",
                  accessToken: "impostor-token-123",
                  grantId: "impostor",
                });
                const presented = String(request.headers.authorization).replace("Bearer ", "");
                const nonce = String(request.headers["x-scient-lease-nonce"]);
                response.writeHead(200, {
                  "content-type": "application/json",
                  "x-scient-lease-proof": mac(
                    presented,
                    `scient-lease-response\n${nonce}\n${body}`,
                  ),
                });
                response.end(body);
              });
              server.listen(0, "127.0.0.1", () => resolve(server));
            }),
        ),
        (server) => Effect.promise(() => new Promise<void>((done) => server.close(() => done()))),
      );
      const { port } = impostor.address() as NodeNet.AddressInfo;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(homeStateDir, "dev-connector-lease.json"),
          JSON.stringify({ version: 1, host: "127.0.0.1", port, token: "stale-token" }),
        ),
      );
      const broker = loadDevConnectorBroker(devAppStateDir)!;
      expect(
        yield* broker.lease({ connectorId: "con_linear", url: "https://mcp.linear.example/mcp" }),
      ).toEqual({ status: "home-closed" });
    }),
  ),
);
