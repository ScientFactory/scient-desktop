import {
  COMPUTE_RUN_TABLE,
  computeLanguageStatus,
  defaultComputeInstallation,
  type ComputeLanguageRuntimeInventory,
  type ComputeRuntimeInspection,
  type ComputeRuntimeInventory,
} from "@t3tools/contracts";

import type { ComputeToolInventory, ComputeToolLanguage, ComputeToolRuntime } from "./tools.ts";

const toRuntime = (
  executable: string,
  version: string | null,
  origin: string | null,
  problem?: string | null,
): ComputeToolRuntime => ({
  executable,
  version,
  origin,
  ...(problem ? { problem } : {}),
});

function runtimesOf(
  language: ComputeLanguageRuntimeInventory,
  inspected: ComputeRuntimeInspection["languages"][number] | undefined,
): ReadonlyArray<ComputeToolRuntime> {
  const rows = [
    ...(inspected?.runtimes ?? []).map(({ profile, verification }) =>
      toRuntime(
        profile.executable,
        profile.languageVersion === "unknown" ? null : profile.languageVersion,
        profile.origin ?? profile.source,
        verification.readiness === "ready" ? null : verification.message,
      ),
    ),
    ...language.installations.map((installation) =>
      toRuntime(
        installation.executable,
        installation.version,
        installation.origin ?? installation.source,
        installation.problem,
      ),
    ),
    ...(language.tools ?? []).map((tool) =>
      toRuntime(tool.executable, tool.version, tool.origin, tool.problem),
    ),
  ];
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(row.executable) && seen.add(row.executable));
}

function defaultRuntime(
  language: ComputeLanguageRuntimeInventory,
  inspected: ComputeRuntimeInspection["languages"][number] | undefined,
): string | null {
  const chosen = inspected?.selection?.executable;
  if (chosen) return chosen;
  const preference = { executable: language.configuredExecutable ?? "" };
  return (
    defaultComputeInstallation(language, preference, language.managedRuntime)?.executable ?? null
  );
}

function summarize(
  language: ComputeLanguageRuntimeInventory,
  inspected: ComputeRuntimeInspection["languages"][number] | undefined,
  incomplete: boolean,
): ComputeToolLanguage | null {
  const preference = { executable: language.configuredExecutable ?? "" };
  const status = computeLanguageStatus({ language, preference, incomplete });
  const runtimes = runtimesOf(language, inspected);
  const runnable = language.descriptor.capabilities.length > 0 && !status.comingSoon;
  if (runtimes.length === 0 && !runnable) return null;
  return {
    language: language.descriptor.languageId,
    name: language.descriptor.displayName,
    status: status.detail,
    use: runnable
      ? "scient_compute_run"
      : COMPUTE_RUN_TABLE.some((route) => route.languageId === language.descriptor.languageId)
        ? "scient_compute_run_file"
        : "shell",
    default: defaultRuntime(language, inspected),
    runtimes,
    ...(language.toolkits.length === 0
      ? {}
      : { toolkits: language.toolkits.map((toolkit) => toolkit.displayName) }),
  };
}

/** The facts Settings shows, compact: found or runnable languages in full, the rest by name. */
export function inventorySummary(
  inventory: ComputeRuntimeInventory,
  inspection: ComputeRuntimeInspection,
): ComputeToolInventory {
  const inspected = new Map(
    inspection.languages.map((language) => [language.descriptor.languageId, language]),
  );
  const incomplete = inventory.incomplete === true;
  const languages: ComputeToolLanguage[] = [];
  const notFound: string[] = [];
  for (const language of inventory.languages) {
    const row = summarize(language, inspected.get(language.descriptor.languageId), incomplete);
    if (row === null) notFound.push(language.descriptor.displayName);
    else languages.push(row);
  }
  return { languages, notFound, ...(incomplete ? { incomplete } : {}) };
}
