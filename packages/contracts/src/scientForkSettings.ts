/**
 * Conversation-fork preferences.
 *
 * SCIENT-OWNED. A fork (or a provider session that lost its history) receives
 * the retained conversation as a portable handoff. Its size follows upstream
 * Orchestration V2's budget formula and is always bounded by the model's
 * context window; this preference only chooses how much of that room to use.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ForkContextHandoffSize = Schema.Literals(["compact", "standard", "large", "maximum"]);
export type ForkContextHandoffSize = typeof ForkContextHandoffSize.Type;

export const DEFAULT_FORK_CONTEXT_HANDOFF_SIZE: ForkContextHandoffSize = "standard";

/**
 * Estimated-token caps per preset. `null` means "whatever the model window
 * formula allows". Compact matches upstream V2's default cap.
 */
export const FORK_CONTEXT_HANDOFF_TOKEN_CAPS: Readonly<
  Record<ForkContextHandoffSize, number | null>
> = {
  compact: 16_000,
  standard: 64_000,
  large: 128_000,
  maximum: null,
};

export const ScientForkSettings = Schema.Struct({
  contextHandoffSize: ForkContextHandoffSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_FORK_CONTEXT_HANDOFF_SIZE)),
  ),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type ScientForkSettings = typeof ScientForkSettings.Type;

export const ScientForkSettingsPatch = Schema.Struct({
  contextHandoffSize: Schema.optionalKey(ForkContextHandoffSize),
});
export type ScientForkSettingsPatch = typeof ScientForkSettingsPatch.Type;
