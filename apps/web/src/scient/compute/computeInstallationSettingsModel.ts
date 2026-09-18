import type {
  ComputeLanguageRuntimeInventory,
  ComputeManagedRuntimeAction,
  ComputeManagedRuntimeStatus,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";

export type ComputeSettingsInstallation = ComputeLanguageRuntimeInventory["installations"][number];

export function runtimeSourceLabel(source: string): string {
  switch (source) {
    case "managed":
      return "Scient-managed";
    case "configured":
      return "Custom installation";
    case "project":
      return "Project environment";
    case "path":
    case "conventional":
      return "System installation";
    default:
      return source;
  }
}

/** Automatic is a selection policy, not an additional installation. */
export function automaticComputeRuntimeLabel(
  installation: ComputeSettingsInstallation | undefined,
): string {
  if (!installation) return "Automatic";
  const source =
    installation.source === "path" || installation.source === "conventional"
      ? "System"
      : runtimeSourceLabel(installation.source);
  return `Automatic · ${source}`;
}

/** Short picker label, with the shortest distinguishing directory suffix when needed. */
export function computeRuntimePickerLabel(
  installation: ComputeSettingsInstallation,
  languageName: string,
  installations: ReadonlyArray<ComputeSettingsInstallation> = [],
): string {
  const base = `${installation.version ?? languageName} · ${runtimeSourceLabel(installation.source)}`;
  const duplicates = installations.filter(
    (candidate) =>
      candidate.executable !== installation.executable &&
      (candidate.version ?? languageName) === (installation.version ?? languageName) &&
      runtimeSourceLabel(candidate.source) === runtimeSourceLabel(installation.source),
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
  if (selected !== undefined && enabled) {
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
