import { useRef, useState } from "react";
import type {
  ComputeLanguageRuntimeInventory,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";
import type { ComputeManagedRuntimeController } from "./ComputeManagedRuntimeControls";
import { selectExistingComputeInstallation } from "./computeInstallationSettingsModel";

/** One serialized selection command for the picker, custom form and Forget path. */
export function useComputeInstallationSelection({
  language,
  preference,
  runtime,
  onChange,
  onRefresh,
  unavailable,
}: {
  language: ComputeLanguageRuntimeInventory;
  preference: ScientificComputingLanguageSettings;
  runtime: ComputeManagedRuntimeController;
  onChange: (next: ScientificComputingLanguageSettings) => Promise<boolean>;
  onRefresh: () => Promise<void>;
  unavailable: boolean;
}) {
  const lock = useRef(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const removing = runtime.status?.operation?.action === "remove";
  const select = async (executable: string | null): Promise<boolean> => {
    if (lock.current || removing || unavailable) return false;
    lock.current = true;
    setSelecting(true);
    setError(null);
    try {
      const managed = language.installations.find(
        (installation) => installation.source === "managed",
      );
      if (executable !== null && executable === managed?.executable) {
        if (!(await runtime.act("use-managed")))
          throw new Error("Scient-managed Python could not be selected. Try again.");
      } else {
        await selectExistingComputeInstallation({
          executable: executable ?? "",
          preference,
          releaseManaged:
            language.descriptor.languageId === "python" && runtime.status?.selection === "managed",
          save: onChange,
          useExisting: async () => {
            if (!(await runtime.act("use-existing")))
              throw new Error(
                "Scient-managed Python is still selected. Try switching again when its current operation finishes.",
              );
          },
        });
      }
      await onRefresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The installation could not be selected.");
      return false;
    } finally {
      lock.current = false;
      setSelecting(false);
    }
  };
  return { select, selecting, error, disabled: unavailable || selecting || removing };
}
