import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { AnalyticsService, type AnalyticsStatus } from "./AnalyticsService.ts";
import { makeOperationAnalytics, observeAnalyticsEffect } from "./OperationAnalytics.ts";

function fixture() {
  const events: { name: string; properties: Readonly<Record<string, unknown>> | undefined }[] = [];
  let status: AnalyticsStatus = { available: true, consent: "product" };
  let epoch = 0;
  const service = AnalyticsService.of({
    record: (name, properties) =>
      Effect.sync(() => {
        events.push({ name, properties });
      }),
    status: Effect.sync(() => status),
    collectionEpoch: Effect.sync(() => epoch),
    flush: Effect.void,
    deleteData: Effect.succeed(true),
    setConsent: (consent) =>
      Effect.sync(() => {
        status = { available: true, consent };
        epoch += 1;
        return status;
      }),
  });
  return { events, service };
}

describe("semantic operation analytics", () => {
  it.effect("runs the product operation exactly once when analytics preflight defects", () => {
    const f = fixture();
    let executions = 0;
    return Effect.gen(function* () {
      expect(
        yield* observeAnalyticsEffect(
          Effect.sync(() => ++executions),
          { kind: "server-startup" },
        ),
      ).toBe(1);
      expect(executions).toBe(1);
      expect(f.events).toHaveLength(0);
    }).pipe(
      Effect.provideService(AnalyticsService, {
        ...f.service,
        status: Effect.die("observer unavailable"),
      }),
    );
  });
  it.effect("observes sign-out completion and failure without account details", () => {
    const f = fixture();
    const measurement = {
      kind: "provider-sign-out",
      provider: "codex",
      source: "managed",
    } as const;
    return Effect.gen(function* () {
      yield* observeAnalyticsEffect(Effect.void, measurement);
      yield* Effect.exit(
        observeAnalyticsEffect(Effect.fail("private account detail"), measurement),
      );
      expect(f.events.map((event) => event.name)).toEqual([
        "provider.lifecycle.started",
        "provider.lifecycle.completed",
        "provider.lifecycle.started",
        "provider.lifecycle.failed",
      ]);
      expect(f.events[0]?.properties).toMatchObject({
        provider: "codex",
        action: "sign-out",
        source: "managed",
      });
      expect(f.events.flatMap((event) => Object.values(event.properties ?? {}))).not.toContain(
        "private account detail",
      );
    }).pipe(Effect.provideService(AnalyticsService, f.service));
  });
  it.effect(
    "records one terminal outcome, ignores restored history and clears at consent boundaries",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const observe = yield* makeOperationAnalytics;
        const operation = {
          key: "opaque-id",
          operationKind: "compute-run",
          startedAt: 1000,
        } as const;
        yield* observe({ ...operation, key: "old", status: "completed", finishedAt: 2000 });
        yield* observe({ ...operation, status: "active" });
        yield* observe({ ...operation, status: "active" });
        yield* observe({ ...operation, status: "cancelled", finishedAt: 2000 });
        yield* observe({ ...operation, status: "cancelled", finishedAt: 2000 });
        expect(f.events.map((event) => event.name)).toEqual([
          "scient.operation.started",
          "scient.operation.cancelled",
        ]);
        expect(f.events.flatMap((event) => Object.values(event.properties ?? {}))).not.toContain(
          "opaque-id",
        );
        yield* observe({ ...operation, key: "consent", status: "active" });
        yield* f.service.setConsent("off");
        yield* f.service.setConsent("product");
        yield* observe({ ...operation, key: "consent", status: "completed" });
        expect(f.events).toHaveLength(3);
      }).pipe(Effect.provideService(AnalyticsService, f.service));
    },
  );

  it.effect("does not change the operation's result or error or capture its contents", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const result = { private: "private-document-content" };
      expect(
        yield* observeAnalyticsEffect(Effect.succeed(result), {
          kind: "pdf-export",
          trigger: "agent",
        }),
      ).toBe(result);
      const failure = new Error("secret /user/document/path");
      const exit = yield* Effect.exit(
        observeAnalyticsEffect(Effect.fail(failure), { kind: "server-startup" }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(
        f.events.flatMap((event) => Object.values(event.properties ?? {})).join(" "),
      ).not.toMatch(/private-document|secret|\/user/);
      expect(f.events.map((event) => event.name)).toEqual([
        "scient.operation.started",
        "scient.operation.completed",
        "app.health",
        "app.health",
      ]);
      yield* f.service.setConsent("off");
      yield* observeAnalyticsEffect(Effect.succeed(result), {
        kind: "pdf-export",
        trigger: "agent",
      });
      expect(f.events).toHaveLength(4);
    }).pipe(Effect.provideService(AnalyticsService, f.service));
  });
});
