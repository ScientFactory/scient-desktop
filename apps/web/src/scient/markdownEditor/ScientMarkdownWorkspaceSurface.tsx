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
  const imageInputRef = useRef<HTMLInputElement>(null);
  const bindingsRef = useRef(props);
  bindingsRef.current = props;

  const [chromeExpanded, setChromeExpanded] = useState(false);
  const controllerRef = useRef<ScientMarkdownEditorView | null>(null);
  const [saveQueue] = useState(
    () =>
      new MarkdownSaveQueue({
        debounceMs: SAVE_DEBOUNCE_MS,
        persist: (intent) => bindingsRef.current.persist(intent),
        onPendingChange: (pending) => bindingsRef.current.onPendingChange(pending),
        onConfirmed: (intent, result) => {
          controllerRef.current?.confirmSave(intent, result.revision);
          if (controllerRef.current) saveQueue.synchronize(controllerRef.current.session.session);
          const session = controllerRef.current?.session.session;
          if (
            !session ||
            (session.conflict === null && session.baselineRevision === result.revision)
          ) {
            // The watcher can observe this save before its reply while newer
            // typing is queued. Confirming that snapshot clears the apparent
            // conflict; release its pause too, but never a newer real conflict.
            if (session && saveQueue.failureBlocked) saveQueue.retry(result.revision);
            bindingsRef.current.onSaveConfirmed(intent.source, result.revision);
          }
        },
        onFailure: (_intent, error) => bindingsRef.current.onSaveFailure(error),
      }),
  );
  const [controller] = useState(
    () =>
      new ScientMarkdownEditorView({
        source: props.source,
        revision: props.revision,
        mode: "write",
        ariaLabel: props.ariaLabel,
        onOpenWikiLink: (target) => bindingsRef.current.onOpenWikiLink?.(target),
        onOpenLink: (target) => bindingsRef.current.onOpenLink?.(target),
        ...(props.resolveImageSource
          ? {
              resolveImageSource: (...args) =>
                bindingsRef.current.resolveImageSource?.(...args) ?? null,
            }
          : {}),
        ...(props.uploadImage
          ? {
              uploadImage: async (file: File) => {
                const upload = bindingsRef.current.uploadImage;
                if (!upload) throw new Error("Image upload is not available in this file surface.");
                return upload(file);
              },
              onImageUploadFailure: (error: unknown) =>
                bindingsRef.current.onImageUploadFailure?.(error),
              selectImage: () => imageInputRef.current?.click(),
            }
          : {}),
        wikiLinkSuggestions: () => bindingsRef.current.wikiLinkSuggestions?.() ?? [],
        wikiLinkTargetExists: (target) =>
          bindingsRef.current.wikiLinkTargetExists?.(target) ?? null,
        onUserSourceChange: () => {
          // First real edit reveals the formatting controls.
          setChromeExpanded(true);
          if (controllerRef.current) saveQueue.synchronize(controllerRef.current.session.session);
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
      saveQueue.synchronize(controller.session.session);
    } else if (result === "conflict") {
      saveQueue.pause();
      bindingsRef.current.onExternalConflict({ source: props.source, revision: props.revision });
    } else if (saveQueue.pending && !saveQueue.failureBlocked && currentIntent === null) {
      // The project query is authoritative. If it now contains this draft,
      // publication succeeded even when the renderer never received the
      // command settlement; retire that stale lane instead of trapping the
      // user behind an endless Saving state.
      saveQueue.acknowledgePersisted(props.source);
    } else if (currentIntent) {
      saveQueue.synchronize(controller.session.session);
    }
  }, [controller, props.revision, props.source, saveQueue]);

  useEffect(() => {
    if (!props.saveResolution) return;
    if (props.saveResolution.action === "discard") {
      controller.discardLocalChanges({
        source: props.source,
        revision: props.saveResolution.revision,
      });
    } else {
      controller.resolveExternalConflict("local");
    }
    saveQueue.synchronize(controller.session.session);
    saveQueue.retry(props.saveResolution.revision);
    bindingsRef.current.onSaveResolutionApplied?.();
  }, [controller, props.saveResolution, props.source, saveQueue]);

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
