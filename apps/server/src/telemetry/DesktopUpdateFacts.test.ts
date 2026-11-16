import type { DesktopUpdateFact } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ingestDesktopUpdateFacts } from "./DesktopUpdateFacts.ts";
import { disabledAnalyticsService } from "./ScientAnalytics.ts";

const fact: DesktopUpdateFact = {
  id: "6f1c2a9e-4b7d-4e21-9a3f-0c5d8e7b1a24",
  name: "app.update.outcome",
  occurredAt: "2026-11-16T10:00:00.000Z",
  appVersion: "0.6.29",
  buildChannel: "stable",
  properties: { step: "install", outcome: "handoff-attempted" },
};

describe("ingestDesktopUpdateFacts", () => {
  it.effect("acknowledges facts only once the outbox settled them", () =>
    Effect.gen(function* () {
      const unconfirmed = yield* ingestDesktopUpdateFacts(
        Option.some({ ...disabledAnalyticsService, ingestRecorded: () => Effect.succeed(false) }),
        [fact],
      );
      assert.deepEqual(unconfirmed, []);

      const persisted = yield* ingestDesktopUpdateFacts(
        Option.some({ ...disabledAnalyticsService, ingestRecorded: () => Effect.succeed(true) }),
        [fact],
      );
      assert.deepEqual(persisted, [fact.id]);
    }),
  );
});
