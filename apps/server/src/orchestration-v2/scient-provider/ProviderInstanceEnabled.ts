/**
 * Admission rejects a message for a provider that is turned off, but a start
 * runs later, from a durable effect. If settings turn the provider off in
 * between, the fresh session would still open, because adapter lookup returns
 * the instance whether or not it is enabled. A fresh session therefore checks
 * the current instance again, and the start settles at once with a clear error
 * instead of retrying: only turning the provider back on can help.
 */
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";

export class ProviderInstanceDisabledError extends Schema.TaggedError<ProviderInstanceDisabledError>()(
  "ProviderInstanceDisabledError",
  { instanceId: ProviderInstanceId },
) {
  override get message(): string {
    return "This provider is turned off. Turn it on in Settings, then send the message again.";
  }
}

const isProviderInstanceDisabledError = Schema.is(ProviderInstanceDisabledError);

/** Fails when the registry reports the instance as turned off. Lookup failures are left to the open. */
export const requireEnabledProviderInstance = (
  registry: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape,
  instanceId: ProviderInstanceId,
) =>
  registry.getMetadata === undefined
    ? Effect.void
    : registry.getMetadata(instanceId).pipe(
        Effect.option,
        Effect.flatMap((metadata) =>
          Option.isSome(metadata) && !metadata.value.enabled
            ? Effect.fail(new ProviderInstanceDisabledError({ instanceId }))
            : Effect.void,
        ),
      );

/** A session open refused because its provider is turned off. */
export const isProviderInstanceDisabledOpen = (failure: {
  readonly _tag: string;
  readonly cause?: unknown;
}): boolean =>
  failure._tag === "ProviderSessionOpenError" && isProviderInstanceDisabledError(failure.cause);
