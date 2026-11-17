import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import { AnalyticsService } from "./AnalyticsService.ts";
import { makeAnalyticsUiAdapter } from "./AnalyticsUiAdapter.ts";

function fixture() {
  const events: unknown[] = [];
  const service = AnalyticsService.of({
    recordOwners: () => Effect.void,
    status: Effect.succeed({ available: true }),
    record: (name, properties) =>
      Effect.sync(() => {
        events.push({ name, properties });
      }),
    flush: Effect.void,
  });
  return { service, events };
}

describe("UI operation collection context", () => {
  it.effect("fences all voice stages across a server restart without exporting the context", () =>
    Effect.gen(function* () {
      const f = fixture();
      const ui = makeAnalyticsUiAdapter(f.service);
      const status = yield* ui.status;
      expect(status.voiceLifecycleVersion).toBe(2);
      for (const name of [
        "voice.transcription.started",
        "voice.transcription.completed",
        "voice.transcription.failed",
        "voice.transcription.cancelled",
        "voice.recording.failed",
      ]) {
        const event = { name, properties: { voiceSchemaVersion: 2 } };
        expect(yield* ui.record(event)).toEqual({ accepted: false });
        expect(yield* ui.record({ ...event, collectionContext: status.collectionContext })).toEqual(
          { accepted: true },
        );
      }
      const restarted = makeAnalyticsUiAdapter(f.service);
      expect(
        yield* restarted.record({
          name: "voice.transcription.completed",
          properties: {},
          collectionContext: status.collectionContext,
        }),
      ).toEqual({ accepted: false });
      expect(JSON.stringify(f.events)).not.toMatch(/collectionContext|voiceLifecycleVersion/u);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
  it.effect("accepts Visual LaTeX outcomes only within the current collection context", () =>
    Effect.gen(function* () {
      const f = fixture();
      const ui = makeAnalyticsUiAdapter(f.service);
      const current = yield* ui.status;
      const event = {
        name: "scient.operation.completed" as const,
        properties: { operationKind: "latex-visual-edit", trigger: "user" },
      };
      expect(yield* ui.record(event)).toEqual({ accepted: false });
      expect(yield* ui.record({ ...event, collectionContext: current.collectionContext })).toEqual({
        accepted: true,
      });
      const restarted = makeAnalyticsUiAdapter(f.service);
      expect(
        yield* restarted.record({ ...event, collectionContext: current.collectionContext }),
      ).toEqual({ accepted: false });
      expect(f.events).toEqual([event]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
  it.effect(
    "fences Accounts' browser observations across a server restart, not other features",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const before = yield* makeAnalyticsUiAdapter(f.service).status;
        const ui = makeAnalyticsUiAdapter(f.service);
        const window = {
          name: "feature.used" as const,
          properties: { feature: "accounts.browser_window", variant: "copied" },
        };
        const other = { name: "feature.used" as const, properties: { feature: "sources.add" } };
        expect(yield* ui.record(window)).toEqual({ accepted: false });
        expect(yield* ui.record(other)).toEqual({ accepted: true });
        // The window was opened before the server restarted.
        expect(
          yield* ui.record({ ...window, collectionContext: before.collectionContext }),
        ).toEqual({ accepted: false });
        const after = yield* ui.status;
        expect(yield* ui.record({ ...window, collectionContext: after.collectionContext })).toEqual(
          {
            accepted: true,
          },
        );
        expect(f.events).toEqual([other, window]);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );
  it.effect("strips the context before recording and rejects absent or wrong contexts", () =>
    Effect.gen(function* () {
      const f = fixture();
      const ui = makeAnalyticsUiAdapter(f.service);
      const current = yield* ui.status;
      expect(current.collectionContext).toEqual(expect.any(String));
      const event = {
        name: "scient.operation.completed" as const,
        properties: { operationKind: "pdf-export", durationMs: 100 },
      };
      expect(yield* ui.record(event)).toEqual({ accepted: false });
      expect(yield* ui.record({ ...event, collectionContext: "wrong-context" })).toEqual({
        accepted: false,
      });
      expect(yield* ui.record({ ...event, collectionContext: current.collectionContext })).toEqual({
        accepted: true,
      });
      expect(f.events).toEqual([event]);
      expect((yield* ui.status).collectionContext).toBe(current.collectionContext);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("keeps the legacy UI protocol and restricts new operations to UI-owned kinds", () =>
    Effect.gen(function* () {
      const f = fixture();
      const ui = makeAnalyticsUiAdapter(f.service);
      const context = (yield* ui.status).collectionContext;
      expect(
        yield* ui.record({
          name: "scient.operation.completed",
          collectionContext: context,
          properties: { operationKind: "compute-run" },
        }),
      ).toEqual({ accepted: false });
      const legacy = { name: "project.opened" as const, properties: {} };
      expect(yield* ui.record(legacy)).toEqual({ accepted: true });
      expect(f.events).toEqual([legacy]);
      const disabled = makeAnalyticsUiAdapter({
        ...f.service,
        status: Effect.succeed({ available: false }),
      });
      expect(yield* disabled.status).toEqual({ available: false, consent: "off" });
      // Older clients still read a consent level; it is always the full one.
      expect(yield* ui.status).toMatchObject({ available: true, consent: "diagnostic" });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
