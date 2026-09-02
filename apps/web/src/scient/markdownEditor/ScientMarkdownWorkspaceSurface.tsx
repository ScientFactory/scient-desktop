import { MarkdownSaveQueue, type MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { useEffect, useRef, useState } from "react";

import { readLocalApi } from "~/localApi";

import { ScientMarkdownDocument } from "./ScientMarkdownDocument";
import { showScientMarkdownFootnoteContextMenu } from "./footnoteContextMenu";
import {
  showScientMarkdownLinkContextMenu,
  type ScientMarkdownLinkCopyRequest,
  type ScientMarkdownLinkKind,
} from "./linkContextMenu";
import type { ScientMarkdownLinkOpenHandler } from "./linkOpen";
import type { ScientMarkdownImageSourceResolver } from "./nodes";
import type { ScientMarkdownBlockAction } from "./prosemirror/blocks";
import { ScientMarkdownEditorView, type ScientMarkdownUploadedImage } from "./prosemirror/view";
import { showScientRichFenceContextMenu } from "./richFenceContextMenu";
import {
  SCIENT_MARKDOWN_COMMAND_SHORTCUTS,
  matchesScientMarkdownShortcut,
  type ScientMarkdownShortcutId,
} from "./shortcuts";
import { showScientMarkdownTableContextMenu } from "./tableContextMenu";
import { ScientMarkdownControls } from "./ui/ScientMarkdownControls";
import { useFinalUnmount } from "./useFinalUnmount";
import type { ScientMarkdownWikiLinkCandidate } from "./wikiLinkPicker";

const SAVE_DEBOUNCE_MS = 500;

const CHROME_BLOCK_SHORTCUTS = [
  ["moveBlockUp", "move-up"],
  ["moveBlockDown", "move-down"],
  ["duplicateBlock", "duplicate"],
] as const satisfies ReadonlyArray<readonly [ScientMarkdownShortcutId, ScientMarkdownBlockAction]>;

function targetOwnsTextEditing(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !==
      null
  );
}

