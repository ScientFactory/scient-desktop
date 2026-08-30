import { MarkdownSaveQueue, type MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { useEffect, useRef, useState } from "react";

import { ScientMarkdownDocument } from "./ScientMarkdownDocument";
import type { ScientMarkdownImageSourceResolver } from "./nodes";
import { ScientMarkdownEditorView, type ScientMarkdownUploadedImage } from "./prosemirror/view";
import { ScientMarkdownControls } from "./ui/ScientMarkdownControls";
import { useFinalUnmount } from "./useFinalUnmount";
import type { ScientMarkdownWikiLinkCandidate } from "./wikiLinkPicker";

const SAVE_DEBOUNCE_MS = 500;

export interface ScientMarkdownWorkspaceSurfaceProps {
  readonly source: string;
  readonly revision: string;
  readonly ariaLabel: string;
  readonly persist: (intent: MarkdownSaveIntent) => Promise<{ readonly revision: string }>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onSaveConfirmed: (source: string, revision: string) => void;
  readonly onSaveFailure: (error: unknown) => void;
  readonly onExternalConflict: (input: {
    readonly source: string;
    readonly revision: string;
  }) => void;
  readonly onOpenWikiLink?: (target: string) => void;
  readonly onOpenLink?: (target: string) => void;
  readonly resolveImageSource?: ScientMarkdownImageSourceResolver;
  readonly uploadImage?: (file: File) => Promise<ScientMarkdownUploadedImage>;
  readonly onImageUploadFailure?: (error: unknown) => void;
  readonly wikiLinkSuggestions?: () => ReadonlyArray<string>;
  readonly wikiLinkTargetExists?: (target: string) => boolean | null;
  readonly wikiLinkCandidates?: ReadonlyArray<ScientMarkdownWikiLinkCandidate>;
  readonly recentWikiLinkPaths?: ReadonlyArray<string>;
  readonly onWikiLinkSelected?: (path: string) => void;
  readonly saveResolution?: {
    readonly action: "discard" | "retry";
    readonly revision: string;
  } | null;
  readonly onSaveResolutionApplied?: () => void;
}

/**
 * Coordinates one always-editable rich document and one serial save lane.
 * The rendered view is the editor: clicking into it edits it. The editing
 * controls stay collapsed until the reader opens them or starts typing.
 */
export function ScientMarkdownWorkspaceSurface(props: ScientMarkdownWorkspaceSurfaceProps) {
  const persistRef = useRef(props.persist);
  const onPendingChangeRef = useRef(props.onPendingChange);
  const onSaveConfirmedRef = useRef(props.onSaveConfirmed);
  const onSaveFailureRef = useRef(props.onSaveFailure);
  const onExternalConflictRef = useRef(props.onExternalConflict);
  const onSaveResolutionAppliedRef = useRef(props.onSaveResolutionApplied);
  const uploadImageRef = useRef(props.uploadImage);
  const onImageUploadFailureRef = useRef(props.onImageUploadFailure);
  const imageInputRef = useRef<HTMLInputElement>(null);
  persistRef.current = props.persist;
  onPendingChangeRef.current = props.onPendingChange;
  onSaveConfirmedRef.current = props.onSaveConfirmed;
  onSaveFailureRef.current = props.onSaveFailure;
  onExternalConflictRef.current = props.onExternalConflict;
  onSaveResolutionAppliedRef.current = props.onSaveResolutionApplied;
  uploadImageRef.current = props.uploadImage;
  onImageUploadFailureRef.current = props.onImageUploadFailure;

  const [chromeExpanded, setChromeExpanded] = useState(false);
  const controllerRef = useRef<ScientMarkdownEditorView | null>(null);
  const [saveQueue] = useState(
    () =>
      new MarkdownSaveQueue({
        debounceMs: SAVE_DEBOUNCE_MS,
        persist: (intent) => persistRef.current(intent),
        onPendingChange: (pending) => onPendingChangeRef.current(pending),
        onConfirmed: (intent, result) => {
          controllerRef.current?.confirmSave(intent, result.revision);
          onSaveConfirmedRef.current(intent.source, result.revision);
        },
        onFailure: (_intent, error) => onSaveFailureRef.current(error),
      }),
  );
  const [controller] = useState(
    () =>
      new ScientMarkdownEditorView({
        source: props.source,
        revision: props.revision,
        mode: "write",
        ariaLabel: props.ariaLabel,
        ...(props.onOpenWikiLink ? { onOpenWikiLink: props.onOpenWikiLink } : {}),
        ...(props.onOpenLink ? { onOpenLink: props.onOpenLink } : {}),
        ...(props.resolveImageSource ? { resolveImageSource: props.resolveImageSource } : {}),
        ...(props.uploadImage
          ? {
              uploadImage: (file: File) => uploadImageRef.current!(file),
              onImageUploadFailure: (error: unknown) => onImageUploadFailureRef.current?.(error),
              selectImage: () => imageInputRef.current?.click(),
            }
          : {}),
        ...(props.wikiLinkSuggestions ? { wikiLinkSuggestions: props.wikiLinkSuggestions } : {}),
        ...(props.wikiLinkTargetExists ? { wikiLinkTargetExists: props.wikiLinkTargetExists } : {}),
        onUserSourceChange: (_source, intent) => {
          // First real edit reveals the formatting controls.
          setChromeExpanded(true);
          saveQueue.enqueue(intent);
        },
      }),
  );
  controllerRef.current = controller;

  useEffect(() => {
    const result = controller.receiveExternalSource({
      source: props.source,
      revision: props.revision,
    });
    const currentIntent = controller.createSaveIntent();
    if (result === "adopted") {
      // The queued draft is unchanged; rebase its revision so the debounced
      // write does not dead-end on a stale compare-and-swap.
      if (currentIntent) saveQueue.enqueue(currentIntent);
    } else if (result === "conflict") {
      saveQueue.pause();
      onExternalConflictRef.current({ source: props.source, revision: props.revision });
    } else if (saveQueue.pending && !saveQueue.failureBlocked && currentIntent === null) {
      // The project query is authoritative. If it now contains this draft,
      // publication succeeded even when the renderer never received the
      // command settlement; retire that stale lane instead of trapping the
      // user behind an endless Saving state.
      saveQueue.acknowledgePersisted(props.source);
    }
  }, [controller, props.revision, props.source, saveQueue]);

  useEffect(() => {
    if (!props.saveResolution) return;
    if (props.saveResolution.action === "discard") {
      saveQueue.discard();
      controller.resolveExternalConflict("disk");
    } else {
      controller.resolveExternalConflict("local");
      saveQueue.retry(props.saveResolution.revision);
    }
    onSaveResolutionAppliedRef.current?.();
  }, [controller, props.saveResolution, saveQueue]);

  useFinalUnmount(() => {
    // Normal surface departures are held by the shared pending-save guard.
    // Dispose remains a best-effort final flush for direct tree/app teardown,
    // then release the externally owned ProseMirror view deterministically.
    void saveQueue.dispose({ flush: true });
    controller.destroy();
    controllerRef.current = null;
  });

  return (
    <div className="scient-markdown-workspace">
      {props.uploadImage ? (
        <input
          ref={imageInputRef}
          className="hidden"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
          aria-label="Choose image for Markdown document"
          multiple
          onChange={(event) => {
            [...(event.currentTarget.files ?? [])].forEach((file) =>
              controller.uploadImageFile(file),
            );
            event.currentTarget.value = "";
          }}
        />
      ) : null}
      <div className="scient-markdown-rich-pane">
        <ScientMarkdownControls
          controller={controller}
          expanded={chromeExpanded}
          onExpandedChange={setChromeExpanded}
          {...(props.wikiLinkCandidates ? { wikiLinkCandidates: props.wikiLinkCandidates } : {})}
          {...(props.recentWikiLinkPaths ? { recentWikiLinkPaths: props.recentWikiLinkPaths } : {})}
          {...(props.onWikiLinkSelected ? { onWikiLinkSelected: props.onWikiLinkSelected } : {})}
        />
        <ScientMarkdownDocument mode="write" controller={controller} />
      </div>
    </div>
  );
}
