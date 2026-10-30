import {
  ComputeExecutionId,
  type ComputeExecutionRecord,
  type ComputeSessionRecord,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { ProjectFilePickerForTarget } from "~/components/files/ProjectFilePicker";
import { CommandDialog, CommandDialogPopup } from "~/components/ui/command";
import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import { computeEnvironment } from "~/state/compute";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { getComputeContext, type ComputeContextId } from "./computeContextStore";
import { computeSavedFileRequest } from "./computeSavedFileRequest";

/** Saved-file entry for an explicit standalone namespace; ordinary files keep their editor Run. */
export function ComputeSavedFileAction(props: {
  readonly contextId: ComputeContextId;
  readonly session: ComputeSessionRecord;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmitted: (execution: ComputeExecutionRecord) => void;
}) {
  const { open, onOpenChange: setOpen } = props;
  const readFile = useAtomQueryRunner(projectEnvironment.readFile, {
    reportFailure: false,
    refresh: true,
  });
  const submit = useAtomCommand(computeEnvironment.submitExecution, { reportFailure: false });
  const run = async (relativePath: string) => {
    return await (async () => {
      const file = await readFile({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, relativePath },
      });
      if (file._tag !== "Success") throw squashAtomCommandFailure(file);
      const request = computeSavedFileRequest({
        context: getComputeContext(props.contextId),
        session: props.session,
        relativePath,
        file: file.value,
      });
      const result = await submit({
        environmentId: props.environmentId,
        input: {
          cwd: props.cwd,
          sessionId: props.session.sessionId,
          executionId: ComputeExecutionId.make(randomUUID()),
          expectedGeneration: props.session.generation,
          ...request,
        },
      });
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      props.onSubmitted(result.value);
    })().catch(async (error) => {
      toastManager.add({
        type: "error",
        title: "Unable to run saved file",
        description: error instanceof Error ? error.message : "The file could not be submitted.",
      });
    });
  };
  return (
    <>
      <CommandDialog open={open} onOpenChange={setOpen}>
        {open ? (
          <CommandDialogPopup
            aria-label="Run saved file"
            padding="none"
            className="overflow-hidden"
            onBackdropPointerDown={() => setOpen(false)}
          >
            <ProjectFilePickerForTarget
              setOpen={setOpen}
              actionLabel="Run saved file"
              target={{
                environmentId: props.environmentId,
                cwd: props.cwd,
                threadRef: props.threadRef,
                projectName: props.session.label,
              }}
              onSelectFile={(path) => void run(path)}
            />
          </CommandDialogPopup>
        ) : null}
      </CommandDialog>
    </>
  );
}
