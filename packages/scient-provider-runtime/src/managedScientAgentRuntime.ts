import { ManagedProviderRuntime } from "./managedProviderRuntime.ts";

export class ManagedScientAgentRuntime extends ManagedProviderRuntime {
  constructor(
    baseDir: string,
    dependencies?: ConstructorParameters<typeof ManagedProviderRuntime>[2],
  ) {
    super(
      baseDir,
      { providerDirectory: "scient-agent", displayName: "Scient Agent" },
      dependencies,
    );
  }
}
