import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AnalyticsService, type AnalyticsStatus } from "./AnalyticsService.ts";
import { makeComputeOutputAnalytics } from "./ComputeOutputAnalytics.ts";

const fixture = () => {
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
    setConsent: (consent) =>
      Effect.sync(() => {
        status = { available: true, consent };
        epoch += 1;
        return status;
      }),
    flush: Effect.void,
    deleteData: Effect.succeed(true),
  });
  return { events, service };
};

describe("interactive output analytics", () => {
  for (const scenario of [
    { retained: [], expected: "skipped" },
    { retained: [true], expected: "completed" },
    { retained: [true, false, true], expected: "failed" },
    { retained: [false], expected: "failed" },
    { retained: [false, true], expected: "failed" },
  ] as const) {
    it.effect(
      `summarizes ${scenario.retained.join(",") || "no outputs"} as ${scenario.expected}`,
      () => {
        const f = fixture();
        return Effect.gen(function* () {
          const observe = yield* makeComputeOutputAnalytics;
          yield* observe({ key: "private-id", phase: "started", startedAt: 100 });
          yield* observe({ key: "private-id", phase: "started", startedAt: 200 });
          for (const retained of scenario.retained)
            yield* observe({ key: "private-id", phase: "output", retained });
          yield* observe({
            key: "private-id",
            phase: "finished",
            finishedAt: 400,
          });
          yield* observe({ key: "private-id", phase: "output", retained: false });
          yield* observe({ key: "private-id", phase: "finished" });
          expect(f.events).toEqual([
            {
              name: "scient.operation.started",
              properties: { operationKind: "compute-artifact", trigger: "other" },
            },
            {
              name: `scient.operation.${scenario.expected}`,
              properties: {
                operationKind: "compute-artifact",
                trigger: "other",
                durationMs: 300,
                failureClass: "unknown",
              },
            },
          ]);
        }).pipe(Effect.provideService(AnalyticsService, f.service));
      },
    );
  }

  it.effect("does not replay pre-consent work, history, or a reset epoch", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const observe = yield* makeComputeOutputAnalytics;
      yield* f.service.setConsent("off");
      yield* observe({ key: "old", phase: "started", startedAt: 100 });
      yield* f.service.setConsent("product");
      yield* observe({ key: "old", phase: "output", retained: true });
      yield* observe({ key: "old", phase: "finished" });
      yield* observe({ key: "reset", phase: "started", startedAt: 100 });
      yield* f.service.setConsent("off");
      yield* f.service.setConsent("product");
      yield* observe({ key: "reset", phase: "output", retained: true });
      yield* observe({ key: "reset", phase: "finished" });
      expect(f.events.map((event) => event.name)).toEqual(["scient.operation.started"]);
    }).pipe(Effect.provideService(AnalyticsService, f.service));
  });

  it.effect(
    "bounds active correlation and coalesces repeated updates without dropping active starts",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const observe = yield* makeComputeOutputAnalytics;
        for (let i = 0; i < 1_001; i += 1)
          yield* observe({ key: String(i), phase: "started", startedAt: 100 });
        for (let i = 0; i < 2_000; i += 1)
          yield* observe({ key: "0", phase: "output", retained: true });
        expect(f.events).toHaveLength(1_000);
        yield* observe({ key: "1000", phase: "finished" });
        expect(f.events).toHaveLength(1_000);
        yield* observe({ key: "0", phase: "finished" });
        expect(f.events.at(-1)?.name).toBe("scient.operation.completed");
        yield* observe({ key: "fresh", phase: "started", startedAt: 100 });
        expect(f.events).toHaveLength(1_002);
      }).pipe(Effect.provideService(AnalyticsService, f.service));
    },
  );

  it.effect("requires no service and ignores observer defects", () =>
    Effect.gen(function* () {
      const noService = yield* makeComputeOutputAnalytics;
      yield* noService({ key: "unused", phase: "started", startedAt: 100 });
      const f = fixture();
      const broken = yield* makeComputeOutputAnalytics.pipe(
        Effect.provideService(AnalyticsService, {
          ...f.service,
          status: Effect.die("private error"),
        }),
      );
      yield* broken({ key: "unused", phase: "started", startedAt: 100 });
      yield* broken({ key: "unused", phase: "output", retained: true });
      yield* broken({ key: "unused", phase: "finished" });
      expect(f.events).toHaveLength(0);
    }),
  );
});
