import {
  ManagedProviderRuntime,
  type ManagedProviderRuntimeDependencies,
  type ManagedProviderRuntimeProgress,
  type ManagedProviderRuntimeStage,
  type ManagedProviderRuntimeState,
  type ManagedProviderRuntimeStatus,
} from "./managedProviderRuntime.ts";

export type ManagedPiRuntimeStage = ManagedProviderRuntimeStage;
export type ManagedPiRuntimeProgress = ManagedProviderRuntimeProgress;
export type ManagedPiRuntimeState = ManagedProviderRuntimeState;
export type ManagedPiRuntimeStatus = ManagedProviderRuntimeStatus;
export type ManagedPiRuntimeDependencies = ManagedProviderRuntimeDependencies;

export class ManagedPiRuntime extends ManagedProviderRuntime {
  constructor(baseDir: string, dependencies?: Partial<ManagedPiRuntimeDependencies>) {
    super(baseDir, { providerDirectory: "pi", displayName: "Pi" }, dependencies);
  }
}
