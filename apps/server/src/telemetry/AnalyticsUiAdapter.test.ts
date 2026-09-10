import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { AnalyticsService, type AnalyticsStatus } from "./AnalyticsService.ts";
import { makeAnalyticsUiAdapter } from "./AnalyticsUiAdapter.ts";

function fixture() {
  let status: AnalyticsStatus = { available: true, consent: "product" };
  let epoch = 0;
  const events: unknown[] = [];
  const service = AnalyticsService.of({
    status: Effect.sync(() => status),
    collectionEpoch: Effect.sync(() => epoch),
    record: (name, properties) =>
      Effect.sync(() => {
        events.push({ name, properties });
      }),
    setConsent: (consent) =>
      Effect.sync(() => {
        status = { available: true, consent };
        epoch += 1;
        return status;
      }),
    deleteData: Effect.sync(() => {
      epoch += 1;
      return true;
    }),
    flush: Effect.void,
  });
  return { service, events };
}

describe("UI operation consent context", () => {
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
      yield* f.service.setConsent("off");
      expect(yield* ui.record(event)).toEqual({ accepted: false });
      expect((yield* ui.status).collectionContext).toBeUndefined();
      yield* f.service.setConsent("product");
      expect(yield* ui.record(event)).toEqual({ accepted: false });
      const afterConsent = yield* ui.status;
      yield* f.service.deleteData;
      expect(
        yield* ui.record({ ...event, collectionContext: afterConsent.collectionContext }),
      ).toEqual({ accepted: false });
      const afterDelete = yield* ui.status;
      const restarted = makeAnalyticsUiAdapter(f.service);
      expect(
        yield* restarted.record({ ...event, collectionContext: afterDelete.collectionContext }),
      ).toEqual({ accepted: false });
      expect(f.events).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the legacy UI protocol and restricts new operations to UI-owned exports", () =>
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
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
