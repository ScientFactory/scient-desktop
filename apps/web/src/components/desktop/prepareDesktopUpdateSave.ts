import {
  flushFolderEditors,
  hasUnsavedWindowEditors,
  type WindowEditors,
} from "../../scient/editorFlush/flushFolderEditors";

/** Saves every environment this window still holds, including disconnected dirty editors. */
export async function prepareDesktopUpdateSave(
  editors: WindowEditors,
  flushComposer: () => void | Promise<void>,
): Promise<boolean> {
  try {
    await flushComposer();
    for (let pass = 0; pass < 2; pass++) {
      const environmentIds = new Set(
        [
          ...editors.documents.getSnapshot(),
          ...editors.fileSessions.sessionTargets(),
          ...editors.latexInputs.targets(),
          ...editors.compositions.targets(),
        ].map((target) => target.environmentId),
      );
      for (const environmentId of environmentIds) {
        const result = await flushFolderEditors(environmentId, editors, async (files) =>
          files.map((file) => ({
            status: "inside" as const,
            path: JSON.stringify([file.cwd, file.relativePath]),
          })),
        );
        if (result.failures.length > 0) return false;
      }
      await flushComposer();
      if (!hasUnsavedWindowEditors(editors)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
