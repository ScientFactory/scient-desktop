/**
 * AntigravityAdapter — shape type for the Antigravity (`agy`) provider adapter.
 *
 * Antigravity uses agy's native persistent stream-json protocol.
 *
 * @module AntigravityAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

/**
 * AntigravityAdapterShape — per-instance Antigravity adapter contract.
 */
export interface AntigravityAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  /** Acquire before a lazy session can publish its first event. */
  readonly subscribeEvents: Effect.Effect<Stream.Stream<ProviderRuntimeEvent>, never, Scope.Scope>;
}
