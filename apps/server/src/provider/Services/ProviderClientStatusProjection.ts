/**
 * Canonical client-facing provider status projection.
 *
 * ProviderHealth owns lightweight health snapshots. This service is the only
 * path that combines those snapshots with runtime/install capabilities before
 * they cross an RPC or subscription boundary.
 */
import type { ServerProviderClientStatus, ServerProviderStatus } from "@synara/contracts";
import type { Effect, Stream } from "effect";
import { ServiceMap } from "effect";

export interface ProviderClientStatusProjectionShape {
  readonly project: (
    statuses: ReadonlyArray<ServerProviderStatus>,
  ) => Effect.Effect<ReadonlyArray<ServerProviderClientStatus>>;
  readonly getStatuses: Effect.Effect<ReadonlyArray<ServerProviderClientStatus>>;
  readonly refreshStatuses: Effect.Effect<ReadonlyArray<ServerProviderClientStatus>>;
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProviderClientStatus>>;
}

export class ProviderClientStatusProjection extends ServiceMap.Service<
  ProviderClientStatusProjection,
  ProviderClientStatusProjectionShape
>()("synara/provider/Services/ProviderClientStatusProjection") {}
