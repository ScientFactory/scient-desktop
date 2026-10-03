import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import { documentFailureReason } from "~/scient/markdownEditor/persistence/documentFailureReason";
import { onDocumentSaved } from "~/scient/markdownEditor/persistence/documentPublication";
import type { MarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { ScientMarkdownPersistenceNotice } from "~/scient/markdownEditor/ui/ScientMarkdownPersistenceNotice";
import { useMarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/useMarkdownPersistenceLease";
import { projectEnvironment } from "~/state/projects";
import { checkpointVisualDraft, confirmVisualDraft, flushVisualDraft } from "./visualDrafts";
import { bibliographyPaths } from "./latexAuthoringModel";
import { LatexSelect } from "./LatexSelect";
import {
  addBibliographyEntry,
  bibliographyEntrySource,
  bibliographyEntryTitle,
  bibtexEntries,
  manualBibliography,
  mergeBibliographyChange,
  replaceBibliographyEntry,
  validBibliographyKey,
  type BibliographyEntry,
} from "./latexBibliographyModel";

export interface BibliographyDocument {
  id: string;
  path: string;
  source: string;
  kind: "bibitem" | "bibtex";
  readOnly: boolean;
  pending?: boolean;
  error?: string | null;
  persistence?: MarkdownPersistenceLease | null;
  apply: (expected: string, next: string) => boolean | Promise<boolean>;
}
export interface BibliographyDetails {
  key: string;
  title: string;
  path: string;
}
export interface ReferenceFileCallbacks {
  onSaved: () => void;
}

/** A linked bibliography shares the same revision-checked session as its other views. */
function BibliographyFile(props: {
  environmentId: EnvironmentId;
  cwd: string;
  path: string;
  update: (file: BibliographyDocument) => void;
  callbacks?: ReferenceFileCallbacks | undefined;
}) {
  const { environmentId, cwd, path } = props;
  const query = useProjectFileQuery(environmentId, cwd, path);
  const target = useMemo(
    () => ({ environmentId, cwd, relativePath: path }),
    [environmentId, cwd, path],
  );
  const { lease, snapshot, admissionError, retryAdmission } = useMarkdownPersistenceLease({
    target,
    authoritativeSnapshot: query.authoritativeData,
  });
  const refresh = query.refresh;
  useEffect(() => refresh(), [refresh]);
  const changes = useAtomValue(
    projectEnvironment.fileChanges({ environmentId, input: { cwd, relativePath: path } }),
  );
  const change = Option.getOrNull(AsyncResult.value(changes));
  const seenChange = useRef(change);
  const sessionOpen = lease !== null;
  useEffect(() => {
    if (change === seenChange.current) return;
    seenChange.current = change;
    if (sessionOpen) return;
    refresh();
    retryAdmission();
  }, [change, sessionOpen, refresh, retryAdmission]);
  const draftKey = `${environmentId}\0${cwd}\0${path}`;
  const pending = snapshot?.pending ?? false;
  const needsAttention =
    snapshot !== null && (snapshot.conflict !== null || snapshot.error !== null);
  const saveError = needsAttention
    ? `Could not save ${path}. Resolve the save in References.`
    : null;
  const saved = useEffectEvent((source: string) => {
    confirmVisualDraft(draftKey, source);
    props.callbacks?.onSaved();
  });
  useEffect(
    () => (lease === null ? undefined : onDocumentSaved(lease, ({ source }) => saved(source))),
    [lease],
  );
  useEffect(
    () => () => {
      flushVisualDraft(draftKey);
    },
    [draftKey],
  );
  const apply = useCallback(
    async (expected: string, next: string) => {
      if (lease === null) return false;
      const current = lease.getSnapshot();
      if (current.editingBlocked) return false;
      const merged = mergeBibliographyChange(expected, next, current.draftSource, "bibtex");
      if (merged === null) return false;
      if (current.draftSource !== merged) {
        if (!lease.change(merged, current.editVersion)) return false;
        checkpointVisualDraft(
          draftKey,
          merged,
          current.draftSource,
          merged,
          current.baselineRevision,
        );
      }
      return lease.flushNow();
    },
    [lease, draftKey],
  );
  const disk = query.authoritativeData;
  const error =
    saveError ??
    (admissionError !== null
      ? (documentFailureReason(admissionError) ??
        (admissionError instanceof Error ? admissionError.message : `Could not open ${path}.`))
      : query.error) ??
    (disk?.truncated ? "This file is too large to edit here." : null);
  const source = snapshot?.draftSource ?? disk?.contents ?? "";
  const readOnly = lease === null || snapshot?.editingBlocked === true;
  const update = props.update;
  const loading = query.isPending || pending || (lease === null && disk === null && error === null);
  useEffect(() => {
    update({
      id: `bib:${path}`,
      path,
      source,
      kind: "bibtex",
      readOnly,
      pending: loading,
      error,
      persistence: lease,
      apply,
    });
  }, [update, path, source, readOnly, loading, error, lease, apply]);
  return null;
}

const mainFields = ["title", "author", "year"];
const extraFields = [
  "journal",
  "booktitle",
  "publisher",
  "volume",
  "number",
  "pages",
  "doi",
  "url",
];
const types = [
  "article",
  "book",
  "inproceedings",
  "incollection",
  "techreport",
  "phdthesis",
  "mastersthesis",
  "misc",
];
type EntryDraft = {
  documentId: string;
  original: string;
  entry: BibliographyEntry;
  isNew: boolean;
  key: string;
  type: string;
  fields: Record<string, string>;
  body: string;
  label: string;
  sourceMode: boolean;
  raw: string;
  containerIndex: number;
};
const referenceDrafts = new Map<string, EntryDraft>();

function entryDraft(
  document: BibliographyDocument,
  entry: BibliographyEntry,
  isNew = false,
): EntryDraft {
  return {
    documentId: document.id,
    original: document.source,
    entry,
    isNew,
    key: entry.key,
    type: entry.type,
    fields: Object.fromEntries(
      [...new Set([...mainFields, ...extraFields, ...entry.fields.map((field) => field.name)])].map(
        (name) => {
          const field = entry.fields.find((field) => field.name === name);
          return [
            name,
            field?.text ?? (field ? document.source.slice(field.valueFrom, field.valueTo) : ""),
          ];
        },
      ),
    ),
    body: entry.body,
    label: entry.label,
    sourceMode: false,
    raw: entry.raw,
    containerIndex: Math.max(
      0,
      manualBibliography(document.source).containers.findIndex(
        (container) => entry.from > container.from && entry.to <= container.insertAt,
      ),
    ),
  };
}

function draftSource(draft: EntryDraft) {
  if (draft.sourceMode) return draft.raw;
  const raw = bibliographyEntrySource(draft.entry, draft);
  return raw;
}

/** Document-scoped reference management; insertion remains in the writing menu. */
export function LatexReferencesPanel(props: {
  open: boolean;
  request: { key?: string; sequence: number };
  onClose: () => void;
  documents: readonly BibliographyDocument[];
  setupSource: string;
  rootRelativePath: string;
  environmentId?: EnvironmentId | undefined;
  cwd?: string | undefined;
  disabled: boolean;
  onSetup: () => void;
  onDraftChange: (pending: boolean) => void;
  onSaved: () => void;
  loadDetails: boolean;
  onCatalogChange: (entries: BibliographyDetails[]) => void;
  draftKey: string;
  onOpenSource: (id: string, path: string, offset?: number) => void;
  fileCallbacks?: ReferenceFileCallbacks | undefined;
  canOpenFiles: boolean;
}) {
  const [files, setFiles] = useState<Record<string, BibliographyDocument>>({});
  const [query, setQuery] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [draft, setDraft] = useState<EntryDraft | null>(
    () => referenceDrafts.get(props.draftKey) ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [containerIndex, setContainerIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const paths = useMemo(
    () => bibliographyPaths(props.setupSource, props.rootRelativePath),
    [props.setupSource, props.rootRelativePath],
  );
  const updateFile = useCallback(
    (file: BibliographyDocument) => setFiles((current) => ({ ...current, [file.id]: file })),
    [],
  );
  const documents = useMemo(
    () => [
      ...props.documents.filter(
        (document) => manualBibliography(document.source).containers.length > 0,
      ),
      ...paths
        .slice(0, 24)
        .flatMap((path) => (files[`bib:${path}`] ? [files[`bib:${path}`]!] : [])),
    ],
    [props.documents, paths, files],
  );
  const indexed = useMemo(
    () =>
      documents.map((document) => ({
        document,
        parsed:
          document.kind === "bibtex"
            ? bibtexEntries(document.source)
            : manualBibliography(document.source),
      })),
    [documents],
  );
  const candidates = useMemo(
    () =>
      indexed.flatMap(({ document, parsed }) =>
        parsed.entries.map((entry) => ({ document, entry })),
      ),
    [indexed],
  );
  const catalogChanged = props.onCatalogChange;
  useEffect(
    () =>
      catalogChanged(
        candidates.map(({ document, entry }) => ({
          key: entry.key,
          title: bibliographyEntryTitle(entry),
          path: document.path,
        })),
      ),
    [candidates, catalogChanged],
  );
  const target =
    documents.find((document) => document.id === (draft?.documentId ?? documentId)) ?? documents[0];
  const raw = draft ? draftSource(draft) : null;
  const dirty = !!draft && (draft.isNew || raw !== draft.entry.raw);
  useEffect(() => {
    if (dirty && draft) referenceDrafts.set(props.draftKey, draft);
    else referenceDrafts.delete(props.draftKey);
  }, [props.draftKey, draft, dirty]);
  const draftReporter = props.onDraftChange;
  const filePending = Object.values(files).some((file) => file.pending);
  useEffect(() => {
    draftReporter(dirty || saving || filePending);
    return () => draftReporter(false);
  }, [dirty, saving, filePending, draftReporter]);
  const requestSeen = useRef(-1);
  useEffect(() => {
    if (!props.open || requestSeen.current === props.request.sequence) return;
    if (dirty) {
      setNotice("Save or cancel the current entry before opening another reference.");
      return;
    }
    const selected = props.request.key
      ? candidates.find(({ entry }) => entry.key === props.request.key)
      : null;
    if (
      props.request.key &&
      !selected &&
      props.environmentId &&
      props.cwd &&
      paths.slice(0, 24).some((path) => !files[`bib:${path}`] || files[`bib:${path}`]?.pending)
    )
      return;
    requestSeen.current = props.request.sequence;
    setQuery("");
    setNotice(null);
    setRemoveConfirm(false);
    if (selected) {
      setDocumentId(selected.document.id);
      const selectedDraft = entryDraft(selected.document, selected.entry);
      setDraft(selectedDraft);
      setContainerIndex(selectedDraft.containerIndex);
    } else {
      setDraft(null);
      if (props.request.key) {
        setQuery(props.request.key);
        setNotice(`No bibliography entry was found for ${props.request.key}.`);
      }
    }
    requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
  }, [props.open, props.request, props.environmentId, props.cwd, candidates, files, paths, dirty]);
  // Once read, keep the leases through closing the panel so pending/error
  // reports continue to describe the same bibliography sessions.
  const resourcePaths = [
    ...new Set([
      ...(props.open || props.loadDetails ? paths.slice(0, 24) : []),
      ...Object.values(files).map((file) => file.path),
    ]),
  ];
  const resources =
    props.environmentId && props.cwd
      ? resourcePaths.map((path) => (
          <BibliographyFile
            key={path}
            environmentId={props.environmentId!}
            cwd={props.cwd!}
            path={path}
            update={updateFile}
            callbacks={props.fileCallbacks}
          />
        ))
      : null;
  if (!props.open) return resources;
  const choose = (document: BibliographyDocument, entry: BibliographyEntry) => {
    if (dirty) {
      setNotice("Save or cancel this entry before selecting another.");
      return;
    }
    setDocumentId(document.id);
    const nextDraft = entryDraft(document, entry);
    setDraft(nextDraft);
    setContainerIndex(nextDraft.containerIndex);
    setRemoveConfirm(false);
    setNotice(null);
  };
  const add = () => {
    if (!target || target.readOnly || props.disabled) return;
    if (dirty) {
      setNotice("Save or cancel this entry before adding another.");
      return;
    }
    const keys = new Set(candidates.map(({ entry }) => entry.key));
    let number = 1;
    while (keys.has(`reference${number}`)) number++;
    const key = `reference${number}`;
    const source =
      target.kind === "bibtex"
        ? `@misc{${key},\n}\n`
        : `\\begin{thebibliography}{99}\n\\bibitem{${key}} \n\\end{thebibliography}`;
    const entry = (target.kind === "bibtex" ? bibtexEntries(source) : manualBibliography(source))
      .entries[0];
    if (entry) {
      setDraft({ ...entryDraft(target, entry, true), containerIndex });
      setRemoveConfirm(false);
      setNotice(null);
    }
  };
  const apply = async (remove = false) => {
    if (!draft || !target || saving || props.disabled || target.readOnly) return;
    const parsed =
      target.kind === "bibtex" ? bibtexEntries(draft.original) : manualBibliography(draft.original);
    const key = draft.isNew ? draft.key : draft.entry.key;
    if (
      parsed.error ||
      !validBibliographyKey(key) ||
      (draft.isNew && candidates.some(({ entry }) => entry.key === key))
    ) {
      setNotice(parsed.error ?? "Use a unique citation key without spaces or LaTeX commands.");
      return;
    }
    const source = raw;
    const next = remove
      ? draft.original.slice(0, draft.entry.from) + draft.original.slice(draft.entry.to)
      : source === null
        ? null
        : draft.isNew
          ? addBibliographyEntry(
              draft.original,
              target.kind,
              key,
              source,
              target.kind === "bibitem"
                ? manualBibliography(draft.original).containers[draft.containerIndex]?.insertAt
                : undefined,
            )
          : replaceBibliographyEntry(draft.original, draft.entry, source);
    if (next === null) {
      setNotice(
        "Check the entry’s LaTeX/BibTeX syntax and keep the existing citation key unchanged.",
      );
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      if (await target.apply(draft.original, next)) {
        setDraft(null);
        setRemoveConfirm(false);
        props.onSaved();
        setNotice(
          remove ? "Reference removed. Existing citations keep their keys." : "Reference saved.",
        );
      } else
        setNotice(
          "The file changed or could not be saved. Your entry draft is retained. Resolve the file conflict before saving again.",
        );
    } catch {
      setNotice("Could not save this reference. Your draft is retained.");
    } finally {
      setSaving(false);
    }
  };
  const change = (patch: Partial<EntryDraft>) => {
    setDraft((current) => current && { ...current, ...patch });
    setRemoveConfirm(false);
  };
  const writable = !!target && !target.readOnly && !props.disabled;
  const parserError = indexed.find(({ document }) => document.id === target?.id)?.parsed.error;
  const containers = target?.kind === "bibitem" ? manualBibliography(target.source).containers : [];
  const filtered = candidates.filter(({ document, entry }) =>
    `${entry.key} ${entry.body} ${document.path}`.toLowerCase().includes(query.toLowerCase()),
  );
  const entryExtraFields = draft
    ? [...new Set([...extraFields, ...draft.entry.fields.map((field) => field.name)])].filter(
        (name) => !mainFields.includes(name),
      )
    : [];
  return (
    <aside
      className="scient-latex-references-panel"
      aria-label="References"
      data-dock-command-scope="latex"
    >
      {resources}
      <div className="scient-latex-references-header">
        <strong>References</strong>
        <Button
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() =>
            dirty
              ? setNotice("Save or cancel your entry draft before closing References.")
              : props.onClose()
          }
        >
          Close
        </Button>
      </div>
      <div className="scient-latex-references-content">
        <Input
          ref={input}
          aria-label="Search bibliography entries"
          placeholder="Search title, author, year or key…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {documents.length > 0 ? (
          <label>
            Add to
            <LatexSelect
              aria-label="Bibliography destination"
              value={target?.id ?? ""}
              disabled={dirty || saving}
              onValueChange={(value) => {
                setDocumentId(value);
                setDraft(null);
                setContainerIndex(0);
              }}
              options={documents.map((document) => ({
                value: document.id,
                label: `${document.path} · ${document.kind === "bibtex" ? ".bib" : "manual entries"}`,
              }))}
            />
          </label>
        ) : null}
        {containers.length > 1 ? (
          <label>
            Bibliography block
            <LatexSelect
              aria-label="Manual bibliography block"
              value={Math.min(containerIndex, containers.length - 1)}
              disabled={dirty || saving}
              onValueChange={(value) => {
                setContainerIndex(Number(value));
                setDraft(null);
              }}
              options={containers.map((_container, index) => ({
                value: String(index),
                label: `Bibliography ${index + 1}`,
              }))}
            />
          </label>
        ) : null}
        <div className="scient-latex-references-actions">
          <Button size="sm" disabled={!writable || !!parserError || dirty || saving} onClick={add}>
            Add reference
          </Button>
          {documents.length === 0 && !paths.length ? (
            <Button size="sm" variant="outline" disabled={props.disabled} onClick={props.onSetup}>
              Set up bibliography…
            </Button>
          ) : null}
        </div>
        {paths.length > 24 ? (
          <p role="status">The first 24 linked bibliography files are shown.</p>
        ) : null}
        {paths.length && (!props.environmentId || !props.cwd) ? (
          <p role="status">Connect to the project to read its .bib files.</p>
        ) : null}
        {indexed.map(({ document, parsed }) =>
          document.error || parsed.error ? (
            <div role="alert" key={document.id}>
              {document.path}: {document.error ?? parsed.error}
              {document.persistence ? (
                <ScientMarkdownPersistenceNotice persistence={document.persistence} />
              ) : null}
              <Button
                variant="outline"
                size="sm"
                disabled={document.kind === "bibtex" && !props.canOpenFiles}
                onClick={() => props.onOpenSource(document.id, document.path)}
              >
                Open file in Source
              </Button>
            </div>
          ) : null,
        )}
        <div
          className="scient-latex-references-list"
          role="group"
          aria-label="Bibliography entries"
        >
          {filtered.slice(0, 200).map(({ document, entry }) => (
            <button
              type="button"
              key={`${document.id}:${entry.from}:${entry.key}`}
              aria-pressed={
                draft?.documentId === document.id && draft.entry.from === entry.from && !draft.isNew
              }
              disabled={saving}
              onClick={() => choose(document, entry)}
            >
              <strong>{bibliographyEntryTitle(entry)}</strong>
              <small>
                {entry.key} · {document.path}
              </small>
            </button>
          ))}
          {!filtered.length ? (
            <p>
              {paths.length && !documents.some((document) => document.kind === "bibtex")
                ? "Reading linked bibliography…"
                : candidates.length
                  ? "No matching bibliography entries."
                  : "No bibliography entries yet."}
            </p>
          ) : null}
          {filtered.length > 200 ? (
            <p>Showing the first 200 matches. Refine your search to find an entry.</p>
          ) : null}
        </div>
        {draft ? (
          <form
            className="scient-latex-reference-entry"
            onSubmit={(event) => {
              event.preventDefault();
              void apply();
            }}
          >
            <h3>{draft.isNew ? "New reference" : "Edit reference"}</h3>
            <label>
              Citation key
              <Input
                value={draft.key}
                readOnly={!draft.isNew}
                disabled={!writable || saving}
                onChange={(event) => change({ key: event.target.value })}
                aria-label="Reference citation key"
              />
            </label>
            {!draft.isNew ? (
              <p className="scient-latex-references-help">
                The key stays fixed so existing citations keep working.
              </p>
            ) : null}
            {draft.sourceMode ? (
              <label>
                Entry source
                <textarea
                  aria-label="Bibliography entry source"
                  value={draft.raw}
                  disabled={!writable || saving}
                  rows={10}
                  onChange={(event) => change({ raw: event.target.value })}
                />
              </label>
            ) : draft.entry.kind === "bibitem" ? (
              <>
                <label>
                  Custom label (optional)
                  <Input
                    value={draft.label}
                    disabled={!writable || saving}
                    onChange={(event) => change({ label: event.target.value })}
                  />
                </label>
                <label>
                  Entry text (LaTeX)
                  <textarea
                    aria-label="Reference entry text"
                    value={draft.body}
                    rows={6}
                    disabled={!writable || saving}
                    onChange={(event) => change({ body: event.target.value })}
                  />
                </label>
                <p className="scient-latex-references-help">
                  Formatting such as \emph&#123;title&#125; is preserved.
                </p>
              </>
            ) : (
              <>
                <label>
                  Entry type
                  <LatexSelect
                    aria-label="Bibliography entry type"
                    value={draft.type}
                    disabled={!writable || saving}
                    onValueChange={(type) => change({ type })}
                    options={[...new Set([...types, draft.type])].map((value) => ({
                      value,
                      label: value,
                    }))}
                  />
                </label>
                {mainFields.map((name) => (
                  <label key={name}>
                    {name[0]!.toUpperCase() + name.slice(1)}
                    <Input
                      aria-label={`Reference ${name}`}
                      value={draft.fields[name] ?? ""}
                      disabled={
                        !writable ||
                        saving ||
                        draft.entry.fields.find((field) => field.name === name)?.text === null
                      }
                      onChange={(event) =>
                        change({ fields: { ...draft.fields, [name]: event.target.value } })
                      }
                    />
                  </label>
                ))}
                <details>
                  <summary>More fields</summary>
                  {entryExtraFields.map((name) => (
                    <label key={name}>
                      {name}
                      <Input
                        value={draft.fields[name] ?? ""}
                        disabled={
                          !writable ||
                          saving ||
                          draft.entry.fields.find((field) => field.name === name)?.text === null
                        }
                        onChange={(event) =>
                          change({ fields: { ...draft.fields, [name]: event.target.value } })
                        }
                      />
                    </label>
                  ))}
                </details>
                <p className="scient-latex-references-help">
                  TeX formatting and other fields are preserved. Fields defined by BibTeX
                  expressions can be edited in Entry source.
                </p>
              </>
            )}
            {!draft.sourceMode ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={raw === null || saving}
                onClick={() => change({ sourceMode: true, raw: raw ?? "" })}
              >
                Edit entry source
              </Button>
            ) : null}
            {notice ? <p role="status">{notice}</p> : null}
            <div className="scient-latex-references-actions">
              <Button size="sm" type="submit" disabled={!writable || saving || !dirty}>
                {saving ? "Saving…" : "Save reference"}
              </Button>
              <Button
                size="sm"
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setDraft(null);
                  setRemoveConfirm(false);
                  setNotice(null);
                }}
              >
                Cancel
              </Button>
              {!draft.isNew ? (
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  disabled={!writable || saving || dirty}
                  onClick={() => setRemoveConfirm(true)}
                >
                  Remove…
                </Button>
              ) : null}
            </div>
            {removeConfirm ? (
              <div role="alert" className="scient-latex-references-removal">
                <p>Remove {draft.entry.key}? Citations using this key will become unresolved.</p>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={saving}
                  onClick={() => void apply(true)}
                >
                  Remove reference
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={() => setRemoveConfirm(false)}
                >
                  Keep reference
                </Button>
              </div>
            ) : null}
          </form>
        ) : notice ? (
          <p role="status">{notice}</p>
        ) : null}
      </div>
    </aside>
  );
}
