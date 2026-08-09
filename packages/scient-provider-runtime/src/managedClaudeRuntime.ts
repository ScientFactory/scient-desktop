import {
  ManagedProviderRuntime,
  type ManagedProviderRuntimeDependencies,
  type ManagedProviderRuntimeProgress,
  type ManagedProviderRuntimeStage,
  type ManagedProviderRuntimeState,
  type ManagedProviderRuntimeStatus,
} from "./managedProviderRuntime.ts";

export type ManagedClaudeRuntimeStage = ManagedProviderRuntimeStage;
export type ManagedClaudeRuntimeProgress = ManagedProviderRuntimeProgress;
export type ManagedClaudeRuntimeState = ManagedProviderRuntimeState;
export type ManagedClaudeRuntimeStatus = ManagedProviderRuntimeStatus;
export type ManagedClaudeRuntimeDependencies = ManagedProviderRuntimeDependencies;

export class ManagedClaudeRuntime extends ManagedProviderRuntime {
  constructor(baseDir: string, dependencies?: Partial<ManagedClaudeRuntimeDependencies>) {
    super(baseDir, { providerDirectory: "claude", displayName: "Claude" }, dependencies);
  }
}
