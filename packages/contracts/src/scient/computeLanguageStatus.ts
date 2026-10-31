import type {
  ComputeFoundTool,
  ComputeLanguageRuntimeInventory,
  ComputeManagedRuntimeStatus,
} from "../scientCompute.ts";
import { COMPUTE_RUN_TABLE } from "./computeRunTable.ts";
import type { ScientificComputingLanguageSettings } from "./scientificComputingSettings.ts";

export type ComputeSettingsInstallation = ComputeLanguageRuntimeInventory["installations"][number];

function runtimeSourceLabel(source: string): string {
  switch (source) {
    case "managed":
      return "Scient-managed";
    case "configured":
      return "Custom path";
    case "project":
      return "Project environment";
    case "path":
    case "conventional":
      return "System";
    default:
      return source;
  }
}

/** Where a runtime came from, as a user knows it: Homebrew, uv, conda: analysis. */
function runtimeOriginLabel(installation: ComputeSettingsInstallation): string {
  return installation.source === "managed"
    ? runtimeSourceLabel("managed")
    : (installation.origin ?? runtimeSourceLabel(installation.source));
}

/** Automatic is a selection policy, not an additional installation. */
export function automaticComputeRuntimeLabel(
  installation: ComputeSettingsInstallation | undefined,
): string {
  return installation ? `Automatic · ${runtimeOriginLabel(installation)}` : "Automatic";
}

/** Short picker label, with the shortest distinguishing directory suffix when needed. */
export function computeRuntimePickerLabel(
  installation: ComputeSettingsInstallation,
  languageName: string,
  installations: ReadonlyArray<ComputeSettingsInstallation> = [],
): string {
  const version = installation.version ?? languageName;
  const origin = runtimeOriginLabel(installation);
  // A kernel's display name usually repeats the language.
  const base =
    installation.version === null && languageName.includes(origin)
      ? languageName
      : `${version} · ${origin}`;
  const duplicates = installations.filter(
    (candidate) =>
      candidate.executable !== installation.executable &&
      (candidate.version ?? languageName) === version &&
      runtimeOriginLabel(candidate) === origin,
  );
  if (duplicates.length === 0) return base;
  const pathParts = installation.executable.split(/[\\/]/u).filter(Boolean);
  for (let length = 2; length <= pathParts.length; length++) {
    const suffix = pathParts.slice(-length).join("/");
    if (
      duplicates.every(
        (candidate) =>
          candidate.executable.split(/[\\/]/u).filter(Boolean).slice(-length).join("/") !== suffix,
      )
    )
      return `${base} · ${suffix}`;
  }
  return `${base} · ${installation.executable}`;
}

/** What Scient itself adds to run a language; the rest of each runtime is the user's own. */
export type ComputeScientPart = "managed-python" | "kernel" | "connection" | null;

export function computeScientPart(languageId: string): ComputeScientPart {
  if (languageId === "python" || languageId === "sql") return "managed-python";
  if (languageId === "r" || languageId === "julia") return "kernel";
  return languageId === "matlab" ? "connection" : null;
}

/** No runtime Scient can use here, and nothing Scient can install by itself. */
export function computeLanguageAbsent(language: ComputeLanguageRuntimeInventory): boolean {
  return (
    language.installations.length === 0 &&
    computeScientPart(language.descriptor.languageId) !== "managed-python"
  );
}

/** No session, no file route and nowhere to send anyone. A fact about Scient, not this computer. */
export function computeLanguageComingSoon(
  runtime: ComputeLanguageRuntimeInventory | undefined,
): boolean {
  return (
    runtime === undefined ||
    (computeLanguageAbsent(runtime) &&
      computeLanguageDownloadUrl(runtime) === undefined &&
      !COMPUTE_RUN_TABLE.some((route) => route.languageId === runtime.descriptor.languageId))
  );
}

export function managedFailureNeedsRepair(status: ComputeManagedRuntimeStatus): boolean {
  if (status.failure !== undefined && status.failure !== null) {
    return status.failure.action !== "remove";
  }
  return Boolean(status.failureMessage);
}

