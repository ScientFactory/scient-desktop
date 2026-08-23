/**
 * AntigravityAdapter — shape type for the Antigravity (`agy`) provider adapter.
 *
 * Antigravity uses agy's native persistent stream-json protocol.
 *
 * @module AntigravityAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * AntigravityAdapterShape — per-instance Antigravity adapter contract.
 */
export interface AntigravityAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
