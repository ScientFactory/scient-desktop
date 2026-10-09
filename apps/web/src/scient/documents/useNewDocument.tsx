import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ChevronDown } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { setProjectFileQueryData } from "~/components/files/projectFilesQueryState";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import type { MarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  FOLDER_DOCUMENT_MAIN,
  NEW_DOCUMENT_LANGUAGES,
  type DocumentTemplateId,
  type NewDocumentLanguage,
  isDocumentTemplateId,
  isFolderTemplate,
  isUntouchedNewLatexDocument,
  newDocumentCandidate,
  newDocumentStem,
  newDocumentTitle,
  sameTitleText,
  switchNewLatexDocument,
  templateCompanions,
  templateContents,
  templateHasTitle,
} from "./documentTemplates";
import { caretOffsetInEditor, focusNewDocumentWhenOpen } from "./focusNewDocument";
import {
  DEFAULT_NEW_DOCUMENT_TEMPLATE,
  NEW_DOCUMENT_TEMPLATE_STORAGE_KEY,
  normalizeNewDocumentTemplate,
} from "./documentPreferences";
import { NewDocumentOnPage, STRIP_ATTRIBUTE } from "./NewDocumentOnPage";
import { syncCompanionFiles } from "./newDocumentCompanions";
import {
  filesUnder,
  folderOf,
  freeFolderName,
  newDocumentBase,
  placeNewDocument,
  untitledStem,
} from "./newDocumentPlacement";
import { newDocuments, pathHasLeftoverDrafts, templateEdits } from "./newDocuments";
import { builtInPreviewReference } from "./templatePreviews";
import { TemplateRow } from "./TemplateRow";
import { isPathTaken, useNewDocumentFiles } from "./useNewDocumentFiles";
import { useTemplateChoices } from "./useTemplateChoices";
import { useTemplateSaving } from "./useTemplateSaving";
import { userTemplates } from "./userTemplates";
import type { RenameOpenDocumentResult } from "~/scient/fileSurfaces/renameOpenDocument";
import "./newDocument.css";

function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      if (condition()) resolve(true);
      else if (performance.now() > deadline) resolve(false);
      else setTimeout(check, 40);
    };
    check();
  });
}

/** Where the person is typing the title: LaTeX's title field or Markdown's first heading. */
function caretInTitle(): boolean {
  const active = document.activeElement;
  if (active?.closest(`[${STRIP_ATTRIBUTE}]`)) return true;
  if (
    active instanceof HTMLTextAreaElement &&
    active.getAttribute("aria-label") === "Document title"
  )
    return true;
  const selection = window.getSelection();
  const anchor = selection?.anchorNode;
  const element = anchor instanceof Element ? anchor : anchor?.parentElement;
  const heading = element?.closest(".scient-markdown-document h1");
  return heading != null && heading === heading.parentElement?.querySelector("h1");
}

function useCaretInTitle(enabled: boolean): boolean {
  const [inTitle, setInTitle] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    // Focus moves through `body` between fields; judge once it has landed.
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setInTitle(caretInTitle()));
    };
    document.addEventListener("focusin", check);
    document.addEventListener("focusout", check);
    document.addEventListener("selectionchange", check);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("focusin", check);
      document.removeEventListener("focusout", check);
      document.removeEventListener("selectionchange", check);
    };
  }, [enabled]);
  return inTitle;
}

/**
 * A document started from the Documents menu: while untouched, a row to change
 * its template and language; once its title is saved and the person has moved
 * on from it, one rename from `untitled` to the title's name.
 */
