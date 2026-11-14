/**
 * A voice call in a Scient Agent process of its own, apart from any conversation's session, so a
 * call needs no running conversation: a new one, or one whose agent stopped. Scient sends each
 * spoken request to the conversation itself and reports the turn back with `live_report`.
 */
import { ScientLiveVoiceFailure } from "@t3tools/provider-core/server/ProviderAdapter";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { isOmpLiveFrame, makeOmpLiveVoice } from "../omp/OmpLiveVoice.ts";
import type { OmpRpcProcess } from "../omp/OmpRpcProcess.ts";
import type { ProviderLiveVoiceCall } from "../ScientProviderInstanceSeams.ts";

/** The first Scient Agent release that takes `live_report`. */
const LIVE_REPORT_VERSION = "0.1.10";

/**
 * Opens the call's agent for the caller's scope; undefined from an agent that predates
 * `live_report`, whose calls still run in the conversation's own session.
 */
export const openScientAgentLiveVoiceCall = Effect.fn("ScientAgentLiveVoiceHost.openCall")(
  function* <E, R>(startAgent: Effect.Effect<OmpRpcProcess, E, R | Scope.Scope>) {
    const client = yield* startAgent.pipe(
      Effect.mapError(
        () =>
          new ScientLiveVoiceFailure({
            reason: "call-failed",
            detail: "Scient Agent couldn't start for the call.",
          }),
      ),
    );
    if (compareSemverVersions(client.version, LIVE_REPORT_VERSION) < 0) return undefined;
    const live = makeOmpLiveVoice(client);
    yield* client.events.pipe(
      Stream.runForEach((notification) =>
        notification._tag === "Event" && isOmpLiveFrame(notification.event.type)
          ? live.onFrame(notification.event.raw)
          : Effect.void,
      ),
      Effect.ignore,
      Effect.ensuring(live.onProcessEnded),
      Effect.forkScoped,
    );
    return {
      ...live.runtime,
      report: (text, final) =>
        client.command({ type: "live_report", text, final }).pipe(Effect.ignore),
    } satisfies ProviderLiveVoiceCall;
  },
);
