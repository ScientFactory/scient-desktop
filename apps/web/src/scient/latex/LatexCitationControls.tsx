import { useContext, useState } from "react";
import { Input } from "~/components/ui/input";
import { MenuRadioGroup, MenuSeparator } from "~/components/ui/menu";
import { DockMenu, DockCommandItem, DockCommandRadioItem } from "../writing/dockChrome";
import { LatexAuthoringContext } from "./latexObjectAuthoring";
import { latexPackageInventory } from "./latexPackages";
import { LatexContextMenuForm } from "./LatexContextMenuForm";
import { LatexFooterSubmenu } from "./LatexFooterSubmenu";
import { metadataText, escapeText } from "./latexVisualDocument";

const noteText = (text: string) =>
  /[[\]]/u.test(text) ? "{" + escapeText(text) + "}" : escapeText(text);

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
  if (!forms.some((form) => form.value === props.command))
    forms.push({ value: props.command, label: props.command });
  const entries = new Map(props.entries.map((entry) => [entry.key, entry]));
  const search = query.trim().toLowerCase();
  return (
    <>
      <DockMenu icon={undefined} label="References" commandScope="latex">
        {props.keys.map((key, index) => (
          <LatexFooterSubmenu key={key} label={key}>
            <DockCommandItem disabled={!props.onOpen} onClick={() => props.onOpen?.(key)}>
              {entries.has(key) ? "Edit reference" : "Find reference"}
            </DockCommandItem>
            <DockCommandItem
              disabled={props.disabled || index === 0}
              onClick={() => {
                const keys = [...props.keys];
                [keys[index - 1], keys[index]] = [keys[index]!, keys[index - 1]!];
                props.onKeys(keys);
              }}
            >
              Move earlier
            </DockCommandItem>
            <DockCommandItem
              disabled={props.disabled || props.keys.length <= 1}
              onClick={() => props.onKeys(props.keys.filter((_, at) => at !== index))}
            >
              Remove from citation
            </DockCommandItem>
          </LatexFooterSubmenu>
        ))}
        <MenuSeparator />
        <LatexFooterSubmenu label="Add reference" disabled={props.disabled}>
          <LatexContextMenuForm label="Find citation reference">
            <Input
              size="compact"
              type="search"
              aria-label="Find citation reference"
              placeholder="Search references"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </LatexContextMenuForm>
          {[...entries.values()]
            .filter(
              (entry) =>
                !props.keys.includes(entry.key) &&
                (entry.key + " " + entry.title).toLowerCase().includes(search),
            )
            .map((entry) => (
              <DockCommandItem
                key={entry.key}
                size="compact"
                onClick={() => props.onKeys([...props.keys, entry.key])}
              >
                <span className="truncate">{entry.title || entry.key}</span>
              </DockCommandItem>
            ))}
        </LatexFooterSubmenu>
        <DockCommandItem disabled={!props.onOpen} onClick={() => props.onOpen?.()}>
          Manage references
        </DockCommandItem>
      </DockMenu>
      <DockMenu icon={undefined} label="Form" commandScope="latex" disabled={props.disabled}>
        <MenuRadioGroup value={props.command}>
          {forms.map((form) => (
            <DockCommandRadioItem
              key={form.value}
              value={form.value}
              size="compact"
              disabled={form.value === "cite" && !!prefix}
              onClick={() => props.onPresentation(form.value, [...props.notes])}
            >
              {form.label}
            </DockCommandRadioItem>
          ))}
        </MenuRadioGroup>
      </DockMenu>
      <DockMenu
        icon={undefined}
        label="Note"
        commandScope="latex"
        disabled={props.disabled}
        popupClassName="w-max min-w-0 max-w-(--available-width)"
      >
        <CitationNotes
          key={JSON.stringify([props.command, props.notes])}
          command={props.command}
          notes={props.notes}
          onChange={(notes) => props.onPresentation(props.command, notes)}
        />
      </DockMenu>
    </>
  );
}

function CitationNotes(props: {
  command: string;
  notes: readonly string[];
  onChange: (notes: string[]) => void;
}) {
  const prefix = props.notes.length === 2 ? props.notes[0]! : "";
  const suffix = props.notes.at(-1) ?? "";
  const [before, setBefore] = useState(metadataText(prefix) ?? prefix);
  const [after, setAfter] = useState(metadataText(suffix) ?? suffix);
  const editable = metadataText(prefix) !== null && metadataText(suffix) !== null;
  return (
    <LatexContextMenuForm label="Citation notes" width="content">
      {props.command !== "cite" && (
        <label>
          Before citation
          <Input
            size="compact"
            aria-label="Citation prefix"
            value={before}
            disabled={!editable}
            onChange={(event) => setBefore(event.target.value)}
          />
        </label>
      )}
      <label>
        Page / note
        <Input
          size="compact"
          aria-label="Citation note"
          value={after}
          disabled={!editable}
          onChange={(event) => setAfter(event.target.value)}
        />
      </label>
      <DockCommandItem
        disabled={!editable}
        onClick={() =>
          props.onChange(
            before ? [noteText(before), noteText(after)] : after ? [noteText(after)] : [],
          )
        }
      >
        Apply
      </DockCommandItem>
    </LatexContextMenuForm>
  );
}