export function useNewDocument(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string | null;
  readonly lease: MarkdownPersistenceLease | null;
  readonly snapshot: ReturnType<MarkdownPersistenceLease["getSnapshot"]> | null;
  readonly renameDisabled: boolean;
  readonly onRenamed: (destinationRelativePath: string) => void;
  /**
   * Renames the open document in place, keeping its editor, when this document
   * can move (`canMoveInPlace`). Otherwise the ordinary rename runs.
   */
  readonly moveInPlace?: (destinationRelativePath: string) => Promise<RenameOpenDocumentResult>;
  readonly canMoveInPlace?: boolean;
}): { readonly startBar: ReactNode; readonly templateActions: ReactNode } {
  const { environmentId, cwd, relativePath, lease, snapshot } = input;
  const key = relativePath === null ? null : { environmentId, cwd, relativePath };
  const entry = useSyncExternalStore(newDocuments.subscribe, () =>
    key ? newDocuments.get(key) : null,
  );
  const renameFile = useAtomCommand(projectEnvironment.renameFile, { reportFailure: false });
  const documentFiles = useNewDocumentFiles();
  const saving = useTemplateSaving({ environmentId, cwd, relativePath, lease });
  const templateChoices = useTemplateChoices();
  const [storedDefault, setStoredDefault] = useLocalStorage(
    NEW_DOCUMENT_TEMPLATE_STORAGE_KEY,
    DEFAULT_NEW_DOCUMENT_TEMPLATE,
    Schema.String,
  );
  const defaultTemplate = normalizeNewDocumentTemplate(storedDefault);
  const inTitle = useCaretInTitle(entry !== null);
  const renaming = useRef(false);
  const switching = useRef(false);
  const onRenamed = useEffectEvent(input.onRenamed);
  const moveInPlace = useEffectEvent((destination: string) => input.moveInPlace!(destination));
  // An in-place move was refused for this document: rename the ordinary way.
  const [moveRefused, setMoveRefused] = useState<string | null>(null);
  // The route is chosen before the rename starts, so the ordinary rename's
  // waits still apply when the document cannot move in place.
  const moves =
    input.moveInPlace !== undefined &&
    input.canMoveInPlace === true &&
    moveRefused !== relativePath;

  const draft = snapshot?.draftSource ?? null;
  const untouched =
    entry !== null &&
    entry.format === "latex" &&
    !entry.settled &&
    draft !== null &&
    isUntouchedNewLatexDocument(draft, entry.template, entry.language);

  // The first edit beyond the title ends the choice of template. Only an edit
  // seen after the untouched document counts: an editor can briefly show what
  // it held before the file was read.
  useEffect(() => {
    if (!key || entry?.format !== "latex" || entry.settled || draft === null) return;
    if (untouched && !entry.seenUntouched) newDocuments.update(key, { seenUntouched: true });
    else if (!untouched && entry.seenUntouched) newDocuments.update(key, { settled: true });
  });

  const titled = entry?.format !== "latex" || templateHasTitle(entry.template);
  // A template that is a folder moves with its title only before anything in it
  // is written: its other files are then still exactly as Scient made them.
  const folderDocument = entry?.format === "latex" && isFolderTemplate(entry.template);
  // The name comes from the title, or, in a template without one, from the name line.
  const savedTitle =
    entry && snapshot && snapshot.draftSource === snapshot.baselineSource
      ? titled
        ? newDocumentTitle(snapshot.baselineSource, entry.format)
        : (entry.name ?? "")
      : "";
  // A Markdown line just started under the heading is not in the file yet; the
  // ordinary rename remounts the editor, so wait for its first words or for the
  // caret to leave. A move in place keeps the editor and need not wait.
  const markdownWaits =
    !moves &&
    entry?.format === "markdown" &&
    snapshot !== null &&
    !/^#[^\n]*\n[\s\S]*\S/u.test(snapshot.baselineSource) &&
    caretOffsetInEditor() !== null;
  const ready =
    key !== null &&
    entry !== null &&
    lease !== null &&
    snapshot !== null &&
    !snapshot.pending &&
    !snapshot.inFlight &&
    snapshot.conflict === null &&
    !input.renameDisabled &&
    savedTitle.length > 0 &&
    !inTitle &&
    !markdownWaits &&
    !(folderDocument && entry.settled);

  /** Moves a project file only as last read: its revision after, "taken", or null. */
  const move = async (
    from: string,
    to: string,
    revision: string,
  ): Promise<string | "taken" | null> => {
    if (!key) return null;
    const result = await renameFile({
      environmentId: key.environmentId,
      input: {
        cwd: key.cwd,
        relativePath: from,
        destinationRelativePath: to,
        expectedRevision: revision,
        removeEmptyFolders: true,
      },
    });
    if (result._tag === "Success") return result.value.revision;
    return isPathTaken(result) ? "taken" : null;
  };

  /**
   * A new document that is a folder takes its title's name: the files Scient
   * made move first, the open document last. If anything fails, what moved
   * moves back and the folder keeps its name. A folder holding anything else
   * keeps its name too.
   */
  const moveFolderToTitle = useEffectEvent(async (stem: string) => {
    if (!key || !entry || !lease || !snapshot) return;
    const commands = documentFiles.commandsFor(key);
    const base = newDocumentBase(key.relativePath, entry.template);
    const oldFolder = folderOf(key.relativePath);
    const keepName = () => newDocuments.forget(key);
    if (`${base}${stem}/` === oldFolder) return keepName();
    const ours = new Set([key.relativePath, ...entry.companions.map((file) => file.relativePath)]);
    const present = await filesUnder(commands, oldFolder);
    if (present === null || present.some((path) => !ours.has(path))) return keepName();
    const name = await freeFolderName(commands, base, stem);
    if (name === null) return keepName();
    const newFolder = `${base}${name}/`;
    const moved: { from: string; to: string; revision: string }[] = [];
    const moveBack = async () => {
      for (const file of moved.toReversed()) await move(file.to, file.from, file.revision);
    };
    for (const file of entry.companions) {
      const to = newFolder + file.relativePath.slice(oldFolder.length);
      const revision = await move(file.relativePath, to, file.revision);
      if (revision === null || revision === "taken") {
        await moveBack();
        return keepName();
      }
      moved.push({ from: file.relativePath, to, revision });
    }
    const caretBefore = caretOffsetInEditor();
    const release = lease.holdForRename();
    if (!release) {
      await moveBack();
      return keepName();
    }
    const destination = `${newFolder}${FOLDER_DOCUMENT_MAIN}`;
    const revision = await move(key.relativePath, destination, snapshot.baselineRevision);
    if (revision === null || revision === "taken") {
      release();
      await moveBack();
      return keepName();
    }
    newDocuments.forget(key);
    templateEdits.move(key, { ...key, relativePath: destination });
    release();
    onRenamed(destination);
    if (caretBefore !== null) focusNewDocumentWhenOpen({ offset: caretBefore });
  });

  useEffect(() => {
    if (!ready || renaming.current || !key || !entry || !lease || !snapshot) return;
    const stem = newDocumentStem(savedTitle);
    if (folderDocument) {
      renaming.current = true;
      void moveFolderToTitle(stem).finally(() => {
        renaming.current = false;
      });
      return;
    }
    const folder = folderOf(key.relativePath);
    if (newDocumentCandidate(stem, entry.format, 1, folder) === key.relativePath) {
      newDocuments.forget(key);
      return;
    }
    // Read before the hold: holding the document for its rename can drop the selection.
    const caretBefore = caretOffsetInEditor();
    if (moves) {
      renaming.current = true;
      const from = key.relativePath;
      void (async () => {
        try {
          for (let attempt = 1; attempt <= 20; attempt++) {
            const outcome = await moveInPlace(
              newDocumentCandidate(stem, entry.format, attempt, folder),
            );
            if (outcome.kind === "legacy-required") {
              setMoveRefused(from);
              return;
            }
            if (outcome.kind === "failed") {
              const cause = outcome.cause;
              const taken =
                typeof cause === "object" &&
                cause !== null &&
                "failure" in cause &&
                cause.failure === "path_exists";
              if (taken) continue;
              break;
            }
            newDocuments.forget(key);
            // Moved: the editor and caret stayed. Reopened or remounted: put the caret back.
            if (outcome.kind !== "moved" && caretBefore !== null)
              focusNewDocumentWhenOpen({ offset: caretBefore });
            return;
          }
          // Not renamed: the file keeps its name and stays renamable from the header.
          newDocuments.forget(key);
        } finally {
          renaming.current = false;
        }
      })();
      return;
    }
    const release = lease.holdForRename();
    if (!release) return;
    renaming.current = true;
    void (async () => {
      try {
        for (let attempt = 1; attempt <= 20; attempt++) {
          const destinationRelativePath = newDocumentCandidate(stem, entry.format, attempt, folder);
          const result = await renameFile({
            environmentId: key.environmentId,
            input: {
              cwd: key.cwd,
              relativePath: key.relativePath,
              destinationRelativePath,
              expectedRevision: snapshot.baselineRevision,
            },
          });
          if (result._tag === "Success") {
            // The editor remounts under the new name; the caret comes back where it was.
            // The old session is forgotten while still held, so no read starts at the old path.
            const caret = caretBefore;
            newDocuments.forget(key);
            templateEdits.move(key, {
              ...key,
              relativePath: result.value.destinationRelativePath,
            });
            onRenamed(result.value.destinationRelativePath);
            release();
            if (caret !== null) focusNewDocumentWhenOpen({ offset: caret });
            return;
          }
          if (!isPathTaken(result)) break;
        }
        // Not renamed: the file keeps its name and stays renamable from the header.
        newDocuments.forget(key);
        release();
      } finally {
        renaming.current = false;
      }
    })();
  });

  /**
   * Into or out of a template that is a folder: the document is made again in
   * its new place, the tab follows it there, and its old place, with every file
   * it made, is removed while still exactly as made.
   */
  const relocate = useEffectEvent(
    async (change: {
      readonly template: DocumentTemplateId;
      readonly language: NewDocumentLanguage;
      readonly name: string;
      readonly next: string;
      readonly revision: string;
    }) => {
      if (!key || !entry || !lease) return;
      const commands = documentFiles.commandsFor(key);
      const title = newDocumentTitle(change.next, "latex") || change.name.trim();
      const placed = await placeNewDocument({
        format: "latex",
        base: newDocumentBase(key.relativePath, entry.template),
        stem: title ? newDocumentStem(title) : untitledStem("latex", change.template),
        template: change.template,
        source: change.next,
        commands,
        skip: (relativePath) =>
          pathHasLeftoverDrafts({ environmentId: key.environmentId, cwd: key.cwd, relativePath }),
      });
      if (!placed) {
        toastManager.add({ type: "error", title: "The template could not be changed." });
        return;
      }
      const undo = async () => {
        for (const file of placed.companions)
          await commands.remove(file, { removeEmptyFolders: true });
        await commands.remove(placed, { removeEmptyFolders: true });
      };
      const release = lease.holdForRename();
      if (!release) return undo();
      setProjectFileQueryData(
        key.environmentId,
        key.cwd,
        placed.relativePath,
        change.next,
        placed.revision,
      );
      newDocuments.set(
        { ...key, relativePath: placed.relativePath },
        {
          ...entry,
          template: change.template,
          language: change.language,
          name: change.name,
          companions: placed.companions,
          seenUntouched: false,
        },
      );
      newDocuments.forget(key);
      templateEdits.move(key, { ...key, relativePath: placed.relativePath });
      release();
      onRenamed(placed.relativePath);
      focusNewDocumentWhenOpen("title");
      await commands.remove(
        { relativePath: key.relativePath, revision: change.revision },
        { removeEmptyFolders: true },
      );
      for (const file of entry.companions)
        await commands.remove(file, { removeEmptyFolders: true });
    },
  );

  if (!key || !entry || !lease || !snapshot)
    return { startBar: saving.dialog, templateActions: saving.menuItems };
  const choose = (template: DocumentTemplateId, language: NewDocumentLanguage) => {
    if (switching.current) return;
    switching.current = true;
    void (async () => {
      try {
        // The title field publishes after a pause, and the editor takes outside
        // changes only with nothing unpublished; switch once the title is in.
        const field = document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Document title"]',
        );
        const typed = field?.value ?? "";
        const fromFolder = isFolderTemplate(entry.template);
        const toFolder = isFolderTemplate(template);
        const relocates = fromFolder !== toFolder;
        const settledAt = await waitUntil(() => {
          const current = lease.getSnapshot();
          return (
            lease.getPendingInput() === null &&
            sameTitleText(newDocumentTitle(current.draftSource, "latex"), typed) &&
            // A document that moves is copied as saved, so it must be saved.
            (!relocates ||
              (!current.pending &&
                !current.inFlight &&
                current.draftSource === current.baselineSource))
          );
        }, 2_000);
        if (!settledAt) return;
        const current = lease.getSnapshot();
        if (!isUntouchedNewLatexDocument(current.draftSource, entry.template, entry.language))
          return;
        // A title and a name stand for each other across templates with and without one.
        const name = templateHasTitle(entry.template) ? typed.trim() : (entry.name ?? "");
        const next = switchNewLatexDocument(current.draftSource, template, language, name);
        const commands = documentFiles.commandsFor(key);
        if (relocates) {
          await relocate({ template, language, name, next, revision: current.baselineRevision });
          return;
        }
        if (next !== current.draftSource && !lease.change(next, current.editVersion)) return;
        newDocuments.update(key, { template, language, name });
        // The files the new template keeps beside it, such as its bibliography.
        const companions = await syncCompanionFiles({
          folder: folderOf(key.relativePath),
          files: templateCompanions(template, next),
          created: newDocuments.get(key)?.companions ?? [],
          create: commands.create,
          remove: commands.remove,
        });
        newDocuments.update(key, { companions });
        // The page is drawn again; writing continues in the title or the name.
        focusNewDocumentWhenOpen("title");
      } finally {
        switching.current = false;
      }
    })();
  };
  // A folder document is named by its folder: `thesis/main.tex`.
  const base = newDocumentBase(key.relativePath, entry.template);
  const fileName = (path: string) =>
    folderDocument ? path.slice(base.length) : path.slice(path.lastIndexOf("/") + 1);
  // Once written in, an unnamed document stops offering its name, and a folder
  // document stops offering to move.
  const naming = !(entry.settled && (savedTitle.length === 0 || folderDocument));
  /** One of the person's templates, opened to edit: this document can update it. */
  const editTemplate = (template: string) => {
    templateEdits.set(key, template);
    if (template !== entry.template) choose(template, entry.language);
  };
  /** A new template of the person's own, copied from the one chosen, opened to edit. */
  const newTemplate = async (name: string) => {
    const saved = await userTemplates.save({
      ...templateContents(entry.template),
      name,
      // It looks like the one it was copied from until it is updated.
      preview:
        builtInPreviewReference(entry.template) ??
        userTemplates.get(entry.template)?.preview ??
        null,
    });
    editTemplate(saved.id);
  };
  return {
    templateActions: saving.menuItems,
    startBar: (
      <>
        <NewDocumentOnPage
          row={
            untouched ? (
              <TemplateRow
                templates={templateChoices}
                selected={entry.template}
                defaultTemplate={defaultTemplate}
                onSelect={(template) => {
                  if (isDocumentTemplateId(template)) choose(template, entry.language);
                }}
                onSetDefault={setStoredDefault}
                onEdit={editTemplate}
                onNewTemplate={newTemplate}
                strip={strip}
                trailing={
                  <LanguageMenu
                    language={entry.language}
                    strip={strip}
                    onLanguage={(language) => choose(entry.template, language)}
                  />
                }
              />
            ) : null
          }
          name={
            titled || !naming
              ? null
              : {
                  value: entry.name ?? "",
                  onCommit: (name) => newDocuments.update(key, { name }),
                }
          }
          hint={titled && naming}
          currentFileName={fileName(key.relativePath)}
          fileNameFor={(title) =>
            folderDocument
              ? `${newDocumentStem(title)}/${FOLDER_DOCUMENT_MAIN}`
              : fileName(newDocumentCandidate(newDocumentStem(title), entry.format, 1))
          }
          onEdit={entry.settled ? null : () => newDocuments.update(key, { settled: true })}
        />
        {saving.dialog}
      </>
    ),
  };
}

const strip = { [STRIP_ATTRIBUTE]: "" };

function LanguageMenu(props: {
  readonly language: NewDocumentLanguage;
  readonly strip: Readonly<Record<string, string>>;
  readonly onLanguage: (language: NewDocumentLanguage) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label="Language"
            onMouseDown={(event) => event.preventDefault()}
          />
        }
      >
        {NEW_DOCUMENT_LANGUAGES.find((entry) => entry.id === props.language)!.name}
        <ChevronDown aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" sideOffset={4} className="min-w-0" {...props.strip}>
        {NEW_DOCUMENT_LANGUAGES.map((entry) => (
          <MenuItem key={entry.id} onClick={() => props.onLanguage(entry.id)}>
            {entry.name}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
