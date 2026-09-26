import type { ProviderDriverKind, ProviderSession } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";

/**
 * Whether restarting a provider's shared runtime would interrupt work: a
 * session starting or running a turn, or a settled turn whose background work
 * (subagent fleets, workflow runs, Monitor loops) still runs inside the
 * provider process. When activity cannot be read, the provider counts as busy.
 */
export interface ProviderActivityShape {
  readonly isBusy: (provider: ProviderDriverKind) => Effect.Effect<boolean>;
}

export class ProviderActivity extends Context.Service<ProviderActivity, ProviderActivityShape>()(
  "t3/scient/providerLifecycle/ProviderActivity",
) {}

function isWorkingSession(session: ProviderSession): boolean {
  return (
    session.status === "connecting" ||
    session.status === "running" ||
    session.activeTurnId !== undefined
  );
}

export const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const directory = yield* ProviderSessionDirectory;
  const snapshots = yield* ProjectionSnapshotQuery;

  const isBusy: ProviderActivityShape["isBusy"] = Effect.fn("ProviderActivity.isBusy")(
    function* (provider) {
      const sessions = yield* providerService.listSessions();
      if (sessions.some((session) => session.provider === provider && isWorkingSession(session))) {
        return true;
      }
      const bindings = yield* directory.listBindings({ excludeStopped: true });
      for (const binding of bindings) {
        if (binding.provider !== provider) continue;
        const thread = Option.getOrUndefined(yield* snapshots.getThreadShellById(binding.threadId));
        if (thread?.session?.activeTurnId != null || thread?.backgroundLiveness != null) {
          return true;
        }
      }
      return false;
    },
    (effect, provider) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider activity could not be read; treating it as busy", {
            provider,
            cause,
          }).pipe(Effect.as(true)),
        ),
      ),
  );

  return ProviderActivity.of({ isBusy });
});

export const layer = Layer.effect(ProviderActivity, make);
