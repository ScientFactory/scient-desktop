import * as NodeNet from "node:net";

import { it as effectIt } from "@effect/vitest";
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  type DiscoveredLocalServer,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { FetchHttpClient } from "effect/unstable/http";

import * as OwnedLocalEndpoints from "../localEndpoints/OwnedLocalEndpointRegistry.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";
const processProbeFailure: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
  Effect.fail(
    new ProcessRunner.ProcessSpawnError({
      command: input.command,
      argumentCount: input.args.length,
      cwd: input.cwd,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "PowerShell is not installed in the test environment",
      }),
    }),
  );

const TestProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: processProbeFailure,
});
const TestOwnedLocalEndpointsLive = OwnedLocalEndpoints.layer;

const makeProbeFailureLayer = (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  fetch: typeof globalThis.fetch = globalThis.fetch,
) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(HostProcessPlatform, "linux"),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        TestOwnedLocalEndpointsLive,
      ),
    ),
  );

const TestPortDiscoveryLive = PortScanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      TestProcessRunner,
      Layer.succeed(HostProcessPlatform, "win32"),
      FetchHttpClient.layer,
      TestOwnedLocalEndpointsLive,
    ),
  ),
);

const LSOF_TEST_PORT = 43_123;

effectIt.effect("unknown listeners and terminal ownership never authorize protocol probes", () => {
  const requests: string[] = [];
  const layer = makeLsofScannerLayer({
    pid: () => 1234,
    listeners: () => [
      { pid: 1234, port: LSOF_TEST_PORT },
      { pid: 5678, port: 8888 },
    ],
    fetch: ((url: Parameters<typeof globalThis.fetch>[0]) => {
      requests.push(String(url));
      return Promise.resolve(new Response("ok", { headers: { "content-type": "text/html" } }));
    }) as typeof globalThis.fetch,
  });
  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({
      threadId: "test",
      terminalId: "term",
      processIds: [1234],
    });
    for (let i = 0; i < 20; i += 1) expect(yield* scanner.scan()).toEqual([]);
    expect(requests).toEqual([]);
    const explicit = `http://localhost:${LSOF_TEST_PORT}/app`;
    const servers = yield* scanner.scan([explicit]);
    expect(servers[0]?.terminal?.terminalId).toBe("term");
    expect(requests).toEqual([explicit]);
    yield* scanner.unregisterTerminal({ threadId: "test", terminalId: "term" });
    expect(yield* scanner.scan()).toEqual([]);
    expect(requests).toEqual([explicit]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect(
  "forgetting a URL discards cached readiness instead of granting future discovery",
  () => {
    const requests: string[] = [];
    const url = `http://localhost:${LSOF_TEST_PORT}/`;
    const layer = makeLsofScannerLayer({
      pid: () => 1234,
      fetch: ((input: Parameters<typeof globalThis.fetch>[0]) => {
        requests.push(String(input));
        return Promise.resolve(new Response("ok", { headers: { "content-type": "text/html" } }));
      }) as typeof globalThis.fetch,
    });
    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      expect(yield* scanner.scan([url])).toHaveLength(1);
      expect(yield* scanner.scan()).toEqual([]);
      expect(requests).toEqual([url]);
      expect(yield* scanner.scan([url])).toHaveLength(1);
      expect(requests).toEqual([url, url]);
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect("revalidates explicit targets when the listener process changes", () => {
  let pid = 1234;
  const requests: string[] = [];
  const url = `http://localhost:${LSOF_TEST_PORT}/`;
  const layer = makeLsofScannerLayer({
    pid: () => pid,
    fetch: ((input: Parameters<typeof globalThis.fetch>[0]) => {
      requests.push(String(input));
      return Promise.resolve(new Response("ok", { headers: { "content-type": "text/html" } }));
    }) as typeof globalThis.fetch,
  });
  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.scan([url]);
    pid += 1;
    yield* scanner.scan([url]);
    expect(requests).toEqual([url, url]);
  }).pipe(Effect.provide(layer));
});

const makeLsofScannerLayer = (input: {
  readonly pid: () => number;
  readonly port?: () => number;
  readonly listeners?: () => ReadonlyArray<{ readonly pid: number; readonly port: number }>;
  readonly fetch: typeof globalThis.fetch;
  readonly ownedLocalEndpointsLayer?: Layer.Layer<OwnedLocalEndpoints.OwnedLocalEndpointRegistry>;
}) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: (
                input.listeners?.() ?? [
                  { pid: input.pid(), port: input.port?.() ?? LSOF_TEST_PORT },
                ]
              )
                .map(({ pid, port }) => `p${pid}\ncnode\nn*:${port}\n`)
                .join(""),
              stderr: "",
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, input.fetch)),
        ),
        input.ownedLocalEndpointsLayer ?? TestOwnedLocalEndpointsLive,
      ),
    ),
  );

