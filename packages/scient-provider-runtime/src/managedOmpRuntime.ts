import { ManagedProviderRuntime } from "./managedProviderRuntime.ts";

export class ManagedOmpRuntime extends ManagedProviderRuntime {
  constructor(
    baseDir: string,
    dependencies?: ConstructorParameters<typeof ManagedProviderRuntime>[2],
  ) {
    super(baseDir, { providerDirectory: "omp", displayName: "Oh My Pi" }, dependencies);
  }
}
