import type { ScopedThreadRef } from "@t3tools/contracts";
import { BookOpen } from "lucide-react";
import { useState } from "react";

import { resolveThreadWorkspaceRoot } from "~/components/ChatView.logic";
import { previewBridge } from "~/components/preview/previewBridge";
import { MenuItem } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProject, useQuietThreadShell } from "~/state/entities";

import { scientSourcesSurface } from "../rightPanel/surfaces";
import { saveScientSourcePage } from "./client";
import { useCanChangeLibrary } from "./sourcesCommands";
import { requestLibraryFileImport } from "./libraryFileHandoff";
import { settleAfter } from "./settleAfter";

function savedDescription(passageSaved: boolean): string | undefined {
  return passageSaved ? "The selected passage is in its note." : undefined;
}

/**
 * Saves the tab to the conversation's project Library: a page by what it
 * states about itself, with the selection kept as a note; a PDF through the
 * Library's own import.
 */
export function SaveToLibraryMenuItem(props: {
  readonly threadRef: ScopedThreadRef;
  readonly runtimeTabId: string | null;
  readonly disabled: boolean;
}) {
  const shell = useQuietThreadShell(props.threadRef);
  const project = useProject(
    shell ? { environmentId: props.threadRef.environmentId, projectId: shell.projectId } : null,
  );
  const root = resolveThreadWorkspaceRoot({
    worktreePath: shell?.worktreePath,
    projectCwd: project?.workspaceRoot,
  });
  const [saving, setSaving] = useState(false);
  const canChange = useCanChangeLibrary(props.threadRef.environmentId);
  const readLibraryPage = previewBridge?.readLibraryPage;
  if (!readLibraryPage) return null;

  const openLibrary = () =>
    useRightPanelStore.getState().openScient(props.threadRef, scientSourcesSurface());

  const save = async () => {
    const tabId = props.runtimeTabId;
    if (!root || !tabId || saving) return;
    setSaving(true);
    await settleAfter(
      async () => {
        try {
          const read = await readLibraryPage(tabId);
          if (!read) {
            toastManager.add({
              type: "error",
              title: "Couldn't save this page",
              description: "Scient could not read this tab. Reload it, then try again.",
            });
            return;
          }
          if (read._tag === "pdf") {
            requestLibraryFileImport(root, [
              new File([read.data.slice()], read.fileName, { type: "application/pdf" }),
            ]);
            openLibrary();
            return;
          }
          const result = await saveScientSourcePage(props.threadRef.environmentId, {
            root,
            page: read.page,
          });
          if (result.outcome === "not-added") {
            toastManager.add({
              type: "error",
              title: "Not saved to Library",
              description: result.message,
            });
            return;
          }
          const description = savedDescription(result.passageSaved);
          toastManager.add({
            type: "success",
            title: result.outcome === "added" ? "Saved to Library" : "Already in Library",
            ...(description ? { description } : { data: { compact: true } }),
            actionProps: { children: "Open Library", onClick: openLibrary },
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Couldn't save this page",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
      },
      () => setSaving(false),
    );
  };

  return (
    <MenuItem
      disabled={props.disabled || !canChange || !root || saving}
      onClick={() => void save()}
    >
      <BookOpen />
      Save to Library
    </MenuItem>
  );
}
