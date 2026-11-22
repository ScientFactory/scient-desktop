import { T, useGT } from "gt-react";
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
  const gt = useGT();
  const [query, setQuery] = useState("");
  const setup = useContext(LatexAuthoringContext);
  const packages = latexPackageInventory(setup.source).loaded;
  const prefix = props.notes.length === 2 ? props.notes[0]! : "";
  const forms = [
    { value: "cite", label: gt("Citation", { $context: "citation form" }) },
    ...(packages.has("natbib")
      ? [
          { value: "citep", label: gt("Parenthetical") },
          { value: "citet", label: gt("In text") },
          { value: "citeauthor", label: gt("Author", { $context: "citation form" }) },
          { value: "citeyear", label: gt("Year", { $context: "citation form" }) },
        ]
      : packages.has("biblatex")
        ? [
            { value: "parencite", label: gt("Parenthetical") },
            { value: "textcite", label: gt("In text") },
            { value: "citeauthor", label: gt("Author", { $context: "citation form" }) },
            { value: "citeyear", label: gt("Year", { $context: "citation form" }) },
          ]
        : []),
  ];
  if (!forms.some((form) => form.value === props.command))
    forms.push({ value: props.command, label: props.command });
  const entries = new Map(props.entries.map((entry) => [entry.key, entry]));
  const search = query.trim().toLowerCase();
  return (
    <>
      <DockMenu icon={undefined} label={gt("References")} commandScope="latex">
        {props.keys.map((key, index) => (
          <LatexFooterSubmenu key={key} label={key}>
            <DockCommandItem disabled={!props.onOpen} onClick={() => props.onOpen?.(key)}>
              {entries.has(key) ? gt("Edit reference") : gt("Find reference")}
            </DockCommandItem>
            <DockCommandItem
              disabled={props.disabled || index === 0}
              onClick={() => {
                const keys = [...props.keys];
                [keys[index - 1], keys[index]] = [keys[index]!, keys[index - 1]!];
                props.onKeys(keys);
              }}
            >
              <T>Move earlier</T>
            </DockCommandItem>
            <DockCommandItem
              disabled={props.disabled || props.keys.length <= 1}
              onClick={() => props.onKeys(props.keys.filter((_, at) => at !== index))}
            >
              <T>Remove from citation</T>
            </DockCommandItem>
          </LatexFooterSubmenu>
        ))}
        <MenuSeparator />
        <LatexFooterSubmenu label={gt("Add reference")} disabled={props.disabled}>
          <LatexContextMenuForm label={gt("Find citation reference")}>
            <Input
              size="compact"
              type="search"
              aria-label={gt("Find citation reference")}
              placeholder={gt("Search references")}
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
          <T>Manage references</T>
        </DockCommandItem>
      </DockMenu>
      <DockMenu
        icon={undefined}
        label={gt("Form", { $context: "citation form" })}
        commandScope="latex"
        disabled={props.disabled}
      >
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
        label={gt("Note", { $context: "citation note" })}
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
  const gt = useGT();
  const prefix = props.notes.length === 2 ? props.notes[0]! : "";
  const suffix = props.notes.at(-1) ?? "";
  const [before, setBefore] = useState(metadataText(prefix) ?? prefix);
  const [after, setAfter] = useState(metadataText(suffix) ?? suffix);
  const editable = metadataText(prefix) !== null && metadataText(suffix) !== null;
  return (
    <LatexContextMenuForm label={gt("Citation notes")} width="content">
      {props.command !== "cite" && (
        <label>
          <T>Before citation</T>
          <Input
            size="compact"
            aria-label={gt("Citation prefix")}
            value={before}
            disabled={!editable}
            onChange={(event) => setBefore(event.target.value)}
          />
        </label>
      )}
      <label>
        <T>Page / note</T>
        <Input
          size="compact"
          aria-label={gt("Citation note")}
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
        <T>Apply</T>
      </DockCommandItem>
    </LatexContextMenuForm>
  );
}
