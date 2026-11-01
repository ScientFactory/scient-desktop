import type { ProviderDriverKind } from "../providerInstance.ts";

export function supportsNativeSubagentStop(driver: ProviderDriverKind | undefined): boolean {
  return driver === "claudeAgent" || driver === "omp" || driver === "scient";
}
