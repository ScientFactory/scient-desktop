import {
  ManagedProviderRuntime,
  type ManagedProviderRuntimeDependencies,
  type ManagedProviderRuntimeProgress,
  type ManagedProviderRuntimeStage,
  type ManagedProviderRuntimeState,
  type ManagedProviderRuntimeStatus,
} from "./managedProviderRuntime.ts";

export type ManagedAntigravityRuntimeStage = ManagedProviderRuntimeStage;
export type ManagedAntigravityRuntimeProgress = ManagedProviderRuntimeProgress;
export type ManagedAntigravityRuntimeState = ManagedProviderRuntimeState;
export type ManagedAntigravityRuntimeStatus = ManagedProviderRuntimeStatus;
export type ManagedAntigravityRuntimeDependencies = ManagedProviderRuntimeDependencies;

export class ManagedAntigravityRuntime extends ManagedProviderRuntime {
  constructor(baseDir: string, dependencies?: Partial<ManagedAntigravityRuntimeDependencies>) {
    super(baseDir, { providerDirectory: "antigravity", displayName: "Antigravity" }, dependencies);
  }
}
