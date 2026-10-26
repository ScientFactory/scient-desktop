import type { ContextMenuItem, EnvironmentId, ProjectDirectoryEntry } from "@t3tools/contracts";
import { useRef, type RefObject } from "react";

import type { OpenFileOptions } from "~/rightPanelStore";
import type { NewDocumentFormat } from "~/scient/documents/documentTemplates";
import { useCreateNewDocument } from "~/scient/documents/useCreateNewDocument";

import { ConnectFolderButton, NewDocumentButton } from "./FileBrowserToolbarActions";

const NEW_DOCUMENT_CHOICES: Readonly<Record<string, NewDocumentFormat>> = {
  "new-document:markdown": "markdown",
  "new-document:latex": "latex",
};

/**
 * What the Files bar and a folder's right-click menu start in a folder: a new
 * document, opened straight in its editor (LaTeX in Visual). The Files bar's New
 * acts on the last selected folder, or the folder of the last selected file. A
 * host folder is read-only, so it offers none of these.
 */
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
        <ConnectFolderButton />
      </>
    ),
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
      ];
    },
    /** Acts on a choice from `menuItems`; false when the choice is not one of them. */
    handleMenuChoice: (clicked: string, relativePath: string) => {
      const format = NEW_DOCUMENT_CHOICES[clicked];
      if (!format) return false;
      startNewDocument(format, `${relativePath}/`);
      return true;
    },
  };
}
