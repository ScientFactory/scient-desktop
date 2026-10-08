import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  useProjectEntriesQuery,
  refreshProjectFiles,
  setProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import {
  NEW_DOCUMENT_LANGUAGES,
  NEW_DOCUMENT_TEMPLATES,
  createNewDocumentSource,
  newDocumentPath,
  type DocumentTemplateId,
  type NewDocumentFormat,
  type NewDocumentLanguage,
} from "./documentTemplates";
import "./documents.css";

function isPathExists(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  return (
    typeof error === "object" &&
    error !== null &&
    "failure" in error &&
    error.failure === "path_exists"
  );
}

/**
 * A new document before it exists: an empty page with its title. Enter creates
 * the file from the title and hands it to the editor; Escape leaves. A LaTeX
 * page also offers its starting template and language, the only setup there is.
 */
export function ScientDocumentsPanel(props: {
  environmentId: EnvironmentId;
  cwd: string;
  format: NewDocumentFormat;
  onCreated: (path: string) => void;
  onCancel: () => void;
}) {
  const files = useProjectEntriesQuery(props.environmentId, props.cwd);
  const createFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState<DocumentTemplateId>("blank");
  const [language, setLanguage] = useState<NewDocumentLanguage>("english");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const latex = props.format === "latex";
  const languageName = NEW_DOCUMENT_LANGUAGES.find((entry) => entry.id === language)!.name;

  const create = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const contents = createNewDocumentSource({
        format: props.format,
        title,
        template,
        language,
      });
      const taken = (files.data?.entries ?? []).map((entry) => entry.path);
      // The listing can be behind the disk; a name taken meanwhile moves to the next free one.
      for (let attempt = 0; attempt < 5; attempt++) {
        const path = newDocumentPath(title, props.format, taken);
        const result = await createFile({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, relativePath: path, contents, createOnly: true },
        });
        if (result._tag === "Success") {
          setProjectFileQueryData(
            props.environmentId,
            props.cwd,
            result.value.relativePath,
            contents,
            result.value.revision,
          );
          refreshProjectFiles(props.environmentId, props.cwd);
          props.onCreated(result.value.relativePath);
          return;
        }
        if (result._tag !== "Failure" || !isPathExists(result)) break;
        taken.push(path);
      }
      setError("The document could not be created.");
    } catch {
      setError("The document could not be created.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <section
      className="scient-new-document"
      data-format={props.format}
      aria-label={latex ? "New LaTeX document" : "New Markdown document"}
    >
      <div className="scient-new-document-page" dir={language === "hebrew" ? "rtl" : undefined}>
        <input
          className="scient-new-document-title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              void create();
            } else if (event.key === "Escape") {
              event.preventDefault();
              props.onCancel();
            }
          }}
          placeholder="Title"
          aria-label="Title"
          dir="auto"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
          autoFocus
        />
        {latex ? (
          <div className="scient-new-document-options" dir="ltr">
            <div role="radiogroup" aria-label="Template">
              {NEW_DOCUMENT_TEMPLATES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={template === entry.id}
                  disabled={busy}
                  onClick={() => setTemplate(entry.id)}
                >
                  {entry.name}
                </button>
              ))}
            </div>
            <Menu>
              <MenuTrigger render={<button type="button" disabled={busy} aria-label="Language" />}>
                {languageName}
                <ChevronDown aria-hidden="true" />
              </MenuTrigger>
              <MenuPopup align="end" side="bottom" sideOffset={4}>
                {NEW_DOCUMENT_LANGUAGES.map((entry) => (
                  <MenuItem key={entry.id} onClick={() => setLanguage(entry.id)}>
                    {entry.name}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="scient-new-document-error">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