export interface ScientMarkdownWorkspaceSurfaceProps {
  readonly source: string;
  readonly revision: string;
  readonly authoritativeSnapshot: {
    readonly source: string;
    readonly revision: string;
  } | null;
  readonly ariaLabel: string;
  readonly resolvedTheme?: "light" | "dark";
  /** Resource availability key; changes invalidate missing asset/link presentation. */
  readonly workspaceResourceIndexKey?: string;
  readonly persist: (intent: MarkdownSaveIntent) => Promise<{ readonly revision: string }>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onDraftSourceChange: (source: string) => void;
  readonly onSaveConfirmed: (source: string, revision: string) => void;
  readonly onSaveFailure: (error: unknown) => void;
  readonly onExternalConflict: (input: {
    readonly source: string;
    readonly revision: string;
  }) => void;
  readonly onLocalHeadingOpened?: () => void;
  readonly onOpenWikiLink?: ScientMarkdownLinkOpenHandler;
  readonly onOpenLink?: ScientMarkdownLinkOpenHandler;
  readonly resolveLinkFullPath?: (kind: ScientMarkdownLinkKind, target: string) => string | null;
  readonly onCopyLink?: (request: ScientMarkdownLinkCopyRequest, anchor: HTMLElement) => void;
  readonly resolveImageSource?: ScientMarkdownImageSourceResolver;
  readonly uploadImage?: (file: File) => Promise<ScientMarkdownUploadedImage>;
  readonly onImageUploadFailure?: (error: unknown) => void;
  readonly wikiLinkTargetExists?: (target: string) => boolean | null;
  readonly wikiLinkCandidates?: ReadonlyArray<ScientMarkdownWikiLinkCandidate>;
  readonly recentWikiLinkPaths?: ReadonlyArray<string>;
  readonly onWikiLinkSelected?: (path: string) => void;
  readonly saveResolution?: {
    readonly action: "discard" | "retry";
    readonly contents: string;
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
  const previousThemeRef = useRef(props.resolvedTheme);
  const previousWorkspaceResourceIndexKeyRef = useRef(props.workspaceResourceIndexKey);

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
            if (session && saveQueue.failureBlocked) saveQueue.resume();
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
        revision: props.authoritativeSnapshot?.revision ?? props.revision,
        authoritativeSource: props.authoritativeSnapshot?.source ?? props.source,
        mode: "write",
        ariaLabel: props.ariaLabel,
        resolveTheme: () =>
          bindingsRef.current.resolvedTheme ??
          (document.documentElement.classList.contains("dark") ? "dark" : "light"),
        onLocalHeadingOpened: () => bindingsRef.current.onLocalHeadingOpened?.(),
        onOpenWikiLink: (target, anchor) => bindingsRef.current.onOpenWikiLink?.(target, anchor),
        onOpenLink: (target, anchor) => bindingsRef.current.onOpenLink?.(target, anchor),
        ...(props.resolveLinkFullPath
          ? {
              resolveLinkFullPath: (kind: ScientMarkdownLinkKind, target: string) =>
                bindingsRef.current.resolveLinkFullPath?.(kind, target) ?? null,
            }
          : {}),
        ...(props.onCopyLink
          ? {
              onCopyLink: (request: ScientMarkdownLinkCopyRequest, anchor: HTMLElement) =>
                bindingsRef.current.onCopyLink?.(request, anchor),
            }
          : {}),
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
        wikiLinkTargetExists: (target) =>
          bindingsRef.current.wikiLinkTargetExists?.(target) ?? null,
        showLinkContextMenu: async (request) => {
          const api = readLocalApi();
          if (!api) return null;
          return showScientMarkdownLinkContextMenu(request, (items, position) =>
            api.contextMenu.show(items, position),
          );
        },
        showFootnoteContextMenu: async (request) => {
          const api = readLocalApi();
          if (!api) return null;
          return showScientMarkdownFootnoteContextMenu(request, (items, position) =>
            api.contextMenu.show(items, position),
          );
        },
        showRichFenceContextMenu: async (position) => {
          const api = readLocalApi();
          if (!api) return null;
          return showScientRichFenceContextMenu(position, (items, menuPosition) =>
            api.contextMenu.show(items, menuPosition),
          );
        },
        showTableContextMenu: async (position) => {
          const api = readLocalApi();
          if (!api) return null;
          return showScientMarkdownTableContextMenu(position, (items, menuPosition) =>
            api.contextMenu.show(items, menuPosition),
          );
        },
        onUserSourceChange: (source) => {
          // First real edit reveals the formatting controls.
          setChromeExpanded(true);
          bindingsRef.current.onDraftSourceChange(source);
          if (controllerRef.current) saveQueue.synchronize(controllerRef.current.session.session);
        },
      }),
  );
  controllerRef.current = controller;

  useEffect(() => {
    if (previousThemeRef.current !== props.resolvedTheme) {
      previousThemeRef.current = props.resolvedTheme;
      controller.refreshExternalPresentation("appearance");
    }
  }, [controller, props.resolvedTheme]);

  useEffect(() => {
    if (previousWorkspaceResourceIndexKeyRef.current !== props.workspaceResourceIndexKey) {
      previousWorkspaceResourceIndexKeyRef.current = props.workspaceResourceIndexKey;
      controller.refreshExternalPresentation("workspace");
    }
  }, [controller, props.workspaceResourceIndexKey]);

  useEffect(() => {
    const authoritative = props.authoritativeSnapshot;
    if (authoritative === null) return;
    const publishedIntent = saveQueue.acknowledgePublished(
      authoritative.source,
      controller.session.session.baselineRevision,
    );
    if (publishedIntent !== null) {
      controller.confirmSave(publishedIntent, authoritative.revision);
      saveQueue.synchronize(controller.session.session);
      const session = controller.session.session;
      if (session.conflict === null && session.baselineRevision === authoritative.revision) {
        bindingsRef.current.onSaveConfirmed(authoritative.source, authoritative.revision);
      }
      return;
    }
    const result = controller.receiveExternalSource({
      source: authoritative.source,
      revision: authoritative.revision,
    });
    const currentIntent = controller.createSaveIntent();
    if (result === "adopted") {
      // The queued draft is unchanged; rebase its revision so the debounced
      // write does not dead-end on a stale compare-and-swap.
      saveQueue.synchronize(controller.session.session);
    } else if (result === "conflict") {
      saveQueue.pause();
      bindingsRef.current.onExternalConflict(authoritative);
    } else if (currentIntent) {
      saveQueue.synchronize(controller.session.session);
    }
  }, [
    controller,
    props.authoritativeSnapshot?.revision,
    props.authoritativeSnapshot?.source,
    saveQueue,
  ]);

  useEffect(() => {
    if (!props.saveResolution) return;
    const authoritative = {
      source: props.saveResolution.contents,
      revision: props.saveResolution.revision,
    };
    if (props.saveResolution.action === "discard") {
      controller.discardLocalChanges(authoritative);
    } else {
      controller.rebaseLocalChanges(authoritative);
    }
    saveQueue.synchronize(controller.session.session);
    const alreadyPersisted =
      props.saveResolution.action === "retry" &&
      controller.session.session.draftSource === authoritative.source;
    saveQueue.resume();
    if (alreadyPersisted) {
      bindingsRef.current.onSaveConfirmed(authoritative.source, authoritative.revision);
    }
    bindingsRef.current.onSaveResolutionApplied?.();
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
    <div
      className="scient-markdown-workspace"
      data-keybinding-capture=""
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (matchesScientMarkdownShortcut(event, "find")) {
          // Find spans the rendered document even when a nested math/code
          // source field or a portaled control currently owns text focus.
          event.preventDefault();
          event.stopPropagation();
          const returnFocus =
            event.target instanceof HTMLElement &&
            event.target !== controller.view?.dom &&
            targetOwnsTextEditing(event.target)
              ? event.target
              : null;
          controller.requestFind(returnFocus);
          return;
        }
        if (matchesScientMarkdownShortcut(event, "link")) {
          event.preventDefault();
          event.stopPropagation();
          // Nested source fields own text editing and must not mutate the
          // outer document, but the app palette must not claim their Mod-K.
          if (!targetOwnsTextEditing(event.target)) controller.requestLinkEdit();
          return;
        }
        // ProseMirror and nested source/input editors own their direct text
        // commands. This fallback is only for non-text Markdown chrome whose
        // focus would otherwise strand document shortcuts on a button/menu.
        if (targetOwnsTextEditing(event.target)) return;
        if (matchesScientMarkdownShortcut(event, "selectAll")) {
          event.preventDefault();
          event.stopPropagation();
          controller.selectAll();
          return;
        }
        for (const [shortcutId, command] of SCIENT_MARKDOWN_COMMAND_SHORTCUTS) {
          if (!matchesScientMarkdownShortcut(event, shortcutId)) continue;
          event.preventDefault();
          event.stopPropagation();
          controller.execute(command);
          return;
        }
        for (const [shortcutId, action] of CHROME_BLOCK_SHORTCUTS) {
          if (!matchesScientMarkdownShortcut(event, shortcutId)) continue;
          event.preventDefault();
          event.stopPropagation();
          controller.executeBlock(action);
          return;
        }
      }}
    >
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
