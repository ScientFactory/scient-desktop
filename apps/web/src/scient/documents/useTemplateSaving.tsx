import type { EnvironmentId } from "@t3tools/contracts";
import { type ReactNode, useState, useSyncExternalStore } from "react";

import { toastManager } from "~/components/ui/toast";
import type { MarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { markdownPersistenceRegistry } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { DockCommandItem } from "~/scient/writing/dockChrome";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { includedFiles, newDocumentTitle, withEmptyTitle } from "./documentTemplates";
import { folderOf } from "./newDocumentPlacement";
import { newDocuments, templateEdits } from "./newDocuments";
import { TemplateNameDialog } from "./TemplateNameDialog";
import { captureVisualPage } from "./templatePreviews";
import { type UserTemplate, userTemplates } from "./userTemplates";

/** A file a template needs that could not be taken whole. */
class Incomplete extends Error {
  constructor(readonly path: string) {
    super(`${path} could not be read whole.`);
  }
}

/** The most included files a template carries, and their total size. */
const MAX_FILES = 40;
const MAX_BYTES = 2 * 1024 * 1024;

function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

/**
 * Saving a LaTeX document as one of the person's templates: its source with
 * the title left empty, with the files it includes. A document opened to edit
 * a template can also update it. Returns the menu items and their dialog.
 */
export function useTemplateSaving(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string | null;
  readonly lease: MarkdownPersistenceLease | null;
}): { readonly menuItems: ReactNode; readonly dialog: ReactNode } {
  const { environmentId, cwd, relativePath, lease } = input;
  const readFile = useAtomCommand(projectEnvironment.readFileOrdered, { reportFailure: false });
  const [naming, setNaming] = useState(false);
  const templates = useSyncExternalStore(userTemplates.subscribe, userTemplates.list);
  const key = relativePath === null ? null : { environmentId, cwd, relativePath };
  const editedId = useSyncExternalStore(newDocuments.subscribe, () =>
    key ? templateEdits.get(key) : null,
  );
  const edited = templates.find((template) => template.id === editedId) ?? null;
  if (!key || !lease || !/\.tex$/iu.test(key.relativePath))
    return { menuItems: null, dialog: null };

  const read = async (path: string): Promise<string | null> => {
    const result = await readFile({ environmentId, input: { cwd, relativePath: path } });
    return result._tag === "Success" && !result.value.truncated ? result.value.contents : null;
  };
  /** Writes a file's edits out first, waiting briefly for a field still being typed in. */
  const flush = async (path: string) => {
    const target = { environmentId, cwd, relativePath: path };
    for (let attempt = 0; attempt < 25; attempt++) {
      if (await markdownPersistenceRegistry.flushTarget(target)) return true;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return false;
  };
  /**
   * The document as a template: its title emptied, and every file it includes,
   * each as saved. Throws, naming the file, when one cannot be taken whole:
   * a template missing a chapter is never saved.
   */
  const capture = async (replacing: UserTemplate | null) => {
    if (!(await flush(key.relativePath))) throw new Incomplete(key.relativePath);
    // Its first page as Visual draws it, read before anything else can change the screen.
    const source = lease.getSnapshot().draftSource;
    const picture = captureVisualPage();
    const folder = folderOf(key.relativePath);
    const files: Record<string, string> = {};
    let bytes = source.length;
    const queue = [...includedFiles(source)];
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (name in files) continue;
      const path = `${folder}${name}`;
      if (Object.keys(files).length >= MAX_FILES || !(await flush(path)))
        throw new Incomplete(path);
      const contents = await read(path);
      if (contents === null || (bytes += contents.length) > MAX_BYTES) throw new Incomplete(path);
      files[name] = contents;
      queue.push(...includedFiles(contents));
    }
    return {
      source: withEmptyTitle(source),
      files,
      preview: (await picture) ?? replacing?.preview ?? null,
    };
  };
  const save = async (name: string, replacing: UserTemplate | null) => {
    try {
      const saved = await userTemplates.save({
        ...(await capture(replacing)),
        ...(replacing ? { id: replacing.id } : {}),
        name: replacing?.name ?? name,
      });
      templateEdits.set(key, saved.id);
      toastManager.add({ type: "success", title: `Saved as the template “${saved.name}”.` });
    } catch (error) {
      if (error instanceof Incomplete)
        toastManager.add({
          type: "error",
          title: "The template could not be saved.",
          description: `${error.path} could not be read whole.`,
        });
      else {
        console.error("The template could not be saved:", error);
        toastManager.add({ type: "error", title: "The template could not be saved." });
      }
    }
  };
  const taken = (name: string) => templates.find((template) => sameName(template.name, name));

  return {
    menuItems: (
      <>
        {edited ? (
          <DockCommandItem onClick={() => void save(edited.name, edited)}>
            Update “{edited.name}”
          </DockCommandItem>
        ) : null}
        <DockCommandItem onClick={() => setNaming(true)}>Save as template…</DockCommandItem>
      </>
    ),
    dialog: (
      <TemplateNameDialog
        open={naming}
        title="Save as template"
        initialName={edited?.name ?? newDocumentTitle(lease.getSnapshot().draftSource, "latex")}
        actionFor={(name) => (taken(name) ? "Replace" : "Save")}
        onSubmit={(name) => save(name, taken(name) ?? null)}
        onOpenChange={setNaming}
      />
    ),
  };
}
