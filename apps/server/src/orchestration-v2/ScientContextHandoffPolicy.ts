import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  scientHandoffTokenCapOverride,
} from "./ContextHandoffBudget.ts";
import { handoffTokenCap } from "./scient-fork/context/handoffBudget.ts";

/** Explicit replay-fixture override; production chooses policy from canonical provenance. */
export class ContextHandoffPolicyOverride extends Context.Reference<"byte" | undefined>(
  "t3/orchestration-v2/ContextHandoffPolicyOverride",
  { defaultValue: () => undefined },
) {}

export const genericContextHandoffPolicy = handoffTokenCapConfig.pipe(
  Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
  Effect.map((tokenCap) => ({ tokenCap, bytesPerToken: 1, byteCap: 64_000 })),
);

/** Capture required settings once; read the latest Scient preset at final delivery. */
export const makeScientContextHandoffPolicy = Effect.fn("ScientContextHandoffPolicy.make")(
  function* () {
    const settings = yield* ServerSettingsService;
    return Effect.gen(function* () {
      const snapshot = yield* settings.getSettings;
      const override = yield* scientHandoffTokenCapOverride.pipe(
        Effect.orElseSucceed(() => Option.none<number>()),
      );
      return {
        tokenCap: handoffTokenCap(
          snapshot.scientFork.contextHandoffSize,
          Option.getOrUndefined(override),
        ),
        bytesPerToken: 3,
        byteCap: Infinity,
      };
    });
  },
);
