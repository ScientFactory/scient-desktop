import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

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
import {
  ScientMarkdownEditorView,
  type ScientMarkdownUploadedImage,
  type ScientMarkdownEditorViewOptions,
} from "./prosemirror/view";
import { showScientRichFenceContextMenu } from "./richFenceContextMenu";
import {
  SCIENT_MARKDOWN_COMMAND_SHORTCUTS,
  matchesScientMarkdownShortcut,
  type ScientMarkdownShortcutId,
} from "./shortcuts";
import { showScientMarkdownTableContextMenu } from "./tableContextMenu";
import { ScientMarkdownControls } from "./ui/ScientMarkdownControls";
import { useFinalUnmount } from "./useFinalUnmount";
import type { MarkdownPersistenceLease } from "./persistence/markdownPersistenceRegistry";
import type { ScientMarkdownWikiLinkCandidate } from "./wikiLinkPicker";

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
  readonly persistence: MarkdownPersistenceLease;
  readonly ariaLabel: string;
  readonly resolvedTheme?: "light" | "dark";
  /** Resource availability key; changes invalidate missing asset/link presentation. */
  readonly workspaceResourceIndexKey?: string;
  readonly onLocalHeadingOpened?: () => void;
  readonly onOpenWikiLink?: ScientMarkdownLinkOpenHandler;
  readonly onOpenLink?: ScientMarkdownLinkOpenHandler;
  readonly resolveLinkFullPath?: (kind: ScientMarkdownLinkKind, target: string) => string | null;
  readonly onCopyLink?: (request: ScientMarkdownLinkCopyRequest, anchor: HTMLElement) => void;
  readonly resolveImageSource?: ScientMarkdownImageSourceResolver;
  readonly imageOptions?: ScientMarkdownEditorViewOptions["imageOptions"];
  readonly onOpenSourceLine?: (line: number) => void;
  readonly uploadImage?: (file: File) => Promise<ScientMarkdownUploadedImage>;
  readonly onImageUploadFailure?: (error: unknown) => void;
  readonly wikiLinkTargetExists?: (target: string) => boolean | null;
  readonly wikiLinkCandidates?: ReadonlyArray<ScientMarkdownWikiLinkCandidate>;
  readonly recentWikiLinkPaths?: ReadonlyArray<string>;
  readonly onWikiLinkSelected?: (path: string) => void;
}

/**
 * Projects the shared file session into one always-editable rich document.
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
  const activeViewRef = useRef(false);
  const composingRef = useRef(false);
  useLayoutEffect(() => {
    activeViewRef.current = true;
    return () => {
      activeViewRef.current = false;
    };
  }, []);
  const persistenceSnapshot = useSyncExternalStore(
    props.persistence.subscribe,
    props.persistence.getSnapshot,
  );
  const appliedVersionRef = useRef(persistenceSnapshot.editVersion);
  const [controller] = useState(
    () =>
      new ScientMarkdownEditorView({
        source: persistenceSnapshot.draftSource,
        revision: persistenceSnapshot.baselineRevision,
        authoritativeSource: persistenceSnapshot.baselineSource,
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
        ...(props.onOpenSourceLine
          ? { onOpenSourceLine: (line: number) => bindingsRef.current.onOpenSourceLine?.(line) }
          : {}),
        imageOptions: {
          resolveImageActions: (source) =>
            bindingsRef.current.imageOptions?.resolveImageActions?.(source) ?? [],
          showImageContextMenu: async (items, position) => {
            const show = bindingsRef.current.imageOptions?.showImageContextMenu;
            if (show) return show(items, position);
            const api = readLocalApi();
            return api ? api.contextMenu.show([...items], position) : null;
          },
          onImageError: (error) => bindingsRef.current.imageOptions?.onImageError?.(error),
        },
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
          if (!activeViewRef.current) return;
          // First real edit reveals the formatting controls.
          setChromeExpanded(true);
          const lease = bindingsRef.current.persistence;
          const accepted = lease.change(source, appliedVersionRef.current);
          const snapshot = lease.getSnapshot();
          appliedVersionRef.current = snapshot.editVersion;
          controllerRef.current?.synchronizePersistence(snapshot);
          if (!accepted)
            queueMicrotask(() => {
              // The originating ProseMirror dispatch finishes after this callback.
              // Re-apply current truth after that dispatch if this view was stale.
              const controller = controllerRef.current;
              if (controller?.view) controller.view.updateState(controller.session.state);
            });
        },
      }),
  );
  controllerRef.current = controller;

  useLayoutEffect(
    () =>
      props.persistence.registerExternalProjection((update) => {
        if (composingRef.current) return "defer";
        const apply = controller.prepareExternalUpdate(update);
        if (apply === "defer") return "defer";
        if (!apply) return null;
        return () => {
          apply();
          appliedVersionRef.current = update.editVersion;
        };
      }),
    [controller, props.persistence],
  );

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
    // Read the current store, not an older React render, after a synchronous edit.
    const snapshot = props.persistence.getSnapshot();
    appliedVersionRef.current = snapshot.editVersion;
    controller.setMode(snapshot.editingBlocked ? "read" : "write");
    controller.synchronizePersistence(snapshot);
  }, [controller, props.persistence, persistenceSnapshot]);

  useFinalUnmount(() => {
    // Persistence outlives this view. Unmount must never flush or unblock it.
    controller.destroy();
    controllerRef.current = null;
  });

  return (
    <div
      className="scient-markdown-workspace"
      data-keybinding-capture=""
      onCompositionStartCapture={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
        queueMicrotask(() => props.persistence.resumeExternalUpdates());
      }}
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
