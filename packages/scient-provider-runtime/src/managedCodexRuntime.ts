import {
  ManagedProviderRuntime,
  ManagedProviderRuntimeError,
  type ManagedProviderRuntimeDependencies,
  type ManagedProviderRuntimeProgress,
  type ManagedProviderRuntimeStage,
  type ManagedProviderRuntimeState,
  type ManagedProviderRuntimeStatus,
} from "./managedProviderRuntime.ts";

export type ManagedCodexRuntimeStage = ManagedProviderRuntimeStage;
export type ManagedCodexRuntimeProgress = ManagedProviderRuntimeProgress;
export type ManagedCodexRuntimeState = ManagedProviderRuntimeState;
export type ManagedCodexRuntimeStatus = ManagedProviderRuntimeStatus;
export type ManagedCodexRuntimeDependencies = ManagedProviderRuntimeDependencies;
export const ManagedCodexRuntimeError = ManagedProviderRuntimeError;
export type ManagedCodexRuntimeError = ManagedProviderRuntimeError;

export class ManagedCodexRuntime extends ManagedProviderRuntime {
  constructor(baseDir: string, dependencies?: Partial<ManagedCodexRuntimeDependencies>) {
    super(baseDir, { providerDirectory: "codex", displayName: "Codex" }, dependencies);
  }
}
