import { useContext, useId, useMemo, useState, type ReactNode } from "react";
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
import { LatexContextMenuForm } from "./LatexContextMenuForm";
import { LatexLengthField } from "./LatexLengthField";
import { LatexAuthoringContext } from "./latexObjectAuthoring";
import { latexColorCss, latexDocumentColors } from "./latexColorBoxes";
import { latexLayoutLength } from "./latexPageLayouts";

function BoxSubmenu(props: { label: string; contentSized?: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <MenuSub>
      <MenuSubTrigger id={id}>{props.label}</MenuSubTrigger>
      <MenuSubPopup
        className={props.contentSized ? "w-max min-w-0 max-w-(--available-width)" : undefined}
        data-writing-menu-owner={id}
        data-dock-command-scope="latex"
        data-keybinding-capture=""
      >
        {props.children}
      </MenuSubPopup>
    </MenuSub>
  );
}

/** Literal document colors and xcolor mixtures retain their original source names. */
function BoxColor(props: { label: string; value: string; onChange: (value: string) => void }) {
  const { source } = useContext(LatexAuthoringContext);
  const colors = useMemo(() => latexDocumentColors(source), [source]);
  const [value, setValue] = useState(props.value);
  const id = useId();
  const valid = latexColorCss(value, colors) !== null;
  return (
    <>
      <LatexContextMenuForm label={props.label}>
        <Input
          size="compact"
          nativeInput
          list={id}
          aria-label={props.label}
          value={value}
          aria-invalid={!valid}
          onChange={(event) => setValue(event.target.value)}
        />
        <datalist id={id}>
          {Object.keys(colors).map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <DockCommandItem disabled={!valid} onClick={() => props.onChange(value)}>
          Apply
        </DockCommandItem>
      </LatexContextMenuForm>
      <MenuSeparator />
      <MenuRadioGroup value={props.value}>
        {Object.entries(colors).map(([name, color]) => (
          <DockCommandRadioItem key={name} value={name} onClick={() => props.onChange(name)}>
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="size-3 shrink-0 rounded-sm border border-border"
                style={{ background: color }}
              />
              {name}
            </span>
          </DockCommandRadioItem>
        ))}
      </MenuRadioGroup>
    </>
  );
}

function BoxDimension(props: { label: string; value: string; onChange: (value: string) => void }) {
  const [value, setValue] = useState(props.value);
  const parsed = latexLayoutLength(value);
  const valid = Boolean(parsed && !parsed.endsWith("%"));
  return (
    <LatexContextMenuForm label={props.label} width="content">
      <LatexLengthField
        label={props.label}
        size="sm"
        width="content"
        value={value}
        onChange={setValue}
      />
      <DockCommandItem disabled={!valid} onClick={() => props.onChange(value)}>
        Apply
      </DockCommandItem>
    </LatexContextMenuForm>
  );
}

function BoxPadding(props: { value: string; onChange: (value: string) => void }) {
  const choices = [
    { value: "0mm", label: "None" },
    { value: "1mm", label: "Compact" },
    { value: "3mm", label: "Normal" },
    { value: "5mm", label: "Spacious" },
  ];
  const selected = choices.find(
    (choice) => latexLayoutLength(choice.value) === latexLayoutLength(props.value),
  )?.value;
  return (
    <>
      <MenuRadioGroup value={selected ?? "custom"}>
        {choices.map((choice) => (
          <DockCommandRadioItem
            key={choice.value}
            value={choice.value}
            onClick={() => props.onChange(choice.value)}
          >
            {choice.label}
          </DockCommandRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      <BoxSubmenu label="Custom" contentSized>
        <BoxDimension label="Padding" value={props.value} onChange={props.onChange} />
      </BoxSubmenu>
    </>
  );
}

/** Box content and its optional title edit on paper; only presentation belongs here. */
export function LatexBoxControls(props: {
  editable: boolean;
  hasTitle: boolean;
  background: string;
  border: string;
  borderWidth: string;
  radius: string;
  padding: string;
  breakable: boolean;
  onOption: (name: string, value: string | null) => void;
  onTitle: () => void;
}) {
  const rounded = Number.parseFloat(props.radius) > 0;
  return (
    <>
      <DockMenu
        label="Box appearance"
        icon="Appearance"
        commandScope="latex"
        disabled={!props.editable}
      >
        <BoxSubmenu label="Background">
          <BoxColor
            label="Box background"
            value={props.background}
            onChange={(value) => props.onOption("colback", value)}
          />
        </BoxSubmenu>
        <BoxSubmenu label="Border">
          <DockCommandItem onClick={() => props.onOption("boxrule", "0pt")}>
            No border
          </DockCommandItem>
          <MenuSeparator />
          <BoxSubmenu label="Color">
            <BoxColor
              label="Box border color"
              value={props.border}
              onChange={(value) => props.onOption("colframe", value)}
            />
          </BoxSubmenu>
          <BoxSubmenu label="Thickness" contentSized>
            <BoxDimension
              label="Thickness"
              value={props.borderWidth}
              onChange={(value) => props.onOption("boxrule", value)}
            />
          </BoxSubmenu>
        </BoxSubmenu>
        <BoxSubmenu label="Corners">
          <MenuRadioGroup value={rounded ? "rounded" : "square"}>
            <DockCommandRadioItem value="square" onClick={() => props.onOption("arc", "0pt")}>
              Square
            </DockCommandRadioItem>
            <DockCommandRadioItem
              value="rounded"
              onClick={() => props.onOption("arc", rounded ? props.radius : "1mm")}
            >
              Rounded
            </DockCommandRadioItem>
          </MenuRadioGroup>
          <MenuSeparator />
          <BoxSubmenu label="Custom" contentSized>
            <BoxDimension
              label="Radius"
              value={props.radius}
              onChange={(value) => props.onOption("arc", value)}
            />
          </BoxSubmenu>
        </BoxSubmenu>
        <BoxSubmenu label="Padding">
          <BoxPadding value={props.padding} onChange={(value) => props.onOption("boxsep", value)} />
        </BoxSubmenu>
        <MenuSeparator />
        <MenuCheckboxItem
          variant="switch"
          checked={props.breakable}
          closeOnClick={false}
          onCheckedChange={(checked) => props.onOption("breakable", checked ? "" : null)}
        >
          Allow page breaks
        </MenuCheckboxItem>
      </DockMenu>
      <button
        type="button"
        className={dockButtonClass()}
        disabled={!props.editable}
        aria-label={props.hasTitle ? "Edit box title" : "Add box title"}
        onClick={props.onTitle}
      >
        Title
      </button>
    </>
  );
}
