import type { MarkdownDocumentMode } from "@scientfactory/scient-markdown";
import { useEffect, useRef } from "react";

import type { ScientMarkdownEditorView } from "./prosemirror/view";
import "./scient-markdown-editor.css";

export interface ScientMarkdownDocumentProps {
  readonly mode: MarkdownDocumentMode;
  /** The workspace owns the single session, save lane, and controller lifetime. */
  readonly controller: ScientMarkdownEditorView;
}

/**
 * React lifetime adapter for one persistent ProseMirror view. Changing mode
 * only changes EditorView props; it never swaps the rendered document DOM.
 */
export function ScientMarkdownDocument(props: ScientMarkdownDocumentProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    props.controller.mount(host);
  }, [props.controller]);

  useEffect(() => props.controller.setMode(props.mode), [props.controller, props.mode]);

  return (
    <div
      className="scient-markdown-document-shell"
      onClick={(event) => {
        if (event.target === event.currentTarget || event.target === hostRef.current) {
          props.controller.focus();
        }
      }}
    >
      <div ref={hostRef} className="scient-markdown-document-host" />
    </div>
  );
}
