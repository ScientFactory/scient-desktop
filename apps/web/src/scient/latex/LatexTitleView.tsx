import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";

type Props = Pick<NodeViewProps, "node" | "editor" | "updateAttributes" | "selected"> & {
  editable: boolean;
};

function today() {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

export function LatexTitleView({ node, editor, updateAttributes, selected, editable }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const authorField = useRef<HTMLTextAreaElement>(null);
  const dateField = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const [active, setActive] = useState(false);
  const [addingAuthor, setAddingAuthor] = useState(false);
  const [dateDraft, setDateDraft] = useState<string | null>(null);
  const authorEnabled = node.attrs.authorEnabled === true;
  const showAuthor = authorEnabled || addingAuthor;
  const dateMode =
    node.attrs.dateMode === "hidden"
      ? "hidden"
      : node.attrs.dateMode === "explicit"
        ? "explicit"
        : "automatic";
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
      const path = event.composedPath();
      if (!path.includes(root.current!) && !path.includes(toolbar.current!)) setActive(false);
    };
    const focusOutside = (event: FocusEvent) => {
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
  const host = editor.view.dom
    .closest(".scient-latex-visual-workspace")
    ?.querySelector(".scient-latex-context-tools-slot");
  return (
    <NodeViewWrapper
      ref={root}
      className="scient-latex-title-preview"
      contentEditable={false}
      data-active={active || undefined}
      onFocusCapture={activate}
      onPointerDown={activate}
    >
      <textarea
        aria-label="Document title"
        rows={1}
        disabled={!editable}
        placeholder={active ? "Document title" : ""}
        value={String(node.attrs.title ?? "")}
        onChange={(event) => updateAttributes({ title: event.currentTarget.value })}
      />
      {showAuthor ? (
        <textarea
          ref={authorField}
          aria-label="Document author"
          rows={1}
          disabled={!editable}
          placeholder={active ? "Author, course, or institution" : ""}
          value={String(node.attrs.author ?? "")}
          onChange={(event) => {
            const author = event.currentTarget.value;
            setAddingAuthor(!author.trim());
            updateAttributes({ author, authorEnabled: Boolean(author.trim()) });
          }}
        />
      ) : null}
      {dateMode !== "hidden" ? (
        <textarea
          ref={dateField}
          aria-label="Document date"
          rows={1}
          disabled={!editable}
          placeholder={active ? "Date" : ""}
          value={dateDraft ?? String(node.attrs.date ?? "")}
          onChange={(event) => {
            const date = event.currentTarget.value;
            setDateDraft(date);
            if (date.trim()) updateAttributes({ date, dateEnabled: true, dateMode: "explicit" });
          }}
          onBlur={() => {
            if (dateDraft !== null && !dateDraft.trim())
              updateAttributes({ date: "", dateEnabled: false, dateMode: "hidden" });
            setDateDraft(null);
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
              <span className="scient-latex-context-label">Title</span>
              <label className="scient-latex-title-author-toggle">
                <input
                  type="checkbox"
                  checked={showAuthor}
                  onChange={(event) => {
                    if (!event.currentTarget.checked) {
                      setAddingAuthor(false);
                      updateAttributes({ authorEnabled: false });
                    } else {
                      if (String(node.attrs.author ?? "").trim())
                        updateAttributes({ authorEnabled: true });
                      else setAddingAuthor(true);
                      requestAnimationFrame(() => authorField.current?.focus());
                    }
                  }}
                />
                Author
              </label>
              <select
                aria-label="Title date"
                value={dateMode}
                onChange={(event) => {
                  const mode = event.currentTarget.value;
                  setDateDraft(null);
                  updateAttributes(
                    mode === "hidden"
                      ? { date: "", dateEnabled: false, dateMode: "hidden" }
                      : {
                          date: mode === "automatic" ? today() : String(node.attrs.date || today()),
                          dateEnabled: true,
                          dateMode: mode === "automatic" ? "today" : "explicit",
                        },
                  );
                  if (mode === "explicit")
                    requestAnimationFrame(() => {
                      dateField.current?.focus();
                      dateField.current?.select();
                    });
                }}
              >
                <option value="automatic">Date: Automatic</option>
                <option value="explicit">Date: Custom</option>
                <option value="hidden">Date: Hidden</option>
              </select>
            </div>,
            host,
          )
        : null}
    </NodeViewWrapper>
  );
}