const openServer = (
  port: number,
  onConnection: (socket: NodeNet.Socket) => void,
): Effect.Effect<NodeNet.Server | null> =>
  Effect.callback((resume) => {
    const server = NodeNet.createServer(onConnection);
    server.once("error", () => {
      resume(Effect.succeed(null));
    });
    server.listen(port, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => {
      server.close();
    });
  });

const closeServer = (server: NodeNet.Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void));
  });

const commonDevServer = Effect.acquireRelease(
  openServer(0, (socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello");
    });
  }).pipe(
    Effect.map((server) => {
      if (server === null) throw new Error("Could not bind fixture");
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No fixture port");
      return { server, port: address.port };
    }),
  ),
  ({ server }) => closeServer(server),
);

effectIt.layer(TestPortDiscoveryLive)("Explicit Preview URLs without listener metadata", (it) => {
  it.effect("checks an explicitly configured real web server", () =>
    Effect.gen(function* () {
      const { port } = yield* commonDevServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan([`http://127.0.0.1:${port}/`]);
      expect(result[0]?.port).toBe(port);
    }),
  );
  it.effect("retain broadcasts configured URLs only", () =>
    Effect.gen(function* () {
      const { port } = yield* commonDevServer;
      const received: number[] = [];
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.subscribe(
        { configuredUrls: [`http://127.0.0.1:${port}/`], initialSnapshot: [] },
        (servers) =>
          Effect.sync(() => {
            for (const server of servers) received.push(server.port);
          }),
      );
      yield* scanner.retain;
      expect(received).toEqual([port]);
    }),
  );
});

