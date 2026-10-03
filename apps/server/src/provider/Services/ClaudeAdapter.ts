/**
 * ClaudeAdapter — shape type for the Claude provider adapter.
 *
 * Historically this module exposed a `Context.Service` tag so consumers
 * could inject the adapter through the Effect layer graph. The driver
 * model ({@link ../Drivers/ClaudeDriver}) bundles one adapter per
 * instance as a captured closure instead, so the tag is gone — we only
 * retain the shape interface as a naming anchor for the driver bundle.
 *
 * SCIENT-FORK:START — restored. The merge dropped this module (upstream
 * deleted the whole v1 `Services/*Adapter` anchor layer along with the v1
 * `ProviderAdapterShape`), but the fork's v1 `Layers/ClaudeAdapter.ts` and
 * the live `Layers/ProviderService.ts` turn engine still reference the v1
 * shape. Kept alongside `Services/DroidAdapter.ts` and
 * `Services/AntigravityAdapter.ts`, which survived the merge unchanged.
 * SCIENT-FORK:END
 *
 * @module ClaudeAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * ClaudeAdapterShape — per-instance Claude adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface ClaudeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
