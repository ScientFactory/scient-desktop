/**
 * Durable starts run after admission, so recheck provider enablement before opening a fresh
 * session. A disabled instance must settle with a nonretryable error; rollback, connection, and
 * shutdown opens remain ungated.
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
