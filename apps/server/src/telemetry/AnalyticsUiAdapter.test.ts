import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import { AnalyticsService, type AnalyticsStatus } from "./AnalyticsService.ts";
import { makeAnalyticsUiAdapter } from "./AnalyticsUiAdapter.ts";

function fixture() {
  let status: AnalyticsStatus = { available: true, consent: "product" };
  let epoch = 0;
  const events: unknown[] = [];
  const service = AnalyticsService.of({
    recordOwners: () => Effect.void,
    status: Effect.sync(() => status),
    collectionEpoch: Effect.sync(() => epoch),
    record: (name, properties) =>
      Effect.sync(() => {
        events.push({ name, properties });
      }),
    flush: Effect.void,
  });
  // Another client's consent change or a deletion moves the service to a new epoch.
  const setConsent = (consent: AnalyticsStatus["consent"]) =>
    Effect.sync(() => {
      status = { available: true, consent };
      epoch += 1;
    });
  const deleteData = Effect.sync(() => {
    epoch += 1;
  });
  return { service, events, setConsent, deleteData };
}

describe("UI operation consent context", () => {
  it.effect(
    "fences all voice stages across consent changes and deletion without exporting the context",
    () =>
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
          expect(
            yield* ui.record({ ...event, collectionContext: status.collectionContext }),
          ).toEqual({ accepted: true });
        }
        yield* f.deleteData;
        expect(
          yield* ui.record({
            name: "voice.transcription.completed",
            properties: {},
            collectionContext: status.collectionContext,
          }),
        ).toEqual({ accepted: false });
        const refreshed = yield* ui.status;
        yield* f.setConsent("off");
        yield* f.setConsent("product");
        expect(
          yield* ui.record({
            name: "voice.transcription.completed",
            properties: {},
            collectionContext: refreshed.collectionContext,
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
      yield* f.deleteData;
      expect(yield* ui.record({ ...event, collectionContext: current.collectionContext })).toEqual({
        accepted: false,
      });
      expect(f.events).toEqual([event]);
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

  it.effect("fences other-client consent changes, deletion and a fresh HTTP lifetime", () =>
    Effect.gen(function* () {
      const f = fixture();
      const ui = makeAnalyticsUiAdapter(f.service);
      const original = yield* ui.status;
      const event = {
        name: "scient.operation.failed" as const,
        properties: { operationKind: "document-export" },
        collectionContext: original.collectionContext,
      };
      yield* f.setConsent("off");
      expect(yield* ui.record(event)).toEqual({ accepted: false });
      expect((yield* ui.status).collectionContext).toBeUndefined();
      yield* f.setConsent("product");
      expect(yield* ui.record(event)).toEqual({ accepted: false });
      const afterConsent = yield* ui.status;
      yield* f.deleteData;
      expect(
        yield* ui.record({ ...event, collectionContext: afterConsent.collectionContext }),
      ).toEqual({ accepted: false });
      const afterDelete = yield* ui.status;
      const restarted = makeAnalyticsUiAdapter(f.service);
      expect(
        yield* restarted.record({ ...event, collectionContext: afterDelete.collectionContext }),
      ).toEqual({ accepted: false });
      expect(f.events).toEqual([]);
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
        status: Effect.succeed({ available: false, consent: "off" }),
      });
      expect(yield* disabled.status).toEqual({ available: false, consent: "off" });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
