import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { toastManager } from "../../components/ui/toast";
import { saveConversationExport, saveFailureMessage } from "../conversationExport/exportActions";
import { exportWordFile, exportWordLatex, prepareWordFileDiagrams } from "./client";
import { captureWordDiagrams } from "./captureDiagrams";
import { PandocInstallStatus } from "./PandocInstallControl";
import { usePandocTool } from "./usePandocTool";

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "The file could not be exported to Word.";
}

/**
 * Markdown editor ▸ Export ▸ Word. Exports the saved file straight away when
 * the server has Pandoc; otherwise asks first ("Word export needs Pandoc
 * (N MB). Install now?") and exports once the install finishes.
 */
export function WordFileExportDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly rootRelativePath?: string;
  /** The saved revision the editor shows, or null when it has unsaved edits. */
  readonly savedRevision: () => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const { environmentId, cwd, relativePath, rootRelativePath, savedRevision, onClose } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  const runningRef = useRef(false);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const revision = await savedRevision();
      if (revision === null) {
        setError("Save the file before exporting it to Word.");
        return;
      }
      const result =
        rootRelativePath === undefined
          ? await exportWordFile(environmentId, {
              cwd,
              relativePath,
              revision,
              diagramCapture: await captureWordDiagrams(
                await prepareWordFileDiagrams(environmentId, { cwd, relativePath, revision }),
              ),
            })
          : await exportWordLatex(environmentId, { cwd, relativePath, rootRelativePath, revision });
      const saved = await saveConversationExport(environmentId, result.file);
      if (saved._tag === "cancelled") return;
      if (saved._tag === "failed") {
        setError(saveFailureMessage(saved));
        return;
      }
      toastManager.add({
        type: "success",
        title: saved._tag === "saved" ? "Word file saved" : "Download started",
        description: saved._tag === "saved" ? saved.path : result.file.fileName,
      });
      if (result.warnings.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Exported with notes",
          description: result.warnings.map((warning) => warning.message).join("\n"),
        });
      }
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      runningRef.current = false;
      setBusy(false);
    }
  }, [cwd, environmentId, onClose, relativePath, rootRelativePath, savedRevision]);

  const tool = usePandocTool(environmentId);
  const installed = tool.status?.installed === true;
  useEffect(() => {
    if (!installed || startedRef.current) return;
    startedRef.current = true;
    void run();
  }, [installed, run]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export to Word</DialogTitle>
          <DialogDescription>{rootRelativePath ?? relativePath}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {installed ? (
            <p className="text-muted-foreground text-sm" role="status">
              {busy ? "Converting the saved file to Word…" : "Ready to export the saved file."}
            </p>
          ) : (
            <PandocInstallStatus controller={tool} showReady />
          )}
          {error ? (
            <p role="alert" className="mt-3 text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          {installed ? (
            <Button type="button" disabled={busy} onClick={() => void run()}>
              {busy ? "Exporting…" : "Export"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
