import {
  IsoDateTime,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  ThreadMcpStatusSnapshot,
  type ThreadMcpServerObservation,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ThreadMcpStatusRegistry from "./ThreadMcpStatusRegistry.ts";

const decodeSnapshot = Schema.decodeSync(ThreadMcpStatusSnapshot);
const threadId = ThreadId.make("thread-mcp-status-1");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerThreadId = ProviderThreadId.make("pt-1");
const attachInput = (session: string) => ({
  threadId,
  providerInstanceId,
  providerThreadId,
  providerSessionId: ProviderSessionId.make(session),
});
const statuses = (servers: ReadonlyArray<ThreadMcpServerObservation>) =>
  servers.map((server) => [server.name, server.status, server.sessionActive]);

describe("ThreadMcpStatusRegistry", () => {
  it("redacts connector messages and never repeats a provider's error text", () => {
    expect(
      ThreadMcpStatusRegistry.sanitizeMcpStatusDetail(
        "monday.com is no longer connected at https://mcp.monday.com/sse with Bearer abc.def-123",
      ),
    ).toBe("monday.com is no longer connected at [url] with Bearer [redacted]");
    const leaky =
      "MCP client for `db` failed to start: spawn psql --password=hunter2-secret ENOENT; cookie sid=s3cr3t";
    const reason = ThreadMcpStatusRegistry.nativeMcpFailureReason(leaky);
    expect(reason).toBe("Its program could not be started.");
    expect(reason).not.toContain("hunter2");
    expect(ThreadMcpStatusRegistry.nativeMcpFailureReason("x-api-key sk-live-0123456789")).toBe(
      "It failed to start.",
    );
  });

  it.effect("reports only for the current, open attachment and keeps the last state", () =>
    Effect.gen(function* () {
      const registry = yield* ThreadMcpStatusRegistry.ThreadMcpStatusRegistry;
      const first = yield* registry.attach(attachInput("session-1"));
      yield* registry.upsertNative(first, {
        name: "linear",
        source: "native",
        status: "needs-sign-in",
        action: "sign-in",
      });
      const second = yield* registry.attach(attachInput("session-2"));
      // The replaced attachment reports late, for the first time and again: both are ignored.
      yield* registry.upsertNative(first, { name: "github", source: "native", status: "ready" });
      yield* registry.detach(first);
      let snapshot = yield* registry.snapshot(threadId);
      // Kept as last known, but no action targets it until the new session reports it.
      expect(statuses(snapshot.servers)).toEqual([["linear", "needs-sign-in", false]]);

      yield* registry.upsertNative(second, { name: "linear", source: "native", status: "ready" });
      yield* registry.detach(second);
      // Nothing reopens an ended attachment.
      yield* registry.upsertNative(second, {
        name: "linear",
        source: "native",
        status: "unreachable",
      });
      snapshot = yield* registry.snapshot(threadId);
      expect(snapshot.sessionActive).toBe(false);
      expect(statuses(snapshot.servers)).toEqual([["linear", "ready", false]]);
    }).pipe(Effect.provide(ThreadMcpStatusRegistry.layer)),
  );

  it.effect("rechecks a server after its sign-in instead of calling it ready", () =>
    Effect.gen(function* () {
      const registry = yield* ThreadMcpStatusRegistry.ThreadMcpStatusRegistry;
      const attachment = yield* registry.attach(attachInput("session-1"));
      yield* registry.upsertNative(attachment, {
        name: "linear",
        source: "native",
        status: "needs-sign-in",
        action: "sign-in",
      });
      yield* registry.markSignInCompleted({
        threadId,
        providerThreadId: ProviderThreadId.make("pt-other"),
        server: "linear",
      });
      expect(statuses((yield* registry.snapshot(threadId)).servers)).toEqual([
        ["linear", "needs-sign-in", true],
      ]);
      yield* registry.markSignInCompleted({ threadId, providerThreadId, server: "linear" });
      const [linear] = (yield* registry.snapshot(threadId)).servers;
      expect(linear?.status).toBe("checking");
      expect(linear?.action).toBeUndefined();
    }).pipe(Effect.provide(ThreadMcpStatusRegistry.layer)),
  );

  it.effect("delivers a change that lands while the first snapshot is read", () =>
    Effect.gen(function* () {
      const registry = yield* ThreadMcpStatusRegistry.ThreadMcpStatusRegistry;
      const attachment = yield* registry.attach(attachInput("session-1"));
      let reads = 0;
      const unregister = yield* registry.registerManagedSource({
        snapshot: () =>
          Effect.gen(function* () {
            reads += 1;
            if (reads === 1) {
              yield* registry.upsertNative(attachment, {
                name: "linear",
                source: "native",
                status: "ready",
              });
            }
            return [];
          }),
        changes: Stream.empty,
      });
      const [initial, next] = yield* registry
        .subscribe(threadId)
        .pipe(Stream.take(2), Stream.runCollect);
      expect(initial?.servers).toEqual([]);
      expect(statuses(next?.servers ?? [])).toEqual([["linear", "ready", true]]);
      yield* unregister;
    }).pipe(Effect.provide(ThreadMcpStatusRegistry.layer)),
  );

  it.effect("leaves a server Claude already reported ready when its sign-in completes", () =>
    Effect.gen(function* () {
      const registry = yield* ThreadMcpStatusRegistry.ThreadMcpStatusRegistry;
      const attachment = yield* registry.attach(attachInput("session-1"));
      yield* registry.upsertNative(attachment, {
        name: "linear",
        source: "native",
        status: "ready",
      });
      yield* registry.markSignInCompleted({ threadId, providerThreadId, server: "linear" });
      expect(statuses((yield* registry.snapshot(threadId)).servers)).toEqual([
        ["linear", "ready", true],
      ]);
    }).pipe(Effect.provide(ThreadMcpStatusRegistry.layer)),
  );

  it.effect("still updates a subscriber that fell far behind other threads' changes", () =>
    Effect.gen(function* () {
      const registry = yield* ThreadMcpStatusRegistry.ThreadMcpStatusRegistry;
      const mine = yield* registry.attach(attachInput("session-1"));
      const other = yield* registry.attach({
        ...attachInput("session-2"),
        threadId: ThreadId.make("thread-mcp-status-other"),
      });
      const firstSeen = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let seen = 0;
      const received = yield* registry.subscribe(threadId).pipe(
        // The subscriber pauses after its first snapshot while every change happens.
        Stream.tap(() =>
          seen++ === 0
            ? Deferred.succeed(firstSeen, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(firstSeen);
      yield* registry.upsertNative(mine, { name: "linear", source: "native", status: "ready" });
      for (let index = 0; index < 5_000; index++) {
        yield* registry.upsertNative(other, {
          name: `server-${String(index % 7)}`,
          source: "native",
          status: index % 2 === 0 ? "ready" : "checking",
        });
      }
      yield* Deferred.succeed(release, undefined);
      const [, latest] = yield* Fiber.join(received);
      expect(statuses(latest?.servers ?? [])).toEqual([["linear", "ready", true]]);
    }).pipe(Effect.provide(ThreadMcpStatusRegistry.layer)),
  );

  it.effect("updates a subscriber whose thread was evicted and attached again meanwhile", () =>
    Effect.gen(function* () {
      const registry = yield* ThreadMcpStatusRegistry.ThreadMcpStatusRegistry;
      yield* registry.attach(attachInput("session-1"));
      const firstSeen = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let seen = 0;
      const received = yield* registry.subscribe(threadId).pipe(
        Stream.tap(() =>
          seen++ === 0
            ? Deferred.succeed(firstSeen, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(firstSeen);
      for (let index = 0; index < 1_100; index++) {
        yield* registry.attach({
          ...attachInput(`other-${String(index)}`),
          threadId: ThreadId.make(`thread-other-${String(index)}`),
        });
      }
      yield* registry.attach({
        ...attachInput("session-2"),
        providerThreadId: ProviderThreadId.make("pt-replacement"),
      });
      yield* Deferred.succeed(release, undefined);
      const [, latest] = yield* Fiber.join(received);
      expect(latest?.providerThreadId).toBe("pt-replacement");
    }).pipe(Effect.provide(ThreadMcpStatusRegistry.layer)),
  );

  it.effect("keeps every snapshot within the row contract, needed rows first", () =>
    Effect.gen(function* () {
      const registry = yield* ThreadMcpStatusRegistry.ThreadMcpStatusRegistry;
      const attachment = yield* registry.attach(attachInput("session-1"));
      // Longer than any sign-in may name a server: not shown.
      yield* registry.upsertNative(attachment, {
        name: "x".repeat(257),
        source: "native",
        status: "ready",
      });
      expect((yield* registry.snapshot(threadId)).servers).toEqual([]);
      for (let index = 0; index < 256; index++) {
        yield* registry.upsertNative(attachment, {
          name: `ready-${String(index)}`,
          source: "native",
          status: "ready",
        });
      }
      const unregister = yield* registry.registerManagedSource({
        snapshot: ({ sessionActive }) =>
          Effect.succeed([
            {
              id: "managed:con_linear",
              name: "linear",
              displayName: "L".repeat(300),
              source: "managed" as const,
              status: "needs-sign-in" as const,
              observedAt: IsoDateTime.make("2026-11-24T00:00:00.000Z"),
              action: "sign-in" as const,
              managedId: "con_linear",
              sessionActive,
            },
          ]),
        changes: Stream.empty,
      });
      const snapshot = yield* registry.snapshot(threadId);
      expect(() => decodeSnapshot(snapshot)).not.toThrow();
      expect(snapshot.servers).toHaveLength(256);
      expect(snapshot.servers[0]?.managedId).toBe("con_linear");
      yield* unregister;
    }).pipe(Effect.provide(ThreadMcpStatusRegistry.layer)),
  );

  it.effect("routes the agent's sign-in request to the live session that reported the server", () =>
    Effect.gen(function* () {
      const registry = yield* ThreadMcpStatusRegistry.ThreadMcpStatusRegistry;
      const asked: Array<string> = [];
      const first = yield* registry.attach({
        ...attachInput("session-1"),
        showSignIn: (server) => Effect.sync(() => (asked.push(server), "shown" as const)),
      });
      yield* registry.replaceNative(first, [
        { name: "guru", source: "native", status: "needs-sign-in", action: "sign-in" },
        { name: "claude.ai Gmail", source: "claudeai", status: "needs-sign-in" },
        { name: "deepwiki", source: "native", status: "ready" },
      ]);
      const request = (server: string) => registry.requestSignIn({ threadId, server });

      expect(yield* request(" GURU ")).toEqual({ _tag: "shown", displayName: "guru" });
      expect(asked).toEqual(["guru"]);
      expect(yield* request("claude.ai Gmail")).toEqual({
        _tag: "claudeai",
        displayName: "claude.ai Gmail",
      });
      expect(yield* request("deepwiki")).toEqual({ _tag: "none" });
      expect(yield* request("notion")).toEqual({ _tag: "none" });
      expect(
        yield* registry.requestSignIn({ threadId: ThreadId.make("other"), server: "guru" }),
      ).toEqual({ _tag: "none" });

      // Ended: the last report stays, but no session can act on it.
      yield* registry.detach(first);
      expect(yield* request("guru")).toEqual({ _tag: "inactive", displayName: "guru" });

      // A replacement session that has not reported yet cannot either; one that can't show a
      // row sends the user to the server's own row.
      const second = yield* registry.attach(attachInput("session-2"));
      expect(yield* request("guru")).toEqual({ _tag: "inactive", displayName: "guru" });
      yield* registry.replaceNative(second, [
        { name: "guru", source: "native", status: "needs-sign-in", action: "sign-in" },
        { name: "zotero", source: "native", status: "checking" },
      ]);
      expect(yield* request("guru")).toEqual({ _tag: "card", displayName: "guru" });
      expect(yield* request("zotero")).toEqual({ _tag: "checking", displayName: "zotero" });
      expect(asked).toEqual(["guru"]);
    }).pipe(Effect.provide(ThreadMcpStatusRegistry.layer)),
  );
});
