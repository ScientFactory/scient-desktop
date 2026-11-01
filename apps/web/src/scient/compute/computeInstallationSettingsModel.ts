import {
  COMPUTE_LANGUAGE_CATALOG,
  computeLanguageAbsent,
  computeScientPart,
  managedFailureNeedsRepair,
  type ComputeCatalogLanguage,
  type ComputeCurrentRuntimeSummary,
  type ComputeLanguageRuntimeInventory,
  type ComputeManagedRuntimeAction,
  type ComputeManagedRuntimeStatus,
  type ComputeSettingsInstallation,
  type ScientificComputingLanguageSettings,
} from "@t3tools/contracts";

export {
  automaticComputeRuntimeLabel,
  computeCurrentRuntimeSummary,
  computeLanguageAbsent,
  computeLanguageComingSoon,
  computeLanguageDetail,
  computeLanguageDownloadUrl,
  computeLanguageStatus,
  computeRuntimePickerLabel,
  computeScientPart,
  defaultComputeInstallation,
  type ComputeCurrentRuntimeSummary,
  type ComputeScientPart,
  type ComputeSettingsInstallation,
} from "@t3tools/contracts";

export interface ComputeLanguageEntry extends ComputeCatalogLanguage {
  /** What this computer reports. Nothing, for a language no kernel here has named. */
  readonly runtime: ComputeLanguageRuntimeInventory | undefined;
}

export interface ComputeLanguageGroup {
  readonly title: string;
  readonly entries: ReadonlyArray<ComputeLanguageEntry>;
}

const CATALOG_IDS: ReadonlySet<string> = new Set(
  COMPUTE_LANGUAGE_CATALOG.flatMap((group) =>
    group.languages.map((language) => language.languageId),
  ),
);

const onThisComputer = (runtime: ComputeLanguageRuntimeInventory | undefined) =>
  runtime !== undefined && (!computeLanguageAbsent(runtime) || (runtime.tools?.length ?? 0) > 0);

/** Every language in its one place, with what is on this computer leading each group. */
export function computeLanguageGroups(
  languages: ReadonlyArray<ComputeLanguageRuntimeInventory>,
): ReadonlyArray<ComputeLanguageGroup> {
  const reported = new Map<string, ComputeLanguageRuntimeInventory>(
    languages.map((language) => [language.descriptor.languageId, language]),
  );
  const groups = COMPUTE_LANGUAGE_CATALOG.map(({ title, languages: named }) => ({
    title,
    entries: named
      .map((language) => ({ ...language, runtime: reported.get(language.languageId) }))
      .toSorted((a, b) => Number(onThisComputer(b.runtime)) - Number(onThisComputer(a.runtime))),
  }));
  // A kernel the catalog does not name is real while it is here, and promises nothing once gone.
  const other = languages.filter(
    (language) =>
      !CATALOG_IDS.has(language.descriptor.languageId) && !computeLanguageAbsent(language),
  );
  return other.length === 0
    ? groups
    : [
        ...groups,
        {
          title: "Other",
          entries: other.map((runtime) => ({
            languageId: runtime.descriptor.languageId,
            name: runtime.descriptor.displayName,
            runtime,
          })),
        },
      ];
}

export type ComputeManagedPrimaryAction = Extract<
  ComputeManagedRuntimeAction,
  "install" | "repair" | "use-managed"
>;

/** Resolve the primary setup action from ownership and status, never from UI copy. */
export function computeManagedPrimaryAction(
  status: ComputeManagedRuntimeStatus | null,
): ComputeManagedPrimaryAction {
  if (!status?.installed) return "install";
  if (managedFailureNeedsRepair(status)) return "repair";
  return "use-managed";
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
