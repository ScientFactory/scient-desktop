import type { ContextMenuItem, EnvironmentId, ProjectDirectoryEntry } from "@t3tools/contracts";
import { useRef, type RefObject } from "react";

import type { OpenFileOptions } from "~/rightPanelStore";
import type { NewDocumentFormat } from "~/scient/documents/documentTemplates";
import { useCreateNewDocument } from "~/scient/documents/useCreateNewDocument";
import { useOverleafConnectDialog } from "~/scient/overleaf/useOverleafFolderConnect";

import { ConnectFolderButton, NewDocumentButton } from "./FileBrowserToolbarActions";

const NEW_DOCUMENT_CHOICES: Readonly<Record<string, NewDocumentFormat>> = {
  "new-document:markdown": "markdown",
  "new-document:latex": "latex",
};

/** Folder actions for the Files bar and folder menus: a new document (opened in its editor,
 * LaTeX in Visual) or an Overleaf connection. They act on the last selected folder, else the
 * last selected file's folder; a read-only host folder offers none. */
export function useScientFolderActions(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly selectedPath: string | null;
  readonly entryKinds: RefObject<ReadonlyMap<string, ProjectDirectoryEntry["kind"]>>;
  readonly hostFolder: boolean;
  readonly onOpenFileSource: (
    relativePath: string,
    line?: number,
    options?: OpenFileOptions,
  ) => void;
}) {
  const lastSelectionRef = useRef<string | null>(null);
  const createNewDocument = useCreateNewDocument();
  const overleafConnect = useOverleafConnectDialog({
    environmentId: input.environmentId,
    cwd: input.cwd,
  });
  const isDirectory = (path: string) => input.entryKinds.current.get(path) === "directory";

  const selectionBase = () => {
    const selection = lastSelectionRef.current ?? input.selectedPath;
    if (!selection) return "";
    if (isDirectory(selection)) return `${selection}/`;
    const slash = selection.lastIndexOf("/");
    return slash === -1 ? "" : selection.slice(0, slash + 1);
  };
  const startNewDocument = (format: NewDocumentFormat, base: string) =>
    createNewDocument({
      format,
      environmentId: input.environmentId,
      cwd: input.cwd,
      base,
      open: (relativePath) =>
        input.onOpenFileSource(relativePath, undefined, { latexPreviewMode: "visual" }),
    });

  return {
    /** The tree's latest selection, which the Files bar's New acts on. */
    rememberSelection: (relativePath: string) => {
      lastSelectionRef.current = relativePath;
    },
    toolbarButtons: input.hostFolder ? null : (
      <>
        <NewDocumentButton onChoose={(format) => startNewDocument(format, selectionBase())} />
        <ConnectFolderButton
          // The selected folder, or the project's top when nothing is selected.
          onConnectOverleaf={() => overleafConnect.openConnect(selectionBase().replace(/\/$/u, ""))}
        />
      </>
    ),
    /** The Connect to Overleaf dialog, rendered once by the Files panel. */
    dialog: overleafConnect.dialog,
    /** Right-click items for a tree entry; `path` ends with "/" for a folder. */
    menuItems: (path: string): ContextMenuItem[] => {
      const relativePath = path.replace(/\/$/, "");
      if (input.hostFolder || !(path.endsWith("/") || isDirectory(relativePath))) return [];
      return [
        {
          id: "new-document",
          label: "New document here",
          separatorBefore: true,
          children: [
            { id: "new-document:markdown", label: "Markdown" },
            { id: "new-document:latex", label: "LaTeX" },
          ],
        },
        {
          id: "connect",
          label: "Connect to",
          children: [{ id: "connect:overleaf", label: "Overleaf…" }],
        },
      ];
    },
    /** Acts on a choice from `menuItems`; false when the choice is not one of them. */
    handleMenuChoice: (clicked: string, relativePath: string) => {
      if (clicked === "connect:overleaf") {
        overleafConnect.openConnect(relativePath);
        return true;
      }
      const format = NEW_DOCUMENT_CHOICES[clicked];
      if (!format) return false;
      startNewDocument(format, `${relativePath}/`);
      return true;
    },
  };
}
