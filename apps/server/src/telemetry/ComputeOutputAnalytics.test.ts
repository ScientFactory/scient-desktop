import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AnalyticsService } from "./AnalyticsService.ts";
import { ScientAnalyticsAvailability } from "./ScientAnalytics.ts";
import { makeComputeOutputAnalytics } from "./ComputeOutputAnalytics.ts";

const fixture = () => {
  const events: { name: string; properties: Readonly<Record<string, unknown>> | undefined }[] = [];
  const availability = { available: true };
  const service = AnalyticsService.of({
    recordOwners: () => Effect.void,
    record: (name, properties) =>
      Effect.sync(() => {
        events.push({ name, properties });
      }),
    flush: Effect.void,
  });
  const setAvailable = (next: boolean) =>
    Effect.sync(() => {
      availability.available = next;
    });
  return { events, service, availability, setAvailable };
};

describe("interactive output analytics", () => {
  it.effect.each(
    (
      [
        { retained: [], expected: "skipped" },
        { retained: [true], expected: "completed" },
        { retained: [true, false, true], expected: "failed" },
        { retained: [false], expected: "failed" },
        { retained: [false, true], expected: "failed" },
      ] as const
    ).map((scenario) => ({
      caseTitle: `summarizes ${scenario.retained.join(",") || "no outputs"} as ${scenario.expected}`,
      scenario,
    })),
  )("$caseTitle", ({ scenario }) => {
    const f = fixture();
    const values: readonly boolean[] = scenario.retained;
    return Effect.gen(function* () {
      const observe = yield* makeComputeOutputAnalytics;
      yield* observe({ key: "private-id", phase: "started", startedAt: 100 });
      yield* observe({ key: "private-id", phase: "started", startedAt: 200 });
      yield* observe({
        key: "private-id",
        phase: "coverage",
        capture: { coverage: "complete", rejectedCount: 0 },
      });
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
          properties: {
            operationKind: "compute-artifact",
            trigger: "other",
            captureSchemaVersion: 2,
            captureSource: "interactive",
          },
        },
        {
          name: `scient.operation.${scenario.expected}`,
          properties: {
            operationKind: "compute-artifact",
            trigger: "other",
            durationMs: 300,
            failureClass: "unknown",
            captureSchemaVersion: 2,
            captureSource: "interactive",
            captureCoverage: "complete",
            captureOutcome: values.includes(false)
              ? values.includes(true)
                ? "partial"
                : "failed"
              : values.includes(true)
                ? "retained"
                : "none",
            captureReason: values.includes(false) ? "persistence-failed" : "none",
            retainedOutputCount: scenario.retained.filter(Boolean).length,
            rejectedOutputCount: scenario.retained.filter((value) => !value).length,
            ...(values.includes(false)
              ? { failureOwner: "scient", failureCategory: "persistence-failed" }
              : {}),
          },
        },
      ]);
    }).pipe(
      Effect.provideService(AnalyticsService, f.service),
      Effect.provideService(ScientAnalyticsAvailability, f.availability),
    );
  });

  it.effect("does not replay work started while unavailable, or history", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const observe = yield* makeComputeOutputAnalytics;
      yield* f.setAvailable(false);
      yield* observe({ key: "old", phase: "started", startedAt: 100 });
      yield* f.setAvailable(true);
      yield* observe({ key: "old", phase: "output", retained: true });
      yield* observe({ key: "old", phase: "finished" });
      yield* observe({ key: "history", phase: "finished" });
      expect(f.events).toEqual([]);
    }).pipe(
      Effect.provideService(AnalyticsService, f.service),
      Effect.provideService(ScientAnalyticsAvailability, f.availability),
    );
  });

  it.effect.each([false, true])(
    "keeps partial scan coverage separate from retention (%s)",
    (retained) => {
      const f = fixture();
      return Effect.gen(function* () {
        const observe = yield* makeComputeOutputAnalytics;
        yield* observe({ key: "synthetic", phase: "started", startedAt: 100 });
        yield* observe({
          key: "synthetic",
          phase: "coverage",
          capture: { coverage: "partial", coverageReason: "scan-depth-limit", rejectedCount: 0 },
        });
        if (retained) yield* observe({ key: "synthetic", phase: "output", retained: true });
        yield* observe({ key: "synthetic", phase: "finished", finishedAt: 200 });
        expect(f.events.at(-1)).toMatchObject({
          name: retained ? "scient.operation.completed" : "scient.operation.skipped",
          properties: {
            captureOutcome: retained ? "retained" : "unobserved",
            captureCoverage: "partial",
            captureReason: "scan-depth-limit",
            rejectedOutputCount: 0,
          },
        });
      }).pipe(
        Effect.provideService(AnalyticsService, f.service),
        Effect.provideService(ScientAnalyticsAvailability, f.availability),
      );
    },
  );

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
      }).pipe(
        Effect.provideService(AnalyticsService, f.service),
        Effect.provideService(ScientAnalyticsAvailability, f.availability),
      );
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
          record: () => Effect.die("private error"),
        }),
        Effect.provideService(ScientAnalyticsAvailability, f.availability),
      );
      yield* broken({ key: "unused", phase: "started", startedAt: 100 });
      yield* broken({ key: "unused", phase: "output", retained: true });
      yield* broken({ key: "unused", phase: "finished" });
      expect(f.events).toHaveLength(0);
    }),
  );
});
