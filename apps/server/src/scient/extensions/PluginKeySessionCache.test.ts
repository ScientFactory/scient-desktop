// @effect-diagnostics nodeBuiltinImport:off -- Synthetic state and credential values only.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Redacted, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { makeHarness, memoryStore } from "../accounts/Accounts.testkit.ts";
import { accountTokenRef } from "../accounts/AccountBoundRef.ts";
import { makePluginKeySessionCache } from "./PluginKeySessionCache.ts";
import { makePluginKeyBindings } from "./PluginKeyBindings.ts";
const root = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-key-cache-"))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
);
const target = {
  agent: ProviderInstanceId.make("synthetic-agent"),
  pluginId: "synthetic-plugin",
  projectId: ProjectId.make("synthetic-project"),
};
const consumer = {
  kind: "plugin-key" as const,
  agent: target.agent,
  pluginId: target.pluginId,
  envName: "TOKEN",
  projectId: target.projectId,
  origin: "https://api.example.com",
};

it.effect(
  "single-flights concurrent requests, caches Redacted values and throttles allowed audit independently of refresh",
  () =>
    Effect.gen(function* () {
      const directory = yield* root;
      const { service } = yield* makeHarness();
      const details = {
        kind: "api-key" as const,
        sites: ["example.com"],
        auth: { type: "bearer" as const },
      };
      const { accountId } = yield* service.save({
        name: "Synthetic",
        details,
        secrets: { token: { type: "scient", value: "synthetic-original-key" } },
      });
      let resolves = 0;
      let lists = 0;
      const bindings = yield* makePluginKeyBindings(directory, {
        ...service,
        listBindable: (input) => {
          lists++;
          return service.listBindable(input);
        },
        resolveBound: (ref, consumer, options) => {
          resolves++;
          return service.resolveBound(ref, consumer, options);
        },
      });
      const ref = accountTokenRef(accountId);
      yield* bindings.bind({ ...target, envName: "TOKEN", accountRef: ref });
      const input = { ...target, envName: "TOKEN", origin: consumer.origin, expectedRef: ref };
      const before = lists;
      const values = yield* Effect.forEach(
        Array.from({ length: 20 }),
        () => bindings.resolveForSession("session-a", input),
        { concurrency: "unbounded" },
      );
      expect(resolves).toBe(1);
      expect(lists).toBe(before);
      expect(values.every((value) => Redacted.value(value) === "synthetic-original-key")).toBe(
        true,
      );
      expect(JSON.stringify(values)).not.toContain("synthetic-original-key");
      yield* service.changes.pipe(
        Stream.filter((snapshot) =>
          snapshot.recentActivity.some(
            (entry) => entry.action === "request" && entry.decision === "allowed",
          ),
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const revision = yield* service.bindingRevision!;
      yield* bindings.resolveForSession("session-a", input);
      expect(resolves).toBe(1); // usage-only snapshots do not evict the just-resolved key
      yield* service.save({
        accountId,
        name: "Edited",
        details,
        secrets: { token: { type: "scient", value: "synthetic-rotated-key" } },
      });
      expect(yield* service.bindingRevision!).not.toBe(revision);
      expect(Redacted.value(yield* bindings.resolveForSession("session-a", input))).toBe(
        "synthetic-rotated-key",
      );
      expect(resolves).toBe(2);
      expect(
        (yield* service.snapshot).recentActivity.filter(
          (entry) => entry.action === "request" && entry.decision === "allowed",
        ),
      ).toHaveLength(1);
      yield* TestClock.adjust("3 minutes");
      yield* bindings.resolveForSession("session-a", input);
      expect(resolves).toBe(3);
      yield* service.changes.pipe(
        Stream.filter(
          (snapshot) =>
            snapshot.recentActivity.filter(
              (entry) => entry.action === "request" && entry.decision === "allowed",
            ).length === 2,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* bindings.resolveForSession("session-b", input);
      expect(resolves).toBe(4);
      yield* bindings.clearSession("session-a");
      yield* bindings.resolveForSession("session-b", input);
      expect(resolves).toBe(4);
      expect((yield* bindings.resolveForSession("session-a", input).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(resolves).toBe(4);
      yield* bindings.resolveForSession("session-c", input);
      expect(resolves).toBe(5);
    }),
);

it.effect(
  "invalidates synchronously for Off, scope, global access, rebinding and removal; every denial is recorded",
  () =>
    Effect.gen(function* () {
      const directory = yield* root;
      const { service } = yield* makeHarness();
      const details = {
        kind: "api-key" as const,
        sites: ["example.com"],
        auth: { type: "bearer" as const },
      };
      const { accountId } = yield* service.save({
        name: "Synthetic",
        details,
        secrets: { token: { type: "scient", value: "synthetic-cache-key" } },
      });
      const bindings = yield* makePluginKeyBindings(directory, service);
      const ref = accountTokenRef(accountId);
      yield* bindings.bind({ ...target, envName: "TOKEN", accountRef: ref });
      const input = { ...target, envName: "TOKEN", origin: consumer.origin, expectedRef: ref };
      const read = bindings.resolveForSession("session", input);
      yield* read;
      yield* service.setControls({ target: { type: "account", accountId }, access: "off" });
      expect((yield* read.pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* read.pipe(Effect.result))._tag).toBe("Failure");
      yield* service.setControls({ target: { type: "account", accountId }, access: "allowed" });
      yield* read;
      yield* service.setControls({
        target: { type: "account", accountId },
        scope: { type: "projects", projectIds: [ProjectId.make("other-project")] },
      });
      expect((yield* read.pipe(Effect.result))._tag).toBe("Failure");
      yield* service.setControls({
        target: { type: "account", accountId },
        scope: { type: "all-projects" },
      });
      yield* read;
      yield* service.setAgentAccess(false);
      expect((yield* read.pipe(Effect.result))._tag).toBe("Failure");
      yield* service.setAgentAccess(true);
      yield* read;
      yield* bindings.unbind({ ...target, envName: "TOKEN" });
      expect((yield* read.pipe(Effect.result))._tag).toBe("Failure");
      yield* bindings.bind({ ...target, envName: "TOKEN", accountRef: ref });
      yield* read;
      yield* service.remove(accountId);
      expect((yield* read.pipe(Effect.result))._tag).toBe("Failure");
      expect(
        (yield* service.snapshot).recentActivity.filter(
          (entry) => entry.action === "request" && entry.decision === "denied",
        ),
      ).toHaveLength(6);
    }),
);

it.effect(
  "serves a warm key while an unrelated allowed-use activity write holds the Accounts lock",
  () =>
    Effect.gen(function* () {
      const directory = yield* root;
      const original = memoryStore();
      let block = false;
      let observe = false;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const coldRead = Promise.withResolvers<void>();
      const { service } = yield* makeHarness({
        storage: {
          ...original,
          store: {
            ...original.store,
            set: (name, value) =>
              Effect.gen(function* () {
                if (block && name === "accounts-activity") {
                  entered.resolve();
                  yield* Effect.promise(() => release.promise);
                }
                yield* original.store.set(name, value);
              }),
          },
        },
      });
      const { accountId } = yield* service.save({
        name: "Synthetic",
        details: { kind: "api-key", sites: ["example.com"], auth: { type: "bearer" } },
        secrets: { token: { type: "scient", value: "synthetic-held-writer" } },
      });
      const bindings = yield* makePluginKeyBindings(directory, {
        ...service,
        resolveBound: (ref, consumer, options) => {
          if (observe) coldRead.resolve();
          return service.resolveBound(ref, consumer, options);
        },
      });
      const ref = accountTokenRef(accountId);
      yield* bindings.bind({ ...target, envName: "TOKEN", accountRef: ref });
      const input = { ...target, envName: "TOKEN", origin: consumer.origin, expectedRef: ref };
      yield* bindings.resolveForSession("session", input);
      yield* service.changes.pipe(
        Stream.filter((snapshot) =>
          snapshot.recentActivity.some((entry) => entry.action === "request"),
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          block = false;
          release.resolve();
        }),
      );
      block = true;
      observe = true;
      yield* service.recordUse({ target: { type: "account", accountId }, action: "request" });
      yield* Effect.promise(() => entered.promise);
      const result = yield* Effect.race(
        bindings
          .resolveForSession("session", input)
          .pipe(Effect.map((value) => Redacted.value(value))),
        Effect.promise(() => coldRead.promise).pipe(Effect.as("unexpected Accounts read")),
      );
      expect(result).toBe("synthetic-held-writer");
      block = false;
      release.resolve();
    }),
);

it.effect.each(["account", "binding", "session"] as const)(
  "withholds a lookup completed after %s revocation",
  (action) =>
    Effect.gen(function* () {
      let revision = 1;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));
      const cache = yield* makePluginKeySessionCache(
        { bindingRevision: Effect.sync(() => revision), changes: Stream.never },
        () =>
          Effect.gen(function* () {
            entered.resolve();
            yield* Effect.promise(() => release.promise);
            return Redacted.make("synthetic-stale-key");
          }),
      );
      const read = yield* Effect.forkChild(
        cache.resolveForSession("session", { ...target, envName: "TOKEN" }),
      );
      yield* Effect.promise(() => entered.promise);
      if (action === "account") revision++;
      else if (action === "binding") yield* cache.invalidate;
      else yield* cache.clearSession("session");
      release.resolve();
      expect((yield* Fiber.await(read))._tag).toBe("Failure");
    }),
);

it.effect("keeps origin/project/agent grants and rebound account refs separate", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const { service } = yield* makeHarness();
    const details = {
      kind: "api-key" as const,
      sites: ["example.com"],
      auth: { type: "bearer" as const },
    };
    const first = yield* service.save({
      name: "First synthetic",
      details,
      secrets: { token: { type: "scient", value: "synthetic-first-key" } },
    });
    const second = yield* service.save({
      name: "Second synthetic",
      details,
      secrets: { token: { type: "scient", value: "synthetic-second-key" } },
    });
    yield* service.setControls({
      target: { type: "account", accountId: first.accountId },
      scope: { type: "projects", projectIds: [target.projectId] },
    });
    const bindings = yield* makePluginKeyBindings(directory, service);
    const ref = accountTokenRef(first.accountId);
    yield* bindings.bind({ ...target, envName: "TOKEN", accountRef: ref });
    const input = { ...target, envName: "TOKEN", origin: consumer.origin, expectedRef: ref };
    expect(Redacted.value(yield* bindings.resolveForSession("session", input))).toBe(
      "synthetic-first-key",
    );
    expect(
      (yield* bindings
        .resolveForSession("session", { ...input, origin: "https://unapproved.example.net" })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(
      (yield* bindings
        .resolveForSession("session", { ...input, projectId: ProjectId.make("another-project") })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(
      (yield* bindings
        .resolveForSession("session", { ...input, agent: ProviderInstanceId.make("another-agent") })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    const next = accountTokenRef(second.accountId);
    yield* bindings.bind({ ...target, envName: "TOKEN", accountRef: next });
    expect((yield* bindings.resolveForSession("session", input).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect(
      Redacted.value(yield* bindings.resolveForSession("session", { ...input, expectedRef: next })),
    ).toBe("synthetic-second-key");
  }),
);

it.effect(
  "drops an expired owner's values for reauthorization, but cannot repopulate an ended owner's cache",
  () =>
    Effect.gen(function* () {
      let resolutions = 0;
      const cache = yield* makePluginKeySessionCache(
        { bindingRevision: Effect.succeed(1), changes: Stream.never },
        () =>
          Effect.sync(() => {
            resolutions++;
            return Redacted.make("synthetic-revived-key");
          }),
      );
      const input = { ...target, envName: "TOKEN" };
      yield* cache.resolveForSession("session", input);
      yield* cache.resolveForSession("session", input);
      expect(resolutions).toBe(1);
      yield* cache.clearSession("session", true);
      yield* cache.resolveForSession("session", input);
      expect(resolutions).toBe(2);
      yield* cache.clearSession("session");
      expect((yield* cache.resolveForSession("session", input).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(resolutions).toBe(2);
    }),
);
