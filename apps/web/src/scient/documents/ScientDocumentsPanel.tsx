import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  FileText,
  FolderOpen,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
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
  documentFilename,
  documentPath,
  type DocumentTemplateId,
} from "./documentTemplates";
import "./documents.css";

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
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
      return Array.isArray(value)
        ? value.filter((path): path is string => typeof path === "string").slice(0, 12)
        : [];
    } catch {
      return [];
    }
  });
  const [query, setQuery] = useState("");
  const [template, setTemplate] = useState<DocumentTemplateId | "custom" | null>(null);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [course, setCourse] = useState("");
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
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (template) titleInput.current?.focus();
  }, [template]);
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
  const sourcePreview = useMemo(
    () =>
      template && template !== "custom"
        ? createDocumentSource({ template, title, author, course })
        : null,
    [template, title, author, course],
  );
  const open = (path: string) => {
    const next = [path, ...recent.filter((entry) => entry !== path)].slice(0, 12);
    setRecent(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* File opening does not depend on history storage. */
    }
    props.onOpenDocument(path);
  };
  const submit = async () => {
    if (!template || submitting.current) return;
    const path = documentPath(filename || documentFilename(title));
    if (!path) {
      setError("Choose a .tex filename inside this project, such as documents/proposal.tex.");
      return;
    }
    if (!title.trim() && template !== "custom") {
      setError("Give your document a title.");
      titleInput.current?.focus();
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
      } else contents = sourcePreview!;
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
        {template ? (
          <form
            className="scient-document-create"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <button
              type="button"
              className="scient-documents-back"
              disabled={busy}
              onClick={() => {
                setTemplate(null);
                setError(null);
              }}
            >
              <ArrowLeft size={15} /> All documents
            </button>
            <h2>
              {template === "custom"
                ? "Use a project template"
                : `New ${DOCUMENT_TEMPLATES.find((entry) => entry.id === template)?.name.toLowerCase()}`}
            </h2>
            <p>
              {template === "custom"
                ? "Create a separate copy of an existing LaTeX document. Its supporting files stay in the project."
                : DOCUMENT_TEMPLATES.find((entry) => entry.id === template)?.detail}
            </p>
            <fieldset disabled={busy}>
              {template === "custom" ? (
                <label>
                  Template
                  <select
                    value={customPath}
                    onChange={(event) => {
                      const path = event.target.value;
                      setCustomPath(path);
                      setFilename(path.replace(/\.tex$/iu, "-copy.tex"));
                    }}
                  >
                    <option value="">Choose a .tex file…</option>
                    {documents.map((path) => (
                      <option key={path} value={path}>
                        {path}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <>
                  <label>
                    Document title
                    <input
                      ref={titleInput}
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder="What are you working on?"
                      maxLength={250}
                      required
                    />
                  </label>
                  <div className="scient-document-fields">
                    <label>
                      Author <span>Optional</span>
                      <input
                        value={author}
                        onChange={(event) => setAuthor(event.target.value)}
                        autoComplete="name"
                        maxLength={250}
                      />
                    </label>
                    <label>
                      {template === "assignment" ? "Course" : "Institution / course"}{" "}
                      <span>Optional</span>
                      <input
                        value={course}
                        onChange={(event) => setCourse(event.target.value)}
                        maxLength={250}
                      />
                    </label>
                  </div>
                </>
              )}
              <label>
                Save in project
                <input
                  ref={template === "custom" ? titleInput : undefined}
                  value={filename}
                  onChange={(event) => setFilename(event.target.value)}
                  placeholder={documentFilename(title)}
                  spellCheck={false}
                />
                <small>{props.cwd}</small>
              </label>
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
              <button className="scient-documents-primary" type="submit" disabled={busy}>
                {busy ? "Creating…" : "Create and start writing"}
                <ArrowUpRight size={16} />
              </button>
            </fieldset>
            {sourcePreview !== null ? (
              <details className="scient-document-source-preview">
                <summary>Preview LaTeX source</summary>
                <p>
                  This is the complete source that will be saved, including starter text for you to
                  replace.
                </p>
                <pre>
                  <code>{sourcePreview}</code>
                </pre>
              </details>
            ) : null}
          </form>
        ) : (
          <>
            <div className="scient-documents-intro">
              <h2>What would you like to write?</h2>
              <p>Start with a structure, then make it your own.</p>
            </div>
            <div className="scient-document-templates">
              {DOCUMENT_TEMPLATES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    setTemplate(entry.id);
                    setFilename("");
                    setError(null);
                    setCreatedPath(null);
                  }}
                >
                  <span className="scient-document-template-paper">
                    <FileText size={24} strokeWidth={1.3} />
                  </span>
                  <strong>{entry.name}</strong>
                  <span>{entry.description}</span>
                  <Plus className="scient-document-template-plus" size={15} />
                </button>
              ))}
            </div>
            <div className="scient-documents-secondary">
              <button
                type="button"
                onClick={() => {
                  setTemplate("custom");
                  setFilename("");
                  setError(null);
                  setCreatedPath(null);
                }}
              >
                Use a project template
              </button>
              <button type="button" onClick={() => searchInput.current?.focus()}>
                Open existing document
              </button>
            </div>
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
                      : "Choose a starter above, or open an existing LaTeX project from the project sidebar."}
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
                          {path.includes("/")
                            ? path.slice(0, path.lastIndexOf("/"))
                            : "Project folder"}
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
              Saved as LaTeX files in your project. Writing works offline; PDF export uses your
              local TeX installation.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
