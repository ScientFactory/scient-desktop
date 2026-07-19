/**
 * ProviderRuntimeManager - installs and resolves app-owned provider executables.
 *
 * The manager never mutates user-managed provider installations or shell PATH
 * configuration. Managed release directories are added only to this server
 * process after verified activation.
 */
import type {
  ProviderKind,
  ServerProviderInstallCancelInput,
  ServerProviderInstallInput,
  ServerProviderInstallPlan,
  ServerProviderInstallationError,
  ServerProviderRuntimeMutationInput,
  ServerProviderRuntimeSource,
} from "@synara/contracts";
import type { Effect, Stream } from "effect";
import { ServiceMap } from "effect";

import type { ProviderRuntimeSnapshot } from "../providerRuntimeTypes";

export interface ResolvedProviderRuntime {
  readonly source: ServerProviderRuntimeSource;
  readonly executable: string | null;
  readonly managedVersion: string | null;
  readonly canInstall: boolean;
  readonly canRepair: boolean;
  readonly canRollback: boolean;
  readonly canRemove: boolean;
  readonly message: string | null;
}

export interface ProviderRuntimeManagerShape {
  readonly prepareInstall: (
    provider: ProviderKind,
  ) => Effect.Effect<ServerProviderInstallPlan, ServerProviderInstallationError>;
  readonly install: (
    input: ServerProviderInstallInput,
  ) => Effect.Effect<void, ServerProviderInstallationError>;
  readonly cancel: (
    input: ServerProviderInstallCancelInput,
  ) => Effect.Effect<void, ServerProviderInstallationError>;
  readonly repair: (
    input: ServerProviderRuntimeMutationInput,
  ) => Effect.Effect<void, ServerProviderInstallationError>;
  readonly rollback: (
    input: ServerProviderRuntimeMutationInput,
  ) => Effect.Effect<void, ServerProviderInstallationError>;
  readonly remove: (
    input: ServerProviderRuntimeMutationInput,
  ) => Effect.Effect<void, ServerProviderInstallationError>;
  readonly getSnapshot: (provider: ProviderKind) => Effect.Effect<ProviderRuntimeSnapshot>;
  readonly resolve: (
    provider: ProviderKind,
    configuredExecutable?: string | null,
  ) => Effect.Effect<ResolvedProviderRuntime>;
  readonly streamChanges: Stream.Stream<ReadonlyMap<ProviderKind, ProviderRuntimeSnapshot>>;
}

export class ProviderRuntimeManager extends ServiceMap.Service<
  ProviderRuntimeManager,
  ProviderRuntimeManagerShape
>()("synara/provider/Services/ProviderRuntimeManager") {}
