import { useContext, useState } from "react";
import { LatexContextAction, LatexContextSection } from "./LatexContextAction";
import { LatexAuthoringContext } from "./latexObjectAuthoring";
import { latexPackageInventory } from "./latexPackages";
import { LatexSelect } from "./LatexSelect";
import { LatexTextField } from "./LatexTextField";
import { metadataText, escapeText } from "./latexVisualDocument";

// Braces protect brackets inside the optional TeX argument without printing them.
const noteText = (text: string) =>
  /[[\]]/u.test(text) ? `{${escapeText(text)}}` : escapeText(text);

/** Edits the cited keys; bibliography records remain in Document > References. */
export function LatexCitationControls(props: {
  keys: readonly string[];
  command: string;
  notes: readonly string[];
  onPresentation: (command: string, notes: string[]) => void;
  entries: readonly { key: string; title: string; path: string }[];
  disabled: boolean;
  onKeys: (keys: string[]) => void;
  onOpen: ((key?: string) => void) | undefined;
}) {
  const [query, setQuery] = useState("");
  const setup = useContext(LatexAuthoringContext);
  const packages = latexPackageInventory(setup.source).loaded;
  const prefix = props.notes.length === 2 ? props.notes[0]! : "";
  const suffix = props.notes.at(-1) ?? "";
  const forms = [
    { value: "cite", label: "Citation" },
    ...(packages.has("natbib")
      ? [
          { value: "citep", label: "Parenthetical" },
          { value: "citet", label: "In text" },
          { value: "citeauthor", label: "Author" },
          { value: "citeyear", label: "Year" },
        ]
      : packages.has("biblatex")
        ? [
            { value: "parencite", label: "Parenthetical" },
            { value: "textcite", label: "In text" },
            { value: "citeauthor", label: "Author" },
            { value: "citeyear", label: "Year" },
          ]
        : []),
  ];
  const cited = new Set(props.keys);
  const entries = new Map(props.entries.map((entry) => [entry.key, entry]));
  const search = query.trim().toLowerCase();
  const available = [...entries.values()].filter(
    (entry) =>
      !cited.has(entry.key) && `${entry.key} ${entry.title}`.toLowerCase().includes(search),
  );
  return (
    <>
      {props.keys.map((key, index) => {
        const entry = entries.get(key);
        return (
          <div key={`${key}:${index}`} className="scient-latex-citation-entry">
            <strong>{entry?.title || key}</strong>
            <p>{key}</p>
            {index > 0 && (
              <LatexContextAction
                disabledReason={props.disabled ? "This citation is read-only." : null}
                onAction={() => {
                  const keys = [...props.keys];
                  [keys[index - 1], keys[index]] = [keys[index]!, keys[index - 1]!];
                  props.onKeys(keys);
                }}
              >
                Move earlier
              </LatexContextAction>
            )}
            <LatexContextAction
              onAction={() => props.onOpen?.(key)}
              disabledReason={!props.onOpen ? "Open the project to manage its references." : null}
            >
              {entry ? "Edit reference" : "Find reference"}
            </LatexContextAction>
            {props.keys.length > 1 && (
              <LatexContextAction
                disabledReason={props.disabled ? "This citation is read-only." : null}
                onAction={() => props.onKeys(props.keys.filter((_, at) => at !== index))}
              >
                Remove from citation
              </LatexContextAction>
            )}
          </div>
        );
      })}
      <LatexContextSection title="Citation form & notes">
        <label>
          Form
          <LatexSelect
            aria-label="Citation form"
            value={props.command}
            disabled={props.disabled}
            options={(forms.some((form) => form.value === props.command)
              ? forms
              : [...forms, { value: props.command, label: props.command }]
            ).map((form) => ({ ...form, disabled: form.value === "cite" && Boolean(prefix) }))}
            onValueChange={(command) => props.onPresentation(command, [...props.notes])}
          />
        </label>
        {props.command !== "cite" && (
          <label>
            Before citation
            <LatexTextField
              aria-label="Citation prefix"
              rows={1}
              disabled={props.disabled || metadataText(prefix) === null}
              value={metadataText(prefix) ?? prefix}
              onValueChange={(value) =>
                props.onPresentation(props.command, [noteText(value), suffix])
              }
            />
          </label>
        )}
        <label>
          Page / note
          <LatexTextField
            aria-label="Citation note"
            rows={1}
            disabled={props.disabled || metadataText(suffix) === null}
            value={metadataText(suffix) ?? suffix}
            onValueChange={(value) =>
              props.onPresentation(
                props.command,
                prefix ? [prefix, noteText(value)] : value ? [noteText(value)] : [],
              )
            }
          />
        </label>
      </LatexContextSection>
      <LatexContextSection title="Add reference to citation">
        <input
          type="search"
          aria-label="Search references for this citation"
          placeholder="Search references…"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        {available.slice(0, 12).map((entry) => (
          <LatexContextAction
            key={entry.key}
            disabledReason={props.disabled ? "This citation is read-only." : null}
            onAction={() => props.onKeys([...props.keys, entry.key])}
          >
            {entry.title || entry.key}
          </LatexContextAction>
        ))}
        {!available.length && <p>No matching unused references.</p>}
        <LatexContextAction
          onAction={() => props.onOpen?.()}
          disabledReason={!props.onOpen ? "Open the project to manage its references." : null}
        >
          Manage references…
        </LatexContextAction>
      </LatexContextSection>
    </>
  );
}
