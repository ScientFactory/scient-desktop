/**
 * Update facts the desktop app journaled (outcomes of check, download, install and apply, and
 * update summaries). They keep the desktop's event ids and times, so a fact offered again after a
 * lost acknowledgement stays one event in the outbox and at the gateway.
 *
 * @module DesktopUpdateFacts
 */
import type { DesktopUpdateFact } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AnalyticsService } from "./AnalyticsService.ts";

/** The ids the desktop may forget: held by the outbox, or never to be sent from here. */
export const ingestDesktopUpdateFacts = Effect.fn("DesktopUpdateFacts.ingest")(function* (
  analytics: Option.Option<AnalyticsService["Service"]>,
  facts: ReadonlyArray<DesktopUpdateFact>,
) {
  const ingest = Option.getOrUndefined(analytics)?.ingestRecorded;
  const settled = ingest === undefined ? true : yield* ingest(facts);
  return settled ? facts.map((fact) => fact.id) : [];
});
