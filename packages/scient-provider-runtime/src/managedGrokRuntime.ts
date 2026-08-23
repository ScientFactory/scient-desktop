import {
  ManagedProviderRuntime,
  type ManagedProviderRuntimeDependencies,
  type ManagedProviderRuntimeProgress,
  type ManagedProviderRuntimeStage,
  type ManagedProviderRuntimeState,
  type ManagedProviderRuntimeStatus,
} from "./managedProviderRuntime.ts";

export type ManagedGrokRuntimeStage = ManagedProviderRuntimeStage;
export type ManagedGrokRuntimeProgress = ManagedProviderRuntimeProgress;
export type ManagedGrokRuntimeState = ManagedProviderRuntimeState;
export type ManagedGrokRuntimeStatus = ManagedProviderRuntimeStatus;
export type ManagedGrokRuntimeDependencies = ManagedProviderRuntimeDependencies;

export class ManagedGrokRuntime extends ManagedProviderRuntime {
  constructor(baseDir: string, dependencies?: Partial<ManagedGrokRuntimeDependencies>) {
    super(baseDir, { providerDirectory: "grok", displayName: "Grok" }, dependencies);
  }
}
