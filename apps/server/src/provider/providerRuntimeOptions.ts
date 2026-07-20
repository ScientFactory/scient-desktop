import type { ProviderKind, ProviderStartOptions } from "@synara/contracts";
import path from "node:path";

export function isScientManagedProviderExecutable(executable: string, stateDir: string): boolean {
  const managedRoot = path.resolve(stateDir, "provider-runtimes");
  const resolved = path.resolve(executable);
  const relative = path.relative(managedRoot, resolved);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function configuredProviderExecutable(
  provider: ProviderKind,
  providerOptions: ProviderStartOptions | undefined,
): string | undefined {
  return providerOptions?.[provider]?.binaryPath;
}

export function withResolvedProviderExecutable(
  provider: ProviderKind,
  providerOptions: ProviderStartOptions | undefined,
  executable: string,
): ProviderStartOptions {
  return {
    ...providerOptions,
    [provider]: {
      ...providerOptions?.[provider],
      binaryPath: executable,
    },
  };
}
