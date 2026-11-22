import { T, useGT } from "gt-react";
import { useContext, useId, useState, type ReactNode } from "react";
import type { NodeViewProps } from "@tiptap/react";
import { Input } from "~/components/ui/input";
import {
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";
import {
  DockCommandItem,
  DockCommandRadioItem,
  DockMenu,
  dockButtonClass,
} from "../writing/dockChrome";
import {
  LatexAuthoringContext,
  editLatexObjectSource,
  useLatexActionNotice,
} from "./latexObjectAuthoring";
import { setLatexEnvironmentOption } from "./latexObjectProperties";
import {
  latexLiteralBlock,
  latexListingDefaults,
  type LatexListingPresentation,
} from "./latexLiteral";
import { LatexContextMenuForm } from "./LatexContextMenuForm";
import { LatexReferenceLabelControl } from "./LatexReferenceLabelControl";
import { latexLabelInventory } from "./latexLabelAuthoring";

function CodeSubmenu(props: { label: string; disabled?: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <MenuSub>
      <MenuSubTrigger id={id} disabled={props.disabled}>
        {props.label}
      </MenuSubTrigger>
      <MenuSubPopup
        data-writing-menu-owner={id}
        data-dock-command-scope="latex"
        data-keybinding-capture=""
      >
        {props.children}
      </MenuSubPopup>
    </MenuSub>
  );
}

function CodeLanguage(props: { value: string; onChange: (value: string) => void }) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const choices = ["", "Python", "C", "C++", "Java", "Matlab", "R", "SQL", "[LaTeX]TeX"];
  if (!choices.includes(props.value)) choices.push(props.value);
  const languages = choices.map((value) => ({
    value,
    label: value === "[LaTeX]TeX" ? "LaTeX" : value || gt("Plain text"),
  }));
  return (
    <>
      <LatexContextMenuForm label={gt("Find code language")}>
        <Input
          size="compact"
          type="search"
          aria-label={gt("Find code language")}
          placeholder={gt("Search languages")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </LatexContextMenuForm>
      <MenuRadioGroup value={props.value}>
        {languages
          .filter(({ label, value }) =>
            `${label} ${value}`.toLowerCase().includes(query.trim().toLowerCase()),
          )
          .map(({ value, label }) => (
            <DockCommandRadioItem
              key={value}
              value={value}
              size="compact"
              onClick={() => props.onChange(value)}
            >
              <div className="truncate">{label}</div>
            </DockCommandRadioItem>
          ))}
      </MenuRadioGroup>
    </>
  );
}

function CodeFirstNumber(props: { value: number; onChange: (value: string) => void }) {
  const gt = useGT();
  const [draft, setDraft] = useState(String(props.value));
  const valid = /^\d+$/u.test(draft) && Number(draft) <= 100000;
  return (
    <LatexContextMenuForm label={gt("First line number")}>
      <Input
        size="compact"
        type="number"
        aria-label={gt("First line number")}
        min={0}
        max={100000}
        value={draft}
        aria-invalid={!valid}
        onChange={(event) => setDraft(event.target.value)}
      />
      <DockCommandItem disabled={!valid} onClick={() => props.onChange(draft)}>
        <T>Apply</T>
      </DockCommandItem>
    </LatexContextMenuForm>
  );
}

/** Code edits on paper; language, appearance and reference keys use the shared footer. */
export function LatexCodeControls({
  node,
  editor,
  getPos,
  updateAttributes,
  editable,
  draftKey,
  onCaption,
}: Pick<NodeViewProps, "node" | "editor" | "getPos" | "updateAttributes"> & {
  editable: boolean;
  draftKey?: string | undefined;
  onCaption: () => void;
}) {
  const gt = useGT();
  const context = useContext(LatexAuthoringContext);
  const report = useLatexActionNotice();
  const inventory = latexLabelInventory(context.source);
  const settings = node.attrs.sourceMeta?.listingPresentation as LatexListingPresentation;
  const option = (changes: Record<string, string | null>) => {
    if (!editable || !editor.isEditable || !context.prepare()) return;
    report(
      editLatexObjectSource(editor, getPos(), context.source, (source) => {
        let next = source;
        for (const [name, value] of Object.entries(changes)) {
          const changed = setLatexEnvironmentOption(next, "lstlisting", name, value);
          if ("error" in changed) return changed;
          next = changed.source;
        }
        return { source: next };
      }),
    );
  };
  const fontSize = (size: string) => {
    const at = getPos();
    const current = typeof at === "number" ? editor.state.doc.nodeAt(at) : null;
    const style =
      latexLiteralBlock(String(current?.attrs.raw ?? ""))?.options.get("basicstyle")?.value ??
      latexListingDefaults(context.source)?.get("basicstyle") ??
      "";
    const next = style.replace(
      /\\(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large)\b\s*/gu,
      "",
    );
    option({ basicstyle: `{${next}${size === "inherit" ? "" : `\\${size}`}}` });
  };
  const sizes = [
    { value: "inherit", label: gt("Document", { $context: "font size: document default" }) },
    { value: "tiny", label: gt("Tiny", { $context: "font size" }) },
    { value: "scriptsize", label: gt("Script", { $context: "font size" }) },
    { value: "footnotesize", label: gt("Footnote", { $context: "font size" }) },
    { value: "small", label: gt("Small", { $context: "font size" }) },
    { value: "normalsize", label: gt("Normal", { $context: "font size" }) },
    { value: "large", label: gt("Large", { $context: "font size" }) },
    { value: "Large", label: gt("Larger", { $context: "font size" }) },
  ];
  const tabs = [2, 4, 8];
  if (!tabs.includes(settings.tabSize)) tabs.push(settings.tabSize);
  const intervals = [1, 2, 5, 10];
  if (!intervals.includes(settings.step)) intervals.push(settings.step);
  const label = String(node.attrs.label ?? "");
  const captioned = node.attrs.caption !== null;
  const numbered = settings.numbers !== "none" && settings.step > 0;
  return (
    <>
      <DockMenu
        label={gt("Code language")}
        icon={gt("Language", { $context: "code language" })}
        commandScope="latex"
        disabled={!editable}
        chevron
      >
        <CodeLanguage
          value={settings.language}
          onChange={(language) => option({ language: `{${language}}` })}
        />
      </DockMenu>
      <DockMenu
        label={gt("Code appearance")}
        icon={gt("Appearance")}
        commandScope="latex"
        disabled={!editable}
      >
        <CodeSubmenu label={gt("Frame", { $context: "code frame" })}>
          <MenuRadioGroup value={settings.frame}>
            {[
              { value: "none", label: gt("None", { $context: "code frame" }) },
              { value: "single", label: gt("Full frame") },
              { value: "lines", label: gt("Top and bottom") },
              { value: "topline", label: gt("Top", { $context: "code frame" }) },
              { value: "bottomline", label: gt("Bottom", { $context: "code frame" }) },
            ].map((choice) => (
              <DockCommandRadioItem
                key={choice.value}
                value={choice.value}
                onClick={() => option({ frame: choice.value })}
              >
                {choice.label}
              </DockCommandRadioItem>
            ))}
          </MenuRadioGroup>
        </CodeSubmenu>
        <MenuCheckboxItem
          variant="switch"
          checked={settings.breakLines}
          closeOnClick={false}
          onCheckedChange={(checked) => option({ breaklines: String(checked) })}
        >
          <T>Wrap long lines</T>
        </MenuCheckboxItem>
        <CodeSubmenu label={gt("Font size")}>
          <MenuRadioGroup value={settings.basic.size}>
            {sizes.map((choice) => (
              <DockCommandRadioItem
                key={choice.value}
                value={choice.value}
                onClick={() => fontSize(choice.value)}
              >
                {choice.label}
              </DockCommandRadioItem>
            ))}
          </MenuRadioGroup>
        </CodeSubmenu>
        <CodeSubmenu label={gt("Tab width")}>
          <MenuRadioGroup value={String(settings.tabSize)}>
            {tabs.map((value) => (
              <DockCommandRadioItem
                key={value}
                value={String(value)}
                onClick={() => option({ tabsize: String(value) })}
              >
                {value} spaces
              </DockCommandRadioItem>
            ))}
          </MenuRadioGroup>
        </CodeSubmenu>
        <CodeSubmenu label={gt("Line numbers")}>
          <MenuCheckboxItem
            variant="switch"
            checked={numbered}
            closeOnClick={false}
            onCheckedChange={(checked) =>
              option({
                numbers: checked ? (settings.numbers === "right" ? "right" : "left") : "none",
                ...(checked && settings.step === 0 ? { stepnumber: "1" } : {}),
              })
            }
          >
            <T>Line numbers</T>
          </MenuCheckboxItem>
          <MenuSeparator />
          <CodeSubmenu
            label={gt("Position", { $context: "line number position" })}
            disabled={!numbered}
          >
            <MenuRadioGroup value={settings.numbers}>
              {[
                { value: "left", label: gt("Left", { $context: "line number position" }) },
                { value: "right", label: gt("Right", { $context: "line number position" }) },
              ].map((choice) => (
                <DockCommandRadioItem
                  key={choice.value}
                  value={choice.value}
                  onClick={() => option({ numbers: choice.value })}
                >
                  {choice.label}
                </DockCommandRadioItem>
              ))}
            </MenuRadioGroup>
          </CodeSubmenu>
          <CodeSubmenu label={gt("First number")} disabled={!numbered}>
            <CodeFirstNumber
              key={settings.firstNumber}
              value={settings.firstNumber}
              onChange={(value) => option({ firstnumber: value })}
            />
          </CodeSubmenu>
          <CodeSubmenu label={gt("Number every")} disabled={!numbered}>
            <MenuRadioGroup value={String(settings.step)}>
              {intervals.map((value) => (
                <DockCommandRadioItem
                  key={value}
                  value={String(value)}
                  onClick={() => option({ stepnumber: String(value) })}
                >
                  {value === 1
                    ? gt("Every line")
                    : gt("{count, plural, one {Every {count} line} other {Every {count} lines}}", {
                        count: value,
                      })}
                </DockCommandRadioItem>
              ))}
            </MenuRadioGroup>
          </CodeSubmenu>
        </CodeSubmenu>
        <CodeSubmenu label={gt("Caption position")}>
          <MenuRadioGroup value={settings.captionPosition}>
            {[
              { value: "t", label: gt("Above", { $context: "caption position" }) },
              { value: "b", label: gt("Below", { $context: "caption position" }) },
            ].map((choice) => (
              <DockCommandRadioItem
                key={choice.value}
                value={choice.value}
                onClick={() => option({ captionpos: choice.value })}
              >
                {choice.label}
              </DockCommandRadioItem>
            ))}
          </MenuRadioGroup>
        </CodeSubmenu>
      </DockMenu>
      <button
        className={dockButtonClass()}
        type="button"
        disabled={!editable}
        aria-label={captioned ? gt("Edit code caption") : gt("Add code caption")}
        onClick={onCaption}
      >
        <T>Caption</T>
      </button>
      {captioned && (
        <LatexReferenceLabelControl
          label={gt("Code reference label")}
          value={label}
          allowEmpty
          draftKey={draftKey}
          commitOn="blur"
          disabled={!editable}
          isAvailable={(value) =>
            !value || value === label || !inventory.targets.some((target) => target.key === value)
          }
          onCommit={(value, fieldId) => {
            if (value === label || !editable) return;
            if (value && label && context.renameLabel) context.renameLabel(label, value, fieldId);
            else if (context.prepare()) updateAttributes({ label: value || null });
          }}
        />
      )}
    </>
  );
}