export function defaultComputeInstallation(
  language: ComputeLanguageRuntimeInventory,
  preference: ScientificComputingLanguageSettings,
  managed: ComputeManagedRuntimeStatus | null,
): ComputeSettingsInstallation | undefined {
  if (language.descriptor.languageId === "python" && managed?.selection === "managed") {
    return language.installations.find((installation) => installation.source === "managed");
  }
  const configured = preference.executable.trim();
  // SQL needs DuckDB, which Scient-managed Python carries, so it leads until a Python is chosen.
  const managedForSql =
    language.descriptor.languageId === "sql" && !configured
      ? language.installations.find((installation) => installation.source === "managed")
      : undefined;
  if (managedForSql) return managedForSql;
  if (configured) {
    return language.installations.find(
      (installation) =>
        installation.executable === configured ||
        (language.configuredExecutable === configured && installation.configured === true),
    );
  }
  // A settings save can arrive before the refreshed inventory. Its old explicit
  // candidate order must not be presented as the new automatic default.
  if (language.configuredExecutable?.trim()) return undefined;
  return language.installations.find((installation) => installation.source !== "managed");
}

export type ComputeCurrentRuntimeSummary = {
  readonly kind:
    | "disabled"
    | "ready"
    | "setup"
    | "connect"
    | "repair-connection"
    | "update-managed"
    | "repair-managed"
    | "unavailable"
    | "missing";
  readonly title: string;
  readonly detail: string;
};

/** One-line current runtime for the default Settings chrome. */
export function computeCurrentRuntimeSummary(input: {
  readonly language: ComputeLanguageRuntimeInventory;
  readonly preference: ScientificComputingLanguageSettings;
  readonly managed: ComputeManagedRuntimeStatus | null;
}): ComputeCurrentRuntimeSummary {
  const { language, preference, managed } = input;
  const isMatlab = language.descriptor.languageId === "matlab";
  const selected = defaultComputeInstallation(language, preference, managed);
  const source = selected === undefined ? null : runtimeSourceLabel(selected.source);
  const enabled = preference.enabled;

  if (!enabled) {
    return { kind: "disabled", title: "Off", detail: "" };
  }

  if (selected?.problem && selected.source === "managed") {
    return {
      kind: "repair-managed",
      title: selected.problem,
      detail: source ?? language.descriptor.displayName,
    };
  }
  if (
    selected?.source === "managed" &&
    managed?.installed === true &&
    managed.selection === "managed" &&
    managed.updateAvailable
  ) {
    return {
      kind: "update-managed",
      title: selected.version ?? "Scient-managed Python",
      detail: "Toolkit update available",
    };
  }
  if (selected?.problem) {
    return {
      kind: "unavailable",
      title: selected.problem,
      detail: source ?? language.descriptor.displayName,
    };
  }
  if (isMatlab && managed !== null && managedFailureNeedsRepair(managed)) {
    return {
      kind: "repair-connection",
      title: managed.failure?.summary ?? "MATLAB connection failed",
      detail: managed.failure?.detail ?? managed.failureMessage ?? "Repair the connection helper.",
    };
  }
  if (
    managed !== null &&
    managedFailureNeedsRepair(managed) &&
    (selected?.source === "managed" || selected === undefined)
  ) {
    return {
      kind: "repair-managed",
      title: managed.failure?.summary ?? "Scient-managed runtime needs repair",
      detail: "Scient-managed",
    };
  }
  if (isMatlab && managed !== null && !managed.installed && selected !== undefined) {
    return {
      kind: "connect",
      title: "Not connected",
      detail: "Connect Scient to this MATLAB installation.",
    };
  }
  if (
    selected !== undefined &&
    computeScientPart(language.descriptor.languageId) === "kernel" &&
    managed !== null &&
    !managed.installed &&
    managed.selection !== "existing"
  ) {
    return { kind: "setup", title: "Not set up", detail: "" };
  }
  if (selected !== undefined) {
    return {
      kind: "ready",
      title: selected.version ?? language.descriptor.displayName,
      detail: source ?? "Ready",
    };
  }
  if (isMatlab) {
    if (language.installations.length === 0) {
      return {
        kind: "missing",
        title: "Not connected",
        detail: "Requires a licensed MATLAB installation on this server.",
      };
    }
    return {
      kind: "connect",
      title: "Not connected",
      detail: "Connect the MATLAB already installed on this server.",
    };
  }
  return {
    kind: "setup",
    title: "Not set up",
    detail: "Set up Scientific Python or choose an existing runtime.",
  };
}

