import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import type { EnvironmentId } from "@t3tools/contracts";
import { Input } from "~/components/ui/input";
import {
  MenuItemLabel,
  MenuRadioGroup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";
import {
  refreshProjectFiles,
  useProjectEntriesQuery,
} from "~/components/files/projectFilesQueryState";
import {
  DockCommandItem,
  DockCommandRadioItem,
  DockMenu,
  dockButtonClass,
} from "../writing/dockChrome";
import { LatexReferenceLabelPopover } from "./LatexReferenceLabelPopover";
import { LatexLengthField } from "./LatexLengthField";
import { LatexContextMenuForm } from "./LatexContextMenuForm";
import { latexEquationReferencesKey } from "./latexEquationReferences";
import { useLatexObjectContext } from "./useLatexObjectContext";
import { useLatexActionNotice } from "./latexObjectAuthoring";
import { relativeLatexImagePath } from "./figureSource";
import { uploadLatexImage } from "./imageUpload";

function FigureSubmenu(props: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <MenuSub>
      <MenuSubTrigger id={id}>{props.label}</MenuSubTrigger>
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

function FigureWidth(props: { value: string; onChange: (width: string) => void }) {
  const [width, setWidth] = useState(props.value);
  const valid =
    width === "" ||
    /^(?:\d+(?:\.\d*)?|\.\d+)(?:mm|cm|in|pt|em|\\(?:linewidth|textwidth|columnwidth))$/u.test(
      width,
    );
  return (
    <LatexContextMenuForm label="Figure width">
      <LatexLengthField
        label="Width"
        value={width}
        onChange={setWidth}
        relative
        relativeTo={["textwidth", "linewidth", "columnwidth"]}
        automatic
        size="sm"
      />
      <DockCommandItem disabled={!valid} onClick={() => props.onChange(width)}>
        Apply
      </DockCommandItem>
    </LatexContextMenuForm>
  );
}

export function ReplacementImages(props: {
  environmentId: EnvironmentId;
  cwd: string;
  onChoose: (path: string) => void;
  onImport?: () => void;
}) {
  const files = useProjectEntriesQuery(props.environmentId, props.cwd);
  const [query, setQuery] = useState("");
  const images = (files.data?.entries ?? []).filter(
    (entry) =>
      entry.kind === "file" &&
      /\.(?:png|jpe?g|pdf)$/iu.test(entry.path) &&
      !/[{}\\%#\r\n]/u.test(entry.path) &&
      entry.path.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <LatexContextMenuForm label="Choose figure image">
        <Input
          size="compact"
          aria-label="Find figure image"
          placeholder="Find image"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </LatexContextMenuForm>
      <div className="scient-latex-figure-image-choices">
        {images.map((image) => (
          <DockCommandItem
            key={image.path}
            title={image.path}
            onClick={() => props.onChoose(image.path)}
          >
            <MenuItemLabel>{image.path}</MenuItemLabel>
          </DockCommandItem>
        ))}
      </div>
      <MenuSeparator />
      {props.onImport && <DockCommandItem onClick={props.onImport}>Import image…</DockCommandItem>}
    </>
  );
}

export function LatexFigureToolbar(props: {
  editor: Editor;
  root: RefObject<HTMLElement | null>;
  selected: boolean;
  editable: boolean;
  hasCaption: boolean;
  label: string;
  draftKey: string | undefined;
  width: string;
  alignment: string;
  placement: string;
  captionPosition: string;
  workspace: {
    environmentId: EnvironmentId | null;
    cwd: string | null;
    relativePath: string | null;
  };
  onReplace: (path: string) => void;
  onAppearance: (attrs: {
    figureWidth?: string;
    figureAlignment?: string;
    figurePlacement?: string;
    figureCaptionPosition?: string;
  }) => void;
  onCaption: () => void;
  onLabel: (label: string) => void;
  onDelete: () => void;
}) {
  const { active, bar } = useLatexObjectContext(props.editor, props.root, props.selected);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const report = useLatexActionNotice();
  const replace = (path: string) => {
    if (props.workspace.relativePath)
      props.onReplace(relativeLatexImagePath(props.workspace.relativePath, path));
  };
  const importImage = async (image: File) => {
    const { environmentId, cwd, relativePath } = props.workspace;
    if (!environmentId || !cwd || !relativePath || uploading) return;
    setUploading(true);
    report(null);
    try {
      const result = await uploadLatexImage(environmentId, {
        cwd,
        documentRelativePath: relativePath,
        file: image,
      });
      if (!live.current) return;
      refreshProjectFiles(environmentId, cwd);
      replace(result.relativePath);
    } catch {
      if (live.current) report("Could not import the image. Use a PNG or JPEG under 20 MB.");
    } finally {
      if (live.current) setUploading(false);
    }
  };
  const host = props.editor.view.dom
    .closest(".scient-latex-visual-workspace")
    ?.querySelector(".scient-latex-context-tools-slot");
  if (!active || !host || !props.editor.isEditable) return null;
  const disabled = !props.editable || uploading;
  const placements = [
    { value: "", label: "Automatic" },
    { value: "htbp", label: "Prefer here" },
    { value: "t", label: "Top" },
    { value: "b", label: "Bottom" },
    { value: "p", label: "Separate page" },
  ];
  if (!placements.some((placement) => placement.value === props.placement))
    placements.push({ value: props.placement, label: "Custom" });
  return createPortal(
    <div
      ref={bar}
      role="toolbar"
      aria-label="Figure tools"
      data-context-presentation="inline"
      className="scient-latex-context-toolbar"
      onPointerDown={(event) => event.stopPropagation()}
      onFocusCapture={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        ref={file}
        hidden
        type="file"
        accept="image/png,image/jpeg"
        onChange={(event) => {
          const image = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (image) void importImage(image);
        }}
      />
      <DockMenu
        label="Replace figure image"
        icon={uploading ? "Importing…" : "Replace"}
        commandScope="latex"
        popupClassName="w-60"
        disabled={
          disabled ||
          !props.workspace.environmentId ||
          !props.workspace.cwd ||
          !props.workspace.relativePath
        }
      >
        {props.workspace.environmentId && props.workspace.cwd && (
          <ReplacementImages
            environmentId={props.workspace.environmentId}
            cwd={props.workspace.cwd}
            onChoose={replace}
            onImport={() => file.current?.click()}
          />
        )}
      </DockMenu>
      <DockMenu
        label="Figure appearance"
        icon="Appearance"
        commandScope="latex"
        disabled={disabled}
      >
        <FigureSubmenu label="Width">
          <FigureWidth
            key={props.width}
            value={props.width}
            onChange={(figureWidth) => props.onAppearance({ figureWidth })}
          />
        </FigureSubmenu>
        <FigureSubmenu label="Alignment">
          <MenuRadioGroup value={props.alignment}>
            {[
              { value: "left", label: "Left" },
              { value: "center", label: "Center" },
              { value: "right", label: "Right" },
            ].map((option) => (
              <DockCommandRadioItem
                key={option.value}
                value={option.value}
                onClick={() => props.onAppearance({ figureAlignment: option.value })}
              >
                {option.label}
              </DockCommandRadioItem>
            ))}
          </MenuRadioGroup>
        </FigureSubmenu>
        {props.hasCaption && (
          <FigureSubmenu label="Caption position">
            <MenuRadioGroup value={props.captionPosition}>
              {[
                { value: "above", label: "Above" },
                { value: "below", label: "Below" },
              ].map((option) => (
                <DockCommandRadioItem
                  key={option.value}
                  value={option.value}
                  onClick={() => props.onAppearance({ figureCaptionPosition: option.value })}
                >
                  {option.label}
                </DockCommandRadioItem>
              ))}
            </MenuRadioGroup>
          </FigureSubmenu>
        )}
        <FigureSubmenu label="Placement">
          <MenuRadioGroup value={props.placement}>
            {placements.map((option) => (
              <DockCommandRadioItem
                key={option.value}
                value={option.value}
                onClick={() => props.onAppearance({ figurePlacement: option.value })}
              >
                {option.label}
              </DockCommandRadioItem>
            ))}
          </MenuRadioGroup>
        </FigureSubmenu>
        <MenuSeparator />
        <DockCommandItem variant="destructive" onClick={props.onDelete}>
          Delete figure
        </DockCommandItem>
      </DockMenu>
      <button
        className={dockButtonClass()}
        type="button"
        disabled={disabled}
        aria-label={props.hasCaption ? "Edit figure caption" : "Add figure caption"}
        onClick={props.onCaption}
      >
        Caption
      </button>
      {props.hasCaption && (
        <LatexReferenceLabelPopover
          label="Figure reference label"
          allowEmpty
          value={props.label}
          draftKey={props.draftKey}
          commitOn="blur"
          disabled={disabled}
          isAvailable={(label) =>
            !label ||
            label === props.label ||
            !latexEquationReferencesKey.getState(props.editor.state)?.labels.has(label)
          }
          onCommit={props.onLabel}
        />
      )}
    </div>,
    host,
  );
}
