import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const allCapabilities = new Set(["preview", "sources:read", "sources:write"] as const);
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: allCapabilities,
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);
    expect(issued.config.capabilities).toEqual(allCapabilities);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);
    expect(resolved?.capabilities).toEqual(new Set(["preview", "sources:read", "sources:write"]));

    // Provider awareness receives a separate snapshot; mutating it cannot
    // widen or narrow the authorization attached to the bearer token.
    (issued.config.capabilities as Set<string>).clear();
    expect((yield* registry.resolve(token))?.capabilities).toEqual(
      new Set(["preview", "sources:read", "sources:write"]),
    );

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("binds exactly the requested capabilities without ambient defaults", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const requested = new Set(["sources:read"] as const);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-narrow-capabilities"),
      providerInstanceId: ProviderInstanceId.make("opencode"),
      capabilities: requested,
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    requested.clear();
    expect(issued.config.capabilities).toEqual(new Set(["sources:read"]));
    expect((yield* registry.resolve(token))?.capabilities).toEqual(new Set(["sources:read"]));
  }),
);

it.effect("snapshots and returns an isolated exact skill scope", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const requestedReleaseKeys = new Set(["scient.review@0.1.0#sha256:one"]);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-skill-scope"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["skills:read"]),
      skillScope: {
        releaseKeys: requestedReleaseKeys,
        skills: [
          {
            releaseKey: "scient.review@0.1.0#sha256:one",
            id: "scient.review",
            name: "review",
            description: "Review this workspace.",
            invocationPolicy: "automatic",
          },
        ],
      },
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    requestedReleaseKeys.clear();
    const first = yield* registry.resolve(token);
    expect(first?.skillScope).toEqual({
      releaseKeys: new Set(["scient.review@0.1.0#sha256:one"]),
      skills: [
        {
          releaseKey: "scient.review@0.1.0#sha256:one",
          id: "scient.review",
          name: "review",
          description: "Review this workspace.",
          invocationPolicy: "automatic",
        },
      ],
    });
    if (!first?.skillScope) throw new Error("Expected the issued skill scope to resolve.");

    (first.skillScope.releaseKeys as Set<string>).clear();
    expect((yield* registry.resolve(token))?.skillScope?.releaseKeys).toEqual(
      new Set(["scient.review@0.1.0#sha256:one"]),
    );
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: allCapabilities,
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: allCapabilities,
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: allCapabilities,
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Well past the liveness window in total, but each turn reports in before
    // it lapses — this is the long-session case that used to lose the toolkit.
    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: allCapabilities,
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);