const LANGUAGE_DOWNLOADS: Readonly<Record<string, string>> = {
  matlab: "https://www.mathworks.com/products/matlab.html",
  r: "https://cloud.r-project.org/",
  julia: "https://julialang.org/install/",
};

/** Where to get a language that is not on this computer. */
export function computeLanguageDownloadUrl(
  language: ComputeLanguageRuntimeInventory,
): string | undefined {
  return language.descriptor.setup?.url ?? LANGUAGE_DOWNLOADS[language.descriptor.languageId];
}

/** The line under a language's name: what it runs on when ready, otherwise what it needs. */
export function computeLanguageDetail(
  language: ComputeLanguageRuntimeInventory,
  summary: ComputeCurrentRuntimeSummary,
  preference: ScientificComputingLanguageSettings,
  managed: ComputeManagedRuntimeStatus | null,
): string {
  switch (summary.kind) {
    case "disabled": {
      // Turning a language off says nothing about what is installed.
      const installed = defaultComputeInstallation(language, preference, managed);
      return installed === undefined
        ? "Off"
        : `${computeRuntimePickerLabel(installed, language.descriptor.displayName)} · Off`;
    }
    case "ready":
    case "update-managed": {
      // SQL's version would be its Python's. A kernel with no version has not been started yet.
      if (language.descriptor.languageId === "sql") return "Ready";
      const selected = defaultComputeInstallation(language, preference, managed);
      if (selected === undefined) return "Found";
      if (selected.version === null) {
        if (computeScientPart(language.descriptor.languageId) !== null)
          return runtimeOriginLabel(selected);
        const tool = language.tools?.[0];
        return tool === undefined
          ? "Kernel found"
          : computeToolDetail(tool, language.descriptor.displayName);
      }
      return computeRuntimePickerLabel(selected, language.descriptor.displayName);
    }
    case "setup": {
      // Run adds what is missing, so nothing has to happen before it.
      const selected = defaultComputeInstallation(language, preference, managed);
      return selected === undefined
        ? "Needs setup"
        : computeRuntimePickerLabel(selected, language.descriptor.displayName);
    }
    case "connect":
      return "Not connected";
    case "missing":
      return "Not found";
    default:
      return summary.title;
  }
}

/** What a scan found, in the words of its row: the name is left out when the language says it. */
function computeToolDetail(tool: ComputeFoundTool, languageName: string): string {
  const named = !languageName.toLowerCase().includes(tool.name.toLowerCase());
  return [tool.version, named ? tool.name : null, tool.origin ?? "System"]
    .filter((part) => part !== null)
    .join(" · ");
}

export interface ComputeLanguageStatus {
  readonly comingSoon: boolean;
  /** The line under the name, which stays empty when a language is simply not here. */
  readonly detail: string;
  /** Where to get what is missing. */
  readonly getUrl: string | undefined;
  /** Nothing is known yet, so a new look may answer. */
  readonly unknown: boolean;
}

/** One language's state, in the same words wherever it is shown. */
export function computeLanguageStatus(input: {
  readonly language: ComputeLanguageRuntimeInventory;
  readonly preference: ScientificComputingLanguageSettings;
  /** Some places were not read, so finding nothing proves nothing. */
  readonly incomplete: boolean;
}): ComputeLanguageStatus {
  const { language, preference, incomplete } = input;
  const comingSoon = computeLanguageComingSoon(language);
  const nothingToGet = { comingSoon, getUrl: undefined, unknown: false };
  if (!computeLanguageAbsent(language)) {
    const managed = language.managedRuntime;
    const summary = computeCurrentRuntimeSummary({ language, preference, managed });
    return {
      ...nothingToGet,
      detail: computeLanguageDetail(language, summary, preference, managed),
    };
  }
  const url = computeLanguageDownloadUrl(language);
  const tool = language.tools?.[0];
  if (tool !== undefined)
    return { ...nothingToGet, detail: computeToolDetail(tool, language.descriptor.displayName) };
  if (incomplete) return { comingSoon, detail: "Couldn't check", getUrl: undefined, unknown: true };
  return comingSoon
    ? { ...nothingToGet, detail: "" }
    : { comingSoon, detail: "Not found", getUrl: url, unknown: false };
}
