/**
 * GrokAdapter — shape type for the Grok provider adapter.
 *
 * The driver model ({@link ../Drivers/GrokDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * SCIENT-FORK:START — restored; see `Services/ClaudeAdapter.ts` for why the
 * v1 anchor layer survives the merge.
 * SCIENT-FORK:END
 *
 * @module GrokAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * GrokAdapterShape — per-instance Grok adapter contract.
 */
export interface GrokAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
