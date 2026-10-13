import {
  ManagedProviderRuntime,
  type ManagedProviderRuntimeDependencies,
} from "./managedProviderRuntime.ts";

export class ManagedMuseRuntime extends ManagedProviderRuntime {
  constructor(baseDir: string, dependencies?: Partial<ManagedProviderRuntimeDependencies>) {
    super(baseDir, { providerDirectory: "muse", displayName: "Muse Code" }, dependencies);
  }
}
