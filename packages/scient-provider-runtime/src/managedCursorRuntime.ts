import {
  ManagedProviderRuntime,
  type ManagedProviderRuntimeDependencies,
  type ManagedProviderRuntimeProgress,
  type ManagedProviderRuntimeStage,
  type ManagedProviderRuntimeState,
  type ManagedProviderRuntimeStatus,
} from "./managedProviderRuntime.ts";

export type ManagedCursorRuntimeStage = ManagedProviderRuntimeStage;
export type ManagedCursorRuntimeProgress = ManagedProviderRuntimeProgress;
export type ManagedCursorRuntimeState = ManagedProviderRuntimeState;
export type ManagedCursorRuntimeStatus = ManagedProviderRuntimeStatus;
export type ManagedCursorRuntimeDependencies = ManagedProviderRuntimeDependencies;

export class ManagedCursorRuntime extends ManagedProviderRuntime {
  constructor(baseDir: string, dependencies?: Partial<ManagedCursorRuntimeDependencies>) {
    super(baseDir, { providerDirectory: "cursor", displayName: "Cursor" }, dependencies);
  }
}
