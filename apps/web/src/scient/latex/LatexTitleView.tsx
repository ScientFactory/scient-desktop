import { LatexSelect } from "./LatexSelect";
import { isLatexContextEvent } from "./latexContextEvents";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  useEffect,
  useCallback,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Selection } from "@tiptap/pm/state";
import { preserveLatexCaret } from "./latexObjectCaret";
import { LatexTextField } from "./LatexTextField";

type Props = Pick<NodeViewProps, "node" | "editor" | "updateAttributes" | "selected" | "getPos"> & {
  editable: boolean;
  draftKey: string | null;
};

function today() {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

export function LatexTitleView({
  node,
  editor,
  updateAttributes,
  selected,
  editable,
  getPos,
  draftKey,
}: Props) {
  const [hiddenAuthor, setHiddenAuthor] = useLocalStorage(
    `scient.latex.hidden-author:${draftKey ?? "transient"}`,
    "",
    Schema.String,
  );
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const focusDateAfterSelect = useRef(false);
  const id = useId();
  const [active, setActive] = useState(false);
  const [addingAuthor, setAddingAuthor] = useState(false);
  const [addingDate, setAddingDate] = useState(false);
  const authorEnabled = node.attrs.authorEnabled === true;
  const showAuthor = authorEnabled || addingAuthor;
  const dateMode =
    node.attrs.dateMode === "hidden"
      ? "hidden"
      : node.attrs.dateMode === "explicit"
        ? "explicit"
        : "automatic";
  const sourceMeta = node.attrs.sourceMeta as {
    titleEditable?: boolean;
    authorEditable?: boolean;
    dateEditable?: boolean;
  } | null;
  const focusField = useCallback(
    (field: "title" | "author" | "date") =>
      requestAnimationFrame(() =>
        root.current
          ?.querySelector<HTMLTextAreaElement>(`[aria-label="Document ${field}"]`)
          ?.focus({ preventScroll: true }),
      ),
    [],
  );
  const exit = (direction: -1 | 1) => {
    const position = getPos();
    if (typeof position !== "number") return;
    const boundary = direction < 0 ? position : position + node.nodeSize;
    editor.view.dispatch(
      editor.state.tr.setSelection(Selection.near(editor.state.doc.resolve(boundary), direction)),
    );
    editor.commands.focus(undefined, { scrollIntoView: false });
    setActive(false);
  };
  const activate = () => {
    if (!editable) return;
    document.dispatchEvent(new CustomEvent("scient-latex-context-activate", { detail: id }));
    setActive(true);
  };
  const activation = useRef(activate);
  activation.current = activate;
  useEffect(() => {
    if (selected) activation.current();
  }, [selected]);
  useEffect(() => {
    const deactivate = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setActive(false);
    };
    document.addEventListener("scient-latex-context-activate", deactivate);
    return () => document.removeEventListener("scient-latex-context-activate", deactivate);
  }, [id]);
  useEffect(() => {
    if (!active) return;
    const outside = (event: PointerEvent) => {
      if (isLatexContextEvent(event, toolbar.current)) return;
      const path = event.composedPath();
      if (!path.includes(root.current!) && !path.includes(toolbar.current!)) setActive(false);
    };
    const focusOutside = (event: globalThis.FocusEvent) => {
      if (isLatexContextEvent(event, toolbar.current)) return;
      const path = event.composedPath();
      if (!path.includes(root.current!) && !path.includes(toolbar.current!)) setActive(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", focusOutside);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", focusOutside);
    };
  }, [active]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const edit = (event: Event) => {
      const field = (event as CustomEvent<"title" | "author" | "date">).detail;
      if (field === "author") setAddingAuthor(true);
      if (field === "date") setAddingDate(true);
      activation.current();
      focusField(field);
    };
    element.addEventListener("scient-latex-edit-title", edit);
    return () => element.removeEventListener("scient-latex-edit-title", edit);
  }, [focusField]);
  const host = editor.view.dom
    .closest(".scient-latex-visual-workspace")
    ?.querySelector(".scient-latex-context-tools-slot");
  return (
    <NodeViewWrapper
      ref={root}
      className="scient-latex-title-preview"
      contentEditable={false}
      data-active={active || undefined}
      onFocusCapture={(event: FocusEvent<HTMLDivElement>) => {
        activate();
        if (event.target instanceof HTMLTextAreaElement) {
          preserveLatexCaret(editor.view);
        }
      }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (!(event.target instanceof HTMLTextAreaElement) || event.nativeEvent.isComposing) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) editor.commands.redo();
          else editor.commands.undo();
        } else if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
          event.preventDefault();
          event.stopPropagation();
          event.target.blur();
          exit(1);
        } else if (event.key === "Tab") {
          const fields = [
            ...(root.current?.querySelectorAll<HTMLTextAreaElement>("textarea:not(:disabled)") ??
              []),
          ];
          const index = fields.indexOf(event.target) + (event.shiftKey ? -1 : 1);
          event.preventDefault();
          if (fields[index]) fields[index].focus({ preventScroll: true });
          else exit(event.shiftKey ? -1 : 1);
        }
      }}
      onPointerDown={activate}
    >
      <LatexTextField
        aria-label="Document title"
        rows={1}
        disabled={!editable || sourceMeta?.titleEditable === false}
        draftKey={draftKey ? `${draftKey}:title` : undefined}
        value={String(node.attrs.title ?? "")}
        onValueChange={(title) => updateAttributes({ title })}
      />
      {showAuthor ? (
        <LatexTextField
          aria-label="Document author"
          rows={1}
          disabled={!editable || sourceMeta?.authorEditable === false}
          draftKey={draftKey ? `${draftKey}:author` : undefined}
          value={String(node.attrs.author ?? "")}
          onValueChange={(author) => {
            setAddingAuthor(!author.trim());
            updateAttributes({ author, authorEnabled: Boolean(author.trim()) });
          }}
        />
      ) : null}
      {dateMode !== "hidden" || addingDate ? (
        <LatexTextField
          aria-label="Document date"
          rows={1}
          disabled={!editable || sourceMeta?.dateEditable === false}
          draftKey={draftKey ? `${draftKey}:date` : undefined}
          value={String(node.attrs.date ?? "")}
          onValueChange={(date) => {
            if (date.trim()) updateAttributes({ date, dateEnabled: true, dateMode: "explicit" });
          }}
          onBlur={(event) => {
            if (!event.currentTarget.value.trim()) {
              updateAttributes({ date: "", dateEnabled: false, dateMode: "hidden" });
              setAddingDate(false);
            }
          }}
        />
      ) : null}
      {active && editable && host
        ? createPortal(
            <div
              ref={toolbar}
              className="scient-latex-context-toolbar scient-latex-title-bar"
              role="toolbar"
              aria-label="Title block options"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onFocusCapture={(event) => event.stopPropagation()}
            >
              <span className="scient-latex-context-label">Title block</span>
              <label className="scient-latex-title-author-toggle">
                <input
                  type="checkbox"
                  checked={showAuthor}
                  disabled={sourceMeta?.authorEditable === false}
                  onChange={(event) => {
                    if (!event.currentTarget.checked) {
                      setHiddenAuthor(String(node.attrs.author ?? ""));
                      setAddingAuthor(false);
                      updateAttributes({ authorEnabled: false });
                    } else {
                      const author = String(node.attrs.author || hiddenAuthor);
                      if (author.trim()) updateAttributes({ author, authorEnabled: true });
                      else setAddingAuthor(true);
                      focusField("author");
                    }
                  }}
                />
                Author
              </label>
              <LatexSelect
                aria-label="Title date"
                disabled={sourceMeta?.dateEditable === false}
                value={dateMode}
                onValueChange={(value) => {
                  const mode = value;
                  setAddingDate(false);
                  updateAttributes(
                    mode === "hidden"
                      ? { date: "", dateEnabled: false, dateMode: "hidden" }
                      : {
                          date: mode === "automatic" ? today() : String(node.attrs.date || today()),
                          dateEnabled: true,
                          dateMode: mode === "automatic" ? "today" : "explicit",
                        },
                  );
                  focusDateAfterSelect.current = mode === "explicit";
                }}
                onClosed={() => {
                  if (!focusDateAfterSelect.current) return;
                  focusDateAfterSelect.current = false;
                  focusField("date");
                }}
                size="compact"
                options={[
                  { value: "automatic", label: "Date: Automatic" },
                  { value: "explicit", label: "Date: Custom" },
                  { value: "hidden", label: "Date: Hidden" },
                ]}
              />
            </div>,
            host,
          )
        : null}
    </NodeViewWrapper>
  );
}
