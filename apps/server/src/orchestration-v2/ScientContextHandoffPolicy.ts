import { FORK_CONTEXT_HANDOFF_TOKEN_CAPS } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ServerSettingsService } from "../serverSettings.ts";
import { DEFAULT_HANDOFF_TOKEN_CAP, handoffTokenCapConfig } from "./ContextHandoffBudget.ts";

/** Read the latest Scient preset for each handoff, including changes after runtime startup. */
export const makeScientContextHandoffPolicy = Effect.fn("ScientContextHandoffPolicy.make")(
  function* () {
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    return Effect.gen(function* () {
      const snapshot = Option.isSome(settings)
        ? yield* Effect.result(settings.value.getSettings)
        : undefined;
      if (snapshot === undefined || Result.isFailure(snapshot)) {
        return {
          tokenCap: yield* handoffTokenCapConfig.pipe(
            Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
          ),
          bytesPerToken: 1,
          byteCap: 64_000,
        };
      }
      const override = yield* Config.option(Config.Int("T3CODE_CONTEXT_HANDOFF_TOKEN_CAP")).pipe(
        Effect.orElseSucceed(() => Option.none<number>()),
      );
      return {
        tokenCap: Option.isSome(override)
          ? Math.max(1_024, override.value)
          : FORK_CONTEXT_HANDOFF_TOKEN_CAPS[snapshot.success.scientFork.contextHandoffSize],
        bytesPerToken: 3,
        byteCap: Infinity,
      };
    });
  },
);

export const preparationHistoryBudget = (policy: {
  readonly tokenCap: number | null;
  readonly bytesPerToken: number;
  readonly byteCap: number;
}) => Math.min(policy.byteCap, (policy.tokenCap ?? Infinity) * policy.bytesPerToken);
