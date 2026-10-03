import * as Schema from "effect/Schema";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, FileText, FolderOpen, RefreshCw, Search } from "lucide-react";
import { projectEnvironment } from "~/state/projects";
import { toastManager } from "~/components/ui/toast";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import {
  useProjectEntriesQuery,
  refreshProjectFiles,
  setProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import {
  DOCUMENT_TEMPLATES,
  createDocumentSource,
  documentTitleFromFilename,
  availableDocumentPath,
  documentPath,
  type DocumentTemplateId,
} from "./documentTemplates";
import "./documents.css";

const RecentDocuments = Schema.Array(Schema.String);
const EMPTY_RECENT: readonly string[] = [];

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  if (
    typeof error === "object" &&
    error !== null &&
    "failure" in error &&
    error.failure === "path_exists"
  )
    return "A file already exists at this location. Choose another filename.";
  const message =
    error instanceof Error ? error.message : "The file could not be saved. Please try again.";
  const operation =
    typeof error === "object" &&
    error !== null &&
    "operation" in error &&
    typeof error.operation === "string"
      ? error.operation
      : null;
  return operation ? `${message} Failed operation: ${operation}.` : message;
}

export function ScientDocumentsPanel(props: {
  environmentId: EnvironmentId;
  cwd: string;
  projectTitle: string;
  onOpenDocument: (path: string) => void;
  onOpenFiles: () => void;
}) {
  const files = useProjectEntriesQuery(props.environmentId, props.cwd);
  const createFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const readFile = useAtomQueryRunner(projectEnvironment.readFile, {
    reportFailure: false,
    refresh: true,
  });
  const storageKey = `scient.documents.recent:${JSON.stringify([props.environmentId, props.cwd])}`;
  const [recent, setRecent] = useLocalStorage<readonly string[], readonly string[]>(
    storageKey,
    EMPTY_RECENT,
    RecentDocuments,
  );
  const [query, setQuery] = useState("");
  const [template, setTemplate] = useState<DocumentTemplateId | "custom">("blank");
  const [filename, setFilename] = useState("");
  const [customPath, setCustomPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdPath, setCreatedPath] = useState<string | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const searchInput = useRef<HTMLInputElement>(null);
  const filenameInput = useRef<HTMLInputElement>(null);
  const documents = useMemo(
    () =>
      (files.data?.entries ?? [])
        .filter((entry) => entry.kind === "file" && /\.tex$/iu.test(entry.path))
        .map((entry) => entry.path)
        .sort((a, b) => a.localeCompare(b)),
    [files.data],
  );
  const visible = documents.filter((path) =>
    path.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const recentDocuments = recent.filter((path) => documents.includes(path));
  const open = (path: string) => {
    const next = [path, ...recent.filter((entry) => entry !== path)].slice(0, 12);
    setRecent(next);
    props.onOpenDocument(path);
  };
  const submit = async () => {
    if (submitting.current) return;
    const requestedPath = documentPath(filename);
    const path =
      requestedPath &&
      availableDocumentPath(
        requestedPath,
        (files.data?.entries ?? []).map((entry) => entry.path),
      );
    if (!path) {
      setError("Choose a .tex filename inside this project, such as documents/proposal.tex.");
      filenameInput.current?.focus();
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    setCreatedPath(null);
    let savedPath: string | null = null;
    try {
      let contents: string;
      if (template === "custom") {
        if (!documents.includes(customPath)) {
          setError("Choose a LaTeX template from this project.");
          return;
        }
        // Relative images, included chapters, and class files must keep the same base.
        const parent = (value: string) => value.slice(0, value.lastIndexOf("/") + 1);
        if (parent(path) !== parent(customPath)) {
          setError("Save the copy beside its template so included files and images keep working.");
          return;
        }
        const result = await readFile({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, relativePath: customPath },
        });
        if (result._tag !== "Success") {
          setError(
            result._tag === "Failure" ? failureMessage(result) : "The template could not be read.",
          );
          return;
        }
        if (result.value.truncated) {
          setError("This template is too large to copy here. Open it from Files instead.");
          return;
        }
        contents = result.value.contents;
      } else
        contents = createDocumentSource({
          template,
          title: documentTitleFromFilename(path),
          author: "",
          course: "",
        });
      if (!mounted.current) return;
      const result = await createFile({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, relativePath: path, contents, createOnly: true },
      });
      if (result._tag !== "Success") {
        setError(
          result._tag === "Failure"
            ? failureMessage(result)
            : "The document could not be created. Please try again.",
        );
        return;
      }
      savedPath = result.value.relativePath;
      if (mounted.current) setCreatedPath(savedPath);
      toastManager.add({ type: "success", title: "Document created", description: savedPath });
      setProjectFileQueryData(
        props.environmentId,
        props.cwd,
        result.value.relativePath,
        contents,
        result.value.revision,
      );
      refreshProjectFiles(props.environmentId, props.cwd);
      if (mounted.current) open(result.value.relativePath);
    } catch (error) {
      setError(
        savedPath
          ? `Saved ${savedPath}, but could not open it. Open it from Project files.`
          : error instanceof Error
            ? error.message
            : "Could not create the document.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="scient-documents" aria-label="Documents">
      <header className="scient-documents-header">
        <div>
          <span>{props.projectTitle}</span>
          <h1>Documents</h1>
        </div>
        <button type="button" onClick={props.onOpenFiles}>
          <FolderOpen size={16} /> Project files
        </button>
      </header>
      <div className="scient-documents-content">
        <form
          className="scient-document-create"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2>New document</h2>
          <fieldset disabled={busy}>
            <label htmlFor="scient-document-filename">Filename</label>
            <div className="scient-document-create-row">
              <input
                id="scient-document-filename"
                ref={filenameInput}
                value={filename}
                onChange={(event) => {
                  setFilename(event.target.value);
                  setError(null);
                }}
                placeholder="My document.tex"
                spellCheck={false}
                autoComplete="off"
                required
              />
              <button
                className="scient-documents-primary"
                type="submit"
                disabled={busy || !filename.trim()}
              >
                {busy ? "Creating..." : "Create"}
                <ArrowUpRight size={16} />
              </button>
            </div>
            <small className="scient-document-filename-hint">
              The filename becomes the default title. You can change the title while writing.
            </small>
            <details className="scient-document-template-options">
              <summary>
                {template === "blank"
                  ? "Use a template"
                  : template === "custom"
                    ? "Project template"
                    : DOCUMENT_TEMPLATES.find((entry) => entry.id === template)?.name}
              </summary>
              <label>
                Starting structure
                <select
                  value={template}
                  onChange={(event) =>
                    setTemplate(event.target.value as DocumentTemplateId | "custom")
                  }
                >
                  <option value="blank">Empty document</option>
                  {DOCUMENT_TEMPLATES.filter((entry) => entry.id !== "blank").map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                  <option value="custom">Copy a project template</option>
                </select>
              </label>
              {template === "custom" ? (
                <label>
                  Template file
                  <select
                    value={customPath}
                    onChange={(event) => {
                      setCustomPath(event.target.value);
                      setFilename(event.target.value.replace(/\.tex$/iu, "-copy.tex"));
                    }}
                  >
                    <option value="">Choose a .tex file...</option>
                    {documents.map((path) => (
                      <option key={path} value={path}>
                        {path}
                      </option>
                    ))}
                  </select>
                  <small>
                    A copy keeps the template's contents and uses its supporting files. Save it
                    beside the original.
                  </small>
                </label>
              ) : null}
            </details>
            {error ? (
              <p role="alert" className="scient-documents-error">
                {error}
              </p>
            ) : null}
            {createdPath ? (
              <p role="status" className="scient-documents-created">
                Saved <strong>{createdPath}</strong>.{" "}
                <button type="button" onClick={() => open(createdPath)}>
                  Open document
                </button>
              </p>
            ) : null}
          </fieldset>
        </form>
        {recentDocuments.length > 0 && !query ? (
          <section aria-label="Recent documents">
            <h3>Recently opened here</h3>
            <div className="scient-document-recents">
              {recentDocuments.slice(0, 4).map((path) => (
                <button key={path} type="button" onClick={() => open(path)}>
                  <FileText size={16} />
                  <span>{path}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        <section aria-label="Project documents">
          <div className="scient-documents-list-heading">
            <h3>In this project</h3>
            <button type="button" onClick={files.refresh} aria-label="Refresh documents">
              <RefreshCw size={15} />
            </button>
          </div>
          <label className="scient-documents-search">
            <Search size={16} />
            <input
              ref={searchInput}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a document…"
              aria-label="Find a document"
            />
          </label>
          {files.error ? (
            <p role="alert" className="scient-documents-error">
              {files.error}
            </p>
          ) : files.isPending && !files.data ? (
            <p role="status">Loading documents…</p>
          ) : visible.length === 0 ? (
            <div className="scient-documents-empty">
              <FileText size={26} />
              <p>{query ? "No matching documents." : "Your documents will appear here."}</p>
              <span>
                {query
                  ? "Try another name or browse Project files."
                  : "Enter a filename above to start writing, or open an existing LaTeX project from the project sidebar."}
              </span>
            </div>
          ) : (
            <div className="scient-documents-list">
              {visible.map((path) => (
                <button key={path} type="button" onClick={() => open(path)}>
                  <FileText size={18} />
                  <span>
                    <strong>{path.split("/").at(-1)}</strong>
                    <small>
                      {path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "Project folder"}
                    </small>
                  </span>
                  <ArrowUpRight size={15} />
                </button>
              ))}
            </div>
          )}
          {files.data?.truncated ? (
            <p>
              Some files aren’t listed.{" "}
              <button type="button" onClick={props.onOpenFiles}>
                Browse all project files
              </button>
            </p>
          ) : null}
        </section>
        <p className="scient-documents-footnote">
          Saved as LaTeX files in your project. Writing works offline; PDF export uses your local
          TeX installation.
        </p>
      </div>
    </section>
  );
}
