import type { MarkdownDocumentMode, MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { useEffect, useRef, useState } from "react";

import type { ScientMarkdownImageSourceResolver } from "./nodes";
import { ScientMarkdownEditorView, type ScientMarkdownUploadedImage } from "./prosemirror/view";
import "./scient-markdown-editor.css";

export interface ScientMarkdownDocumentProps {
  readonly source: string;
  readonly revision: string;
  readonly mode: MarkdownDocumentMode;
  readonly ariaLabel: string;
  readonly onUserSourceChange: (source: string, intent: MarkdownSaveIntent) => void;
  readonly onExternalConflict?: (input: {
    readonly source: string;
    readonly revision: string;
  }) => void;
  readonly onOpenWikiLink?: (target: string) => void;
  readonly onOpenLink?: (target: string) => void;
  readonly resolveImageSource?: ScientMarkdownImageSourceResolver;
  readonly uploadImage?: (file: File) => Promise<ScientMarkdownUploadedImage>;
  readonly onImageUploadFailure?: (error: unknown) => void;
  readonly selectImage?: () => void;
  readonly wikiLinkSuggestions?: () => ReadonlyArray<string>;
  readonly wikiLinkTargetExists?: (target: string) => boolean | null;
  /** Supplied by the owning workspace surface so rich and source share one session. */
  readonly controller?: ScientMarkdownEditorView;
}

/**
 * React lifetime adapter for one persistent ProseMirror view. Changing mode
 * only changes EditorView props; it never swaps the rendered document DOM.
 */
export function ScientMarkdownDocument(props: ScientMarkdownDocumentProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onUserSourceChangeRef = useRef(props.onUserSourceChange);
  const onExternalConflictRef = useRef(props.onExternalConflict);
  onUserSourceChangeRef.current = props.onUserSourceChange;
  onExternalConflictRef.current = props.onExternalConflict;

  const [ownedController] = useState(
    () =>
      new ScientMarkdownEditorView({
        source: props.source,
        revision: props.revision,
        mode: props.mode,
        ariaLabel: props.ariaLabel,
        ...(props.onOpenWikiLink ? { onOpenWikiLink: props.onOpenWikiLink } : {}),
        ...(props.onOpenLink ? { onOpenLink: props.onOpenLink } : {}),
        ...(props.resolveImageSource ? { resolveImageSource: props.resolveImageSource } : {}),
        ...(props.uploadImage ? { uploadImage: props.uploadImage } : {}),
        ...(props.onImageUploadFailure ? { onImageUploadFailure: props.onImageUploadFailure } : {}),
        ...(props.selectImage ? { selectImage: props.selectImage } : {}),
        ...(props.wikiLinkSuggestions ? { wikiLinkSuggestions: props.wikiLinkSuggestions } : {}),
        ...(props.wikiLinkTargetExists ? { wikiLinkTargetExists: props.wikiLinkTargetExists } : {}),
        onUserSourceChange: (source, intent) => onUserSourceChangeRef.current(source, intent),
      }),
  );
  const controller = props.controller ?? ownedController;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    controller.mount(host);
    return () => {
      if (!props.controller) controller.destroy();
    };
  }, [controller, props.controller]);

  useEffect(() => controller.setMode(props.mode), [controller, props.mode]);

  useEffect(() => {
    if (props.controller) return;
    const result = controller.receiveExternalSource({
      source: props.source,
      revision: props.revision,
    });
    if (result === "conflict") {
      onExternalConflictRef.current?.({ source: props.source, revision: props.revision });
    }
  }, [controller, props.controller, props.revision, props.source]);

  return (
    <div
      className="scient-markdown-document-shell"
      data-markdown-mode={props.mode}
      onClick={(event) => {
        if (event.target === event.currentTarget || event.target === hostRef.current) {
          controller.focus();
        }
      }}
    >
      <div ref={hostRef} className="scient-markdown-document-host" />
    </div>
  );
}
