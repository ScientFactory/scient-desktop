import {
  ManagedProviderRuntime,
  type ManagedProviderRuntimeDependencies,
  type ManagedProviderRuntimeProgress,
  type ManagedProviderRuntimeStage,
  type ManagedProviderRuntimeState,
  type ManagedProviderRuntimeStatus,
} from "./managedProviderRuntime.ts";

export type ManagedDroidRuntimeStage = ManagedProviderRuntimeStage;
export type ManagedDroidRuntimeProgress = ManagedProviderRuntimeProgress;
export type ManagedDroidRuntimeState = ManagedProviderRuntimeState;
export type ManagedDroidRuntimeStatus = ManagedProviderRuntimeStatus;
export type ManagedDroidRuntimeDependencies = ManagedProviderRuntimeDependencies;

export class ManagedDroidRuntime extends ManagedProviderRuntime {
  constructor(baseDir: string, dependencies?: Partial<ManagedDroidRuntimeDependencies>) {
    super(baseDir, { providerDirectory: "droid", displayName: "Droid" }, dependencies);
  }
}
