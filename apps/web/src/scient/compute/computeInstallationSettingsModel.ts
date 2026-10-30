import type {
  ComputeLanguageRuntimeInventory,
  ComputeManagedRuntimeAction,
  ComputeManagedRuntimeStatus,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";

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
  const base = version === origin ? origin : `${version} · ${origin}`;
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

/** Not on this computer, and nothing Scient can install by itself. */
export function computeLanguageAbsent(language: ComputeLanguageRuntimeInventory): boolean {
  return (
    language.installations.length === 0 &&
    computeScientPart(language.descriptor.languageId) !== "managed-python"
  );
}

export type ComputeManagedPrimaryAction = Extract<
  ComputeManagedRuntimeAction,
  "install" | "repair" | "use-managed"
>;

function managedFailureNeedsRepair(status: ComputeManagedRuntimeStatus): boolean {
  if (status.failure !== undefined && status.failure !== null) {
    return status.failure.action !== "remove";
  }
  return Boolean(status.failureMessage);
}

/** Resolve the primary setup action from ownership and status, never from UI copy. */
export function computeManagedPrimaryAction(
  status: ComputeManagedRuntimeStatus | null,
): ComputeManagedPrimaryAction {
  if (!status?.installed) return "install";
  if (managedFailureNeedsRepair(status)) return "repair";
  return "use-managed";
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

/** The one word under a language's name: its version when ready, otherwise what it needs. */
export function computeLanguageListDetail(
  language: ComputeLanguageRuntimeInventory,
  summary: ComputeCurrentRuntimeSummary,
): string {
  switch (summary.kind) {
    case "disabled":
      return "Off";
    case "ready":
    case "update-managed":
      // SQL's version would be its Python's. A kernel with no version has not been started yet.
      if (language.descriptor.languageId === "sql") return "Ready";
      return summary.title === language.descriptor.displayName ? "Found" : summary.title;
    case "setup":
      return "Set up";
    case "connect":
      return "Connect";
    case "missing":
      return "Not installed";
    default:
      return "Problem";
  }
}

/** The MATLAB helper was built for a different installation than the one selected. */
export function computeConnectionNeedsRetarget(
  managed: ComputeManagedRuntimeStatus | null,
  selected: ComputeSettingsInstallation | undefined,
): boolean {
  return (
    managed?.installed === true &&
    managed.installationExecutable !== undefined &&
    selected !== undefined &&
    managed.installationExecutable !== selected.executable
  );
}

export interface ComputeLanguagePrimaryAction {
  readonly label: string;
  /** "setup" installs what the language needs, keeping any Python already chosen. */
  readonly run: "setup" | ComputeManagedRuntimeAction;
  readonly emphasis: boolean;
}

/** The single action a language needs now, most urgent first. */
export function computeLanguagePrimaryAction(input: {
  readonly language: ComputeLanguageRuntimeInventory;
  readonly summary: ComputeCurrentRuntimeSummary;
  readonly managed: ComputeManagedRuntimeStatus | null;
  readonly selected: ComputeSettingsInstallation | undefined;
  readonly failureRetry: ComputeManagedRuntimeAction | null | undefined;
}): ComputeLanguagePrimaryAction | null {
  const { language, summary, managed, selected, failureRetry } = input;
  const part = computeScientPart(language.descriptor.languageId);
  const isMatlab = part === "connection";
  if (
    isMatlab &&
    managed?.selection === "managed" &&
    computeConnectionNeedsRetarget(managed, selected)
  ) {
    return { label: "Set up connection", run: "repair", emphasis: false };
  }
  const connectionFailed = isMatlab && failureRetry != null && failureRetry !== "remove";
  if (summary.kind === "repair-connection" || connectionFailed) {
    return {
      label: "Repair connection",
      run: connectionFailed && failureRetry === "install" ? "install" : "repair",
      emphasis: false,
    };
  }
  if (isMatlab && summary.kind === "connect") {
    return { label: "Connect MATLAB", run: "setup", emphasis: false };
  }
  if ((part === "managed-python" && !managed?.installed) || summary.kind === "setup") {
    return { label: "Set up", run: "setup", emphasis: false };
  }
  if (
    summary.kind === "repair-managed" ||
    (part === "managed-python" && computeManagedPrimaryAction(managed) === "repair")
  ) {
    return { label: "Repair", run: "repair", emphasis: false };
  }
  // Maintenance belongs to the installed capability, not the selected runtime.
  // For MATLAB this updates Scient's helper, never the user's MATLAB installation.
  return managed?.installed && managed.updateAvailable
    ? { label: "Update", run: "update", emphasis: true }
    : null;
}

/** Save the requested path before releasing managed precedence. A failed save
 * must leave the current default intact; a failed release is surfaced for retry. */
export async function selectExistingComputeInstallation(input: {
  executable: string;
  preference: ScientificComputingLanguageSettings;
  releaseManaged: boolean;
  save: (preference: ScientificComputingLanguageSettings) => Promise<boolean>;
  useExisting: () => Promise<void>;
}): Promise<void> {
  const saved = await input.save({ ...input.preference, executable: input.executable.trim() });
  if (!saved) throw new Error("The installation could not be selected. Settings were not saved.");
  if (input.releaseManaged) await input.useExisting();
}
