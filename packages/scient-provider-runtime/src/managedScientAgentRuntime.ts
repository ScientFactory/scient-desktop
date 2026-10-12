import { ManagedProviderRuntime } from "./managedProviderRuntime.ts";
import { downloadManagedRuntime } from "./runtimeFiles.ts";

/** Scient's download policy is shared by its public runtime and the qualified app factory. */
export function downloadManagedScientAgentRuntime(
  input: Parameters<typeof downloadManagedRuntime>[0],
) {
  return downloadManagedRuntime({ ...input, retryTransientResponses: true });
}

export class ManagedScientAgentRuntime extends ManagedProviderRuntime {
  constructor(
    baseDir: string,
    dependencies?: ConstructorParameters<typeof ManagedProviderRuntime>[2],
  ) {
    super(
      baseDir,
      { providerDirectory: "scient-agent", displayName: "Scient Agent" },
      {
        ...dependencies,
        download: dependencies?.download ?? downloadManagedScientAgentRuntime,
      },
    );
  }
}