effectIt.effect("revalidates a successful HTML probe after its cache entry expires", () => {
  let responds = true;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return responds
      ? Promise.resolve(new Response("hello", { headers: { "content-type": "text/html" } }))
      : Promise.reject(new TypeError("not HTTP"));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(1);
    expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(1);
    expect(requests).toEqual([`http://localhost:${LSOF_TEST_PORT}/`]);

    responds = false;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(0);
    expect(requests).toEqual([
      `http://localhost:${LSOF_TEST_PORT}/`,
      `http://localhost:${LSOF_TEST_PORT}/`,
    ]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("never sends HTTP bytes to a protected internal endpoint", () => {
  const requests: string[] = [];
  let protectedPort = 0;
  const ownedLocalEndpointsLayer = OwnedLocalEndpoints.layer;
  const scannerLayer = makeLsofScannerLayer({
    pid: () => 7_777,
    port: () => protectedPort,
    fetch: ((input: Parameters<typeof globalThis.fetch>[0]) => {
      requests.push(String(input));
      return Promise.resolve(new Response("hello", { headers: { "content-type": "text/html" } }));
    }) as typeof globalThis.fetch,
    ownedLocalEndpointsLayer,
  });
  const layer = Layer.merge(scannerLayer, ownedLocalEndpointsLayer);

  return Effect.gen(function* () {
    const registry = yield* OwnedLocalEndpoints.OwnedLocalEndpointRegistry;
    const lease = yield* registry.reserveProtectedLoopbackTcpPorts({
      owner: "compute-test",
      purpose: "private-protocol",
      count: 1,
    });
    protectedPort = lease.ports[0] ?? 0;
    yield* lease.handoff;

    const scanner = yield* PortScanner.PortDiscovery;
    expect(
      yield* scanner.scan([
        `http://localhost:${protectedPort}/`,
        `https://127.0.0.1:${protectedPort}/`,
      ]),
    ).toEqual([]);
    expect(requests).toEqual([]);

    yield* lease.release;
    expect(yield* scanner.scan([`http://localhost:${protectedPort}/`])).toHaveLength(1);
    expect(requests).toEqual([`http://localhost:${protectedPort}/`]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("still discovers a normal web port owned by the same process", () => {
  const requests: string[] = [];
  let protectedPort = 0;
  const ownedLocalEndpointsLayer = OwnedLocalEndpoints.layer;
  const scannerLayer = makeLsofScannerLayer({
    pid: () => 7_778,
    listeners: () => [
      { pid: 7_778, port: protectedPort },
      { pid: 7_778, port: LSOF_TEST_PORT },
    ],
    fetch: ((input: Parameters<typeof globalThis.fetch>[0]) => {
      requests.push(String(input));
      return Promise.resolve(new Response("hello", { headers: { "content-type": "text/html" } }));
    }) as typeof globalThis.fetch,
    ownedLocalEndpointsLayer,
  });
  const layer = Layer.merge(scannerLayer, ownedLocalEndpointsLayer);

  return Effect.gen(function* () {
    const registry = yield* OwnedLocalEndpoints.OwnedLocalEndpointRegistry;
    const lease = yield* registry.reserveProtectedLoopbackTcpPorts({
      owner: "compute-test",
      purpose: "private-protocol",
      count: 1,
    });
    protectedPort = lease.ports[0] ?? 0;
    yield* lease.handoff;

    const scanner = yield* PortScanner.PortDiscovery;
    expect(
      (yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).map(({ port }) => port),
    ).toEqual([LSOF_TEST_PORT]);
    expect(requests).toEqual([`http://localhost:${LSOF_TEST_PORT}/`]);
    yield* lease.release;
  }).pipe(Effect.provide(layer));
});

effectIt.effect("invalidates cached classifications when endpoint ownership changes", () => {
  const requests: string[] = [];
  const ownedLocalEndpointsLayer = OwnedLocalEndpoints.layer;
  const scannerLayer = makeLsofScannerLayer({
    pid: () => 8_888,
    fetch: ((input: Parameters<typeof globalThis.fetch>[0]) => {
      requests.push(String(input));
      return Promise.resolve(new Response("hello", { headers: { "content-type": "text/html" } }));
    }) as typeof globalThis.fetch,
    ownedLocalEndpointsLayer,
  });
  const layer = Layer.merge(scannerLayer, ownedLocalEndpointsLayer);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const registry = yield* OwnedLocalEndpoints.OwnedLocalEndpointRegistry;
    expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(1);
    expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(1);
    expect(requests).toHaveLength(1);

    const lease = yield* registry.reserveProtectedLoopbackTcpPorts({
      owner: "another-service",
      purpose: "private-protocol",
      count: 1,
    });
    expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(1);
    expect(requests).toHaveLength(2);
    yield* lease.release;
  }).pipe(Effect.provide(layer));
});

effectIt.effect("keeps a full configured URL when the discovered server root fails", () => {
  const requests: string[] = [];
  const configuredUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    return Promise.resolve(
      url === configuredUrl
        ? new Response("docs", { headers: { "content-type": "text/html" } })
        : new Response("not found", {
            status: 404,
            headers: { "content-type": "text/html" },
          }),
    );
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([configuredUrl]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.url).toBe(configuredUrl);
    expect(requests).toContain(configuredUrl);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("probes configured custom ports through a canonical loopback host", () => {
  const customPort = 43_124;
  const configuredUrl = `http://0.0.0.0:${customPort}/docs`;
  const expectedUrl = `http://localhost:${customPort}/docs`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeProbeFailureLayer(processProbeFailure, fetchFn);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([configuredUrl]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.host).toBe("localhost");
    expect(servers[0]?.port).toBe(customPort);
    expect(servers[0]?.url).toBe(expectedUrl);
    expect(requests).toEqual([expectedUrl]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("preserves explicit loopback hosts and bounds wildcard rewrites", () => {
  const ipv4Url = "https://127.0.0.1:43125/docs";
  const ipv6Url = "http://[::1]:43126/docs";
  const wildcardPrefix = "http://0.0.0.0/";
  const maximumWildcardUrl = `${wildcardPrefix}${"a".repeat(
    PREVIEW_URL_MAX_LENGTH - wildcardPrefix.length,
  )}`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeProbeFailureLayer(processProbeFailure, fetchFn);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([ipv4Url, ipv6Url, maximumWildcardUrl]);
    expect(servers.map((server) => server.url)).toEqual([ipv4Url, ipv6Url]);
    expect(requests).toEqual([ipv4Url, ipv6Url]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("projects configured paths independently for simultaneous subscribers", () => {
  const docsUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const adminUrl = `http://localhost:${LSOF_TEST_PORT}/admin`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    return Promise.resolve(
      url === docsUrl || url === adminUrl
        ? new Response("app", { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 }),
    );
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const docsSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
    const adminSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
    yield* scanner.subscribe({ configuredUrls: [docsUrl], initialSnapshot: [] }, (servers) =>
      Effect.sync(() => docsSnapshots.push(servers)),
    );
    yield* scanner.subscribe({ configuredUrls: [adminUrl], initialSnapshot: [] }, (servers) =>
      Effect.sync(() => adminSnapshots.push(servers)),
    );
    yield* scanner.retain;

    expect(docsSnapshots.at(-1)?.[0]?.url).toBe(docsUrl);
    expect(adminSnapshots.at(-1)?.[0]?.url).toBe(adminUrl);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

effectIt.effect(
  "keeps each subscriber's candidates when their combined union exceeds the per-client cap",
  () => {
    const firstSubscriberUrls = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS },
      (_, index) => `http://localhost:${LSOF_TEST_PORT}/app-${index}`,
    );
    const secondSubscriberUrl = `http://localhost:${LSOF_TEST_PORT}/app-${CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS}`;
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) =>
      Promise.resolve(
        String(input) === secondSubscriberUrl
          ? new Response("app", { headers: { "content-type": "text/html" } })
          : new Response("not found", { status: 404 }),
      )) as typeof globalThis.fetch;
    const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      const secondSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
      yield* scanner.subscribe(
        { configuredUrls: firstSubscriberUrls, initialSnapshot: [] },
        () => Effect.void,
      );
      yield* scanner.subscribe(
        { configuredUrls: [secondSubscriberUrl], initialSnapshot: [] },
        (servers) => Effect.sync(() => secondSnapshots.push(servers)),
      );
      yield* scanner.retain;

      expect(secondSnapshots.at(-1)?.[0]?.url).toBe(secondSubscriberUrl);
    }).pipe(Effect.scoped, Effect.provide(layer));
  },
);

effectIt.effect("stops probing a subscriber's configured paths after its scope closes", () => {
  const docsUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const adminUrl = `http://localhost:${LSOF_TEST_PORT}/admin`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    return Promise.resolve(
      url === docsUrl || url === adminUrl
        ? new Response("app", { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 }),
    );
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const docsScope = yield* Scope.make();
    yield* scanner
      .subscribe({ configuredUrls: [docsUrl], initialSnapshot: [] }, () => Effect.void)
      .pipe(Effect.provideService(Scope.Scope, docsScope));
    yield* scanner.subscribe(
      { configuredUrls: [adminUrl], initialSnapshot: [] },
      () => Effect.void,
    );
    yield* scanner.retain;
    yield* Scope.close(docsScope, Exit.void);

    requests.length = 0;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(requests).toContain(adminUrl);
    expect(requests).not.toContain(docsUrl);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

effectIt.effect("uses the current configured fragment when readiness comes from cache", () => {
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });
  const oldUrl = `http://localhost:${LSOF_TEST_PORT}/docs#old`;
  const newUrl = `http://localhost:${LSOF_TEST_PORT}/docs#new`;

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect((yield* scanner.scan([oldUrl]))[0]?.url).toBe(oldUrl);
    const requestCount = requests.length;
    expect((yield* scanner.scan([newUrl]))[0]?.url).toBe(newUrl);
    expect(requests).toHaveLength(requestCount);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("deduplicates an explicit URL without adding discovered-root probes", () => {
  const requests: string[] = [];
  const rootUrl = `http://localhost:${LSOF_TEST_PORT}/`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan([rootUrl, rootUrl])).toHaveLength(1);
    expect(requests).toEqual([rootUrl]);

    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan([rootUrl])).toHaveLength(1);
    expect(requests).toEqual([rootUrl, rootUrl]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("starts fresh cache entries after the probing batch completes", () =>
  Effect.gen(function* () {
    const baseClock = yield* Clock.Clock;
    const times = [0, 20_000, 20_000, 20_000];
    let timeIndex = 0;
    const currentTimeMillis = () => times[Math.min(timeIndex++, times.length - 1)]!;
    const clock: Clock.Clock = {
      ...baseClock,
      currentTimeMillisUnsafe: currentTimeMillis,
      currentTimeMillis: Effect.sync(currentTimeMillis),
    };
    const requests: string[] = [];
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      requests.push(String(input));
      return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
    }) as typeof globalThis.fetch;
    const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(1);
      expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(1);
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, clock));
  }),
);

effectIt.effect("caches a failed web probe until its bounded cache entry expires", () => {
  let responds = false;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return responds
      ? Promise.resolve(new Response("hello", { headers: { "content-type": "text/html" } }))
      : Promise.reject(new TypeError("not HTTP"));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(0);
    expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(0);
    expect(requests).toHaveLength(1);

    responds = true;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(1);
    expect(requests).toHaveLength(2);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("uses only explicit HTTPS and does not follow redirects while probing", () => {
  const redirects: Array<string | undefined> = [];
  const fetchFn = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    redirects.push(init?.redirect);
    if (String(input).startsWith("http:")) throw new TypeError("TLS listener");
    return new Response(null, { status: 302, headers: { location: "https://example.com" } });
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([`https://localhost:${LSOF_TEST_PORT}/`]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.url).toBe(`https://localhost:${LSOF_TEST_PORT}/`);
    expect(redirects).toEqual(["manual"]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect(
  "excludes HTTP errors, non-navigation responses, and successful non-documents",
  () => {
    let pid = 1;
    let makeResponse = () =>
      new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    const fetchFn = ((_input: Parameters<typeof globalThis.fetch>[0]) =>
      Promise.resolve(makeResponse())) as typeof globalThis.fetch;
    const layer = makeLsofScannerLayer({ pid: () => pid, fetch: fetchFn });

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("ready", { status: 200, headers: { "content-type": "text/plain" } });
      expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(0);

      pid += 1;
      makeResponse = () => new Response(null, { status: 304, headers: { location: "/cached" } });
      expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response(null, { status: 204, headers: { "content-type": "text/html" } });
      expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(0);

      pid += 1;
      makeResponse = () => new Response(null, { status: 302 });
      expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("<html />", {
          status: 200,
          headers: { "content-type": "application/xhtml+xml; charset=utf-8" },
        });
      expect(yield* scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`])).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect("aborts the declared-protocol probe when it times out", () => {
  const aborted: string[] = [];
  const fetchFn = ((
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => {
        aborted.push(String(input));
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    })) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const scanFiber = yield* Effect.forkChild(
      scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`]),
    );
    yield* TestClock.adjust(Duration.seconds(2));
    expect(yield* Fiber.join(scanFiber)).toHaveLength(0);
    expect(aborted).toEqual([`http://localhost:${LSOF_TEST_PORT}/`]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("does not swallow process probe defects", () =>
  Effect.gen(function* () {
    const defect = new Error("unexpected process probe defect");
    const layer = makeProbeFailureLayer(() => Effect.die(defect));

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) =>
      scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`]),
    ).pipe(Effect.provide(layer), Effect.exit);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
    }
  }),
);

effectIt.effect("does not swallow process probe interruption", () =>
  Effect.gen(function* () {
    const layer = makeProbeFailureLayer(() => Effect.interrupt);

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) =>
      scanner.scan([`http://localhost:${LSOF_TEST_PORT}/`]),
    ).pipe(Effect.provide(layer), Effect.exit);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  }),
);
