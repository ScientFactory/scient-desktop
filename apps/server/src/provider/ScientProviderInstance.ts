/**
 * App-owned extensions carried by live provider instances.
 *
 * The provider-core SPI stays provider-agnostic. Scient attaches lifecycle,
 * skill, and voice actions at the server boundary where their authority lives.
 */
import type {
  ProviderDriver,
  ProviderDriverCreateInput,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import type { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type {
  ProviderConnectionActions,
  ProviderManagedRuntimeActions,
  ProviderSkillActions,
  ProviderVoiceTranscriptCorrection,
} from "./ScientProviderInstanceSeams.ts";

export interface ScientProviderInstance extends ProviderInstance {
  readonly connectionActions?: ProviderConnectionActions | undefined;
  readonly managedRuntimeActions?: ProviderManagedRuntimeActions | undefined;
  readonly skillActions?: ProviderSkillActions | undefined;
  readonly voiceTranscriptCorrection?: ProviderVoiceTranscriptCorrection | undefined;
}

/** Driver SPI for server-owned implementations that expose Scient actions. */
export type ScientProviderDriver<Config, R = never> = Omit<ProviderDriver<Config, R>, "create"> & {
  readonly create: (
    input: ProviderDriverCreateInput<Config>,
  ) => Effect.Effect<ScientProviderInstance, ProviderDriverError, R | Scope.Scope>;
};
