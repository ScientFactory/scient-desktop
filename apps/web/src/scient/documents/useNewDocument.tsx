import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDown } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import type { MarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import {
  MORE_DOCUMENT_TEMPLATES,
  NEW_DOCUMENT_LANGUAGES,
  NEW_DOCUMENT_TEMPLATES,
  type DocumentTemplateId,
  type NewDocumentLanguage,
  isUntouchedNewLatexDocument,
  newDocumentCandidate,
  newDocumentStem,
  newDocumentTitle,
  sameTitleText,
  switchNewLatexDocument,
  templateHasTitle,
} from "./documentTemplates";
import { caretOffsetInEditor, focusNewDocumentWhenOpen } from "./focusNewDocument";
import { NewDocumentOnPage, STRIP_ATTRIBUTE } from "./NewDocumentOnPage";
import { newDocuments } from "./newDocuments";
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
}): { readonly startBar: ReactNode } {
  const { environmentId, cwd, relativePath, lease, snapshot } = input;
  const key = relativePath === null ? null : { environmentId, cwd, relativePath };
  const entry = useSyncExternalStore(newDocuments.subscribe, () =>
    key ? newDocuments.get(key) : null,
  );
  const renameFile = useAtomCommand(projectEnvironment.renameFile, { reportFailure: false });
  const inTitle = useCaretInTitle(entry !== null);
  const renaming = useRef(false);
  const switching = useRef(false);
  const onRenamed = useEffectEvent(input.onRenamed);

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
  // The name comes from the title, or, in a template without one, from the name line.
  const savedTitle =
    entry && snapshot && snapshot.draftSource === snapshot.baselineSource
      ? titled
        ? newDocumentTitle(snapshot.baselineSource, entry.format)
        : (entry.name ?? "")
      : "";
  // A Markdown line just started under the heading is not in the file yet; renaming
  // remounts the editor, so wait for its first words or for the caret to leave.
  const markdownWaits =
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
    !markdownWaits;

  useEffect(() => {
    if (!ready || renaming.current || !key || !entry || !lease || !snapshot) return;
    const stem = newDocumentStem(savedTitle);
    const folder = key.relativePath.slice(0, key.relativePath.lastIndexOf("/") + 1);
    if (newDocumentCandidate(stem, entry.format, 1, folder) === key.relativePath) {
      newDocuments.forget(key);
      return;
    }
    // Read before the hold: holding the document for its rename can drop the selection.
    const caretBefore = caretOffsetInEditor();
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
            const caret = caretBefore;
            newDocuments.forget(key);
            release();
            onRenamed(result.value.destinationRelativePath);
            if (caret !== null) focusNewDocumentWhenOpen({ offset: caret });
            return;
          }
          const cause = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
          const taken =
            typeof cause === "object" &&
            cause !== null &&
            "failure" in cause &&
            cause.failure === "path_exists";
          if (!taken) break;
        }
        // Not renamed: the file keeps its name and stays renamable from the header.
        newDocuments.forget(key);
        release();
      } finally {
        renaming.current = false;
      }
    })();
  });

  if (!key || !entry || !lease || !snapshot) return { startBar: null };
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
        const settledAt = await waitUntil(() => {
          const current = lease.getSnapshot();
          return (
            lease.getPendingInput() === null &&
            sameTitleText(newDocumentTitle(current.draftSource, "latex"), typed)
          );
        }, 2_000);
        if (!settledAt) return;
        const current = lease.getSnapshot();
        if (!isUntouchedNewLatexDocument(current.draftSource, entry.template, entry.language))
          return;
        // A title and a name stand for each other across templates with and without one.
        const name = templateHasTitle(entry.template) ? typed.trim() : (entry.name ?? "");
        const next = switchNewLatexDocument(current.draftSource, template, language, name);
        if (next !== current.draftSource && !lease.change(next, current.editVersion)) return;
        newDocuments.update(key, { template, language, name });
        // The page is drawn again; writing continues in the title or the name.
        focusNewDocumentWhenOpen("title");
      } finally {
        switching.current = false;
      }
    })();
  };
  const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  // Once written in, an unnamed document stops offering its name.
  const naming = !(entry.settled && savedTitle.length === 0);
  return {
    startBar: (
      <NewDocumentOnPage
        row={
          untouched ? (
            <NewDocumentStartBar
              template={entry.template}
              language={entry.language}
              onTemplate={(template) => choose(template, entry.language)}
              onLanguage={(language) => choose(entry.template, language)}
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
          fileName(newDocumentCandidate(newDocumentStem(title), entry.format, 1))
        }
      />
    ),
  };
}

function NewDocumentStartBar(props: {
  readonly template: DocumentTemplateId;
  readonly language: NewDocumentLanguage;
  readonly onTemplate: (template: DocumentTemplateId) => void;
  readonly onLanguage: (language: NewDocumentLanguage) => void;
}) {
  const more = MORE_DOCUMENT_TEMPLATES.find((entry) => entry.id === props.template);
  const strip = { [STRIP_ATTRIBUTE]: "" };
  return (
    <div className="scient-new-document-bar">
      <div role="radiogroup" aria-label="Template">
        {NEW_DOCUMENT_TEMPLATES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={props.template === entry.id}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onTemplate(entry.id)}
          >
            {entry.name}
          </button>
        ))}
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                role="radio"
                aria-checked={more !== undefined}
                onMouseDown={(event) => event.preventDefault()}
              />
            }
          >
            {more?.name ?? "More"}
            <ChevronDown aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="start" side="bottom" sideOffset={4} className="min-w-0" {...strip}>
            {MORE_DOCUMENT_TEMPLATES.map((entry) => (
              <MenuItem key={entry.id} onClick={() => props.onTemplate(entry.id)}>
                {entry.name}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      </div>
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
        <MenuPopup align="end" side="bottom" sideOffset={4} className="min-w-0" {...strip}>
          {NEW_DOCUMENT_LANGUAGES.map((entry) => (
            <MenuItem key={entry.id} onClick={() => props.onLanguage(entry.id)}>
              {entry.name}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
}
