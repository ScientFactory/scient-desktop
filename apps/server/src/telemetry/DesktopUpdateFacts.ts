/**
 * Update facts (check, download, install and apply outcomes, summaries) and startup timing the
 * desktop journaled. They keep the desktop's event ids and times, so a fact offered again after a
 * lost acknowledgement stays one event in the outbox and at the gateway.
 *
 * @module DesktopUpdateFacts
 */
import type { DesktopUpdateFact } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { RecordedAnalyticsIngest } from "./ScientAnalytics.ts";

/** The ids the desktop may forget: held by the outbox, or never to be sent from here. */
export const ingestDesktopUpdateFacts = Effect.fn("DesktopUpdateFacts.ingest")(function* (
  recorded: RecordedAnalyticsIngest,
  facts: ReadonlyArray<DesktopUpdateFact>,
) {
  const settled = yield* recorded.ingest(facts);
  return settled ? facts.map((fact) => fact.id) : [];
});
