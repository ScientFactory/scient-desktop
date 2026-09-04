import { EllipsisIcon, ExpandIcon, FolderOpenIcon, PaletteIcon, RefreshCwIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";

import { PreviewImageSurface } from "~/components/preview/PreviewImageSurface";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { VisualCardToolbar } from "../presentation/VisualCardToolbar";

export const SCIENT_IMAGE_CAPTION_CLASS_NAME =
  "block w-0 min-w-full resize-none border-0 bg-transparent p-0 text-center text-xs leading-[1.45] text-muted-foreground [unicode-bidi:plaintext]";

export type ScientImageBackground = "automatic" | "light" | "dark";

export interface ScientImageAction {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
  /** Close image overlays before moving focus to another surface. */
  readonly closeViewer?: boolean;
  /** Run in the original click, for actions such as opening a native file picker. */
  readonly requiresUserActivation?: boolean;
  readonly run: () => void | Promise<void>;
}

export type ScientImageContextMenuHandler = (
  items: readonly { readonly id: string; readonly label: string; readonly disabled?: boolean }[],
  position: { readonly x: number; readonly y: number },
) => Promise<string | null>;

export interface ScientImageControlsHandle {
  readonly expand: () => void;
}

export interface ScientImageControlsProps {
  readonly ref?: Ref<ScientImageControlsHandle> | undefined;
  readonly imageURL: string | null;
  readonly imageCrossOrigin?: "anonymous" | null | undefined;
  readonly sourceIdentity?: string | undefined;
  readonly resolveViewerSource?: (() => Promise<string>) | undefined;
  readonly alt: string;
  readonly displayName: string;
  readonly loaded: boolean;
  readonly standalone: boolean;
  readonly selected: boolean;
  readonly authoring: boolean;
  readonly anchor: HTMLElement | null;
  readonly actions: readonly ScientImageAction[];
  readonly onRetry?: (() => void | Promise<void>) | undefined;
  readonly showContextMenu?: ScientImageContextMenuHandler | undefined;
  readonly onBackgroundChange?: ((background: ScientImageBackground) => void) | undefined;
  readonly primaryAction?: ScientImageAction | undefined;
  readonly revisionKey?: string | undefined;
  readonly onLoadError?: (() => void) | undefined;
}

const BACKGROUND_CLASS: Record<ScientImageBackground, string> = {
  automatic: "bg-background",
  light: "bg-white",
  dark: "bg-neutral-950",
};

function ownsNativeEditing(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("input, textarea, select"));
}

function ScientImageActionMenu({
  actions,
  busy,
  run,
  showExpand,
}: {
  readonly actions: readonly ScientImageAction[];
  readonly busy: boolean;
  readonly run: (action: ScientImageAction) => void;
  readonly showExpand: boolean;
}) {
  const pendingAction = useRef<ScientImageAction | null>(null);
  const [handingOffFocus, setHandingOffFocus] = useState(false);
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) {
          pendingAction.current = null;
          setHandingOffFocus(false);
        }
      }}
      onOpenChangeComplete={(open) => {
        if (open || !pendingAction.current) return;
        const action = pendingAction.current;
        pendingAction.current = null;
        run(action);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label="More image actions"
                  className="chat-markdown-chrome-action"
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            />
          }
        >
          <EllipsisIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>More image actions</TooltipPopup>
      </Tooltip>
      <MenuPopup
        align="end"
        className="min-w-52 max-w-[calc(100vw-2rem)]"
        finalFocus={handingOffFocus ? false : undefined}
      >
        {actions
          .filter((action) => action.id !== "expand-image" || showExpand)
          .map((action) => (
            <MenuItem
              key={action.id}
              disabled={action.disabled || busy}
              onClick={() => {
                if (action.closeViewer && !action.requiresUserActivation) {
                  // Menu items focus themselves after this callback. Transfer focus only
                  // after the menu closes, keeping restoration disabled until its next open.
                  pendingAction.current = action;
                  setHandingOffFocus(true);
                } else {
                  run(action);
                }
              }}
            >
              {action.id === "expand-image" ? (
                <ExpandIcon />
              ) : action.id === "image-background" ? (
                <PaletteIcon />
              ) : action.id === "retry-image" ? (
                <RefreshCwIcon />
              ) : null}
              {action.label}
            </MenuItem>
          ))}
      </MenuPopup>
    </Menu>
  );
}

/** Viewing chrome only. Editor selection, native fields, and asset authority stay with the caller. */
export function ScientImageControls({ ref, ...props }: ScientImageControlsProps) {
  const identity = props.sourceIdentity ?? props.revisionKey ?? props.imageURL ?? "";
  return <ScientImageControlsForSource key={identity} {...props} ref={ref} />;
}

function ScientImageControlsForSource({ ref, ...props }: ScientImageControlsProps) {
  const [background, setBackground] = useState<ScientImageBackground>("automatic");
  const [expanded, setExpanded] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const actionRunning = useRef(false);
  const mounted = useRef(true);
  const viewerRequest = useRef(0);
  const [viewer, setViewer] = useState<{
    readonly url: string | null;
    readonly error: string | null;
    readonly request: number;
  } | null>(null);
  const contextMenuOpen = useRef(false);
  const [pendingViewerAction, setPendingViewerAction] = useState<ScientImageAction | null>(null);
  const onBackgroundChange = props.onBackgroundChange;
  const resolveViewerSource = props.resolveViewerSource;
  const loadViewer = useCallback(() => {
    const request = ++viewerRequest.current;
    if (!resolveViewerSource) {
      setViewer({
        url: props.imageURL,
        error: props.imageURL ? null : "Image unavailable",
        request,
      });
      return;
    }
    setViewer({ url: null, error: null, request });
    void Promise.resolve()
      .then(resolveViewerSource)
      .then(
        (url) => {
          if (!mounted.current || request !== viewerRequest.current) return;
          setViewer({ url, error: null, request });
        },
        (cause: unknown) => {
          if (!mounted.current || request !== viewerRequest.current) return;
          setViewer({
            url: null,
            error: cause instanceof Error ? cause.message : "Image unavailable",
            request,
          });
        },
      );
  }, [props.imageURL, resolveViewerSource]);
  const expand = useCallback(() => {
    if (!props.imageURL || !props.loaded) return;
    setExpanded(true);
    loadViewer();
  }, [loadViewer, props.imageURL, props.loaded]);
  const closeViewer = useCallback(() => {
    viewerRequest.current += 1;
    setExpanded(false);
  }, []);
  useImperativeHandle(ref, () => ({ expand }), [expand]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onBackgroundChange?.(background);
  }, [background, onBackgroundChange]);
  useEffect(() => {
    props.anchor?.classList.add("group/scient-image");
    return () => props.anchor?.classList.remove("group/scient-image");
  }, [props.anchor]);

  const actions = useMemo<readonly ScientImageAction[]>(
    () => [
      {
        id: "expand-image",
        label: "Expand image",
        disabled: !props.loaded || !props.imageURL,
        run: expand,
      },
      ...props.actions,
      {
        id: "image-background",
        label: `Background: ${background}`,
        run: () =>
          setBackground((value) =>
            value === "automatic" ? "light" : value === "light" ? "dark" : "automatic",
          ),
      },
      ...(props.onRetry
        ? [
            {
              id: "retry-image",
              label: "Refresh image",
              run: expanded ? loadViewer : props.onRetry,
            },
          ]
        : []),
    ],
    [
      background,
      expand,
      expanded,
      loadViewer,
      props.actions,
      props.imageURL,
      props.loaded,
      props.onRetry,
    ],
  );

  const run = useCallback(
    (action: ScientImageAction | undefined) => {
      if (!mounted.current || !action || action.disabled || actionRunning.current) return;
      if (expanded && action.closeViewer) {
        closeViewer();
        if (!action.requiresUserActivation) {
          setPendingViewerAction(action);
          return;
        }
      }
      actionRunning.current = true;
      setActiveAction(action.id);
      setMessage(null);
      // Invoke synchronously: browser clipboard writes must begin in this gesture.
      let result: void | Promise<void>;
      try {
        result = action.run();
      } catch (cause) {
        result = Promise.reject(cause);
      }
      void Promise.resolve(result)
        .then(
          () => {
            if (mounted.current && /copy/.test(action.id)) setMessage("Copied");
          },
          (cause: unknown) => {
            if (mounted.current)
              setMessage(cause instanceof Error ? cause.message : "The image action failed.");
          },
        )
        .finally(() => {
          actionRunning.current = false;
          if (mounted.current) setActiveAction(null);
        });
    },
    [closeViewer, expanded],
  );

  useEffect(() => {
    if (message !== "Copied") return;
    const timer = setTimeout(() => setMessage(null), 1_500);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    const anchor = props.anchor;
    const show = props.showContextMenu;
    if (!anchor || !show) return;
    const open = (event: MouseEvent | KeyboardEvent) => {
      if (event.defaultPrevented || ownsNativeEditing(event.target) || contextMenuOpen.current)
        return;
      event.preventDefault();
      event.stopPropagation();
      const rect = anchor.getBoundingClientRect();
      const pointer = event instanceof MouseEvent && (event.clientX !== 0 || event.clientY !== 0);
      contextMenuOpen.current = true;
      void show(
        actions.map(({ id, label, disabled }) => ({
          id,
          label,
          ...(disabled || actionRunning.current ? { disabled: true } : {}),
        })),
        {
          x: pointer ? event.clientX : rect.left,
          y: pointer ? event.clientY : rect.bottom,
        },
      )
        .then(
          (id) => {
            if (mounted.current) run(actions.find((action) => action.id === id));
          },
          (cause: unknown) => {
            if (mounted.current)
              setMessage(cause instanceof Error ? cause.message : "Could not open image actions.");
          },
        )
        .finally(() => {
          contextMenuOpen.current = false;
        });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) open(event);
    };
    anchor.addEventListener("contextmenu", open);
    anchor.addEventListener("keydown", onKeyDown);
    return () => {
      anchor.removeEventListener("contextmenu", open);
      anchor.removeEventListener("keydown", onKeyDown);
    };
  }, [actions, props.anchor, props.showContextMenu, run]);

  const menu = (
    <ScientImageActionMenu
      actions={actions}
      busy={activeAction !== null}
      run={run}
      showExpand={!props.standalone && !expanded}
    />
  );

  return (
    <>
      <span
        data-scient-image-controls
        className={cn(
          "absolute top-1 right-1 z-10 max-w-full",
          props.authoring &&
            !props.selected &&
            "opacity-0 group-hover/scient-image:opacity-100 focus-within:opacity-100",
        )}
      >
        {props.standalone ? (
          <VisualCardToolbar label="Image actions">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Expand image"
                    disabled={!props.loaded || !props.imageURL}
                    className="chat-markdown-chrome-action"
                    onClick={expand}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  />
                }
              >
                <ExpandIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup>Expand image</TooltipPopup>
            </Tooltip>
            {props.primaryAction ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={props.primaryAction.label}
                      disabled={props.primaryAction.disabled}
                      onClick={() => run(props.primaryAction)}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    />
                  }
                >
                  <FolderOpenIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup>{props.primaryAction.label}</TooltipPopup>
              </Tooltip>
            ) : null}
            {menu}
          </VisualCardToolbar>
        ) : (
          menu
        )}
      </span>
      {message && !expanded ? (
        <span
          role="status"
          className="absolute top-full left-0 z-20 mt-1 max-w-full rounded bg-background px-2 py-1 text-xs text-muted-foreground"
        >
          {message}
        </span>
      ) : null}
      <Dialog
        open={expanded}
        onOpenChange={(open) => {
          if (open) expand();
          else closeViewer();
        }}
        onOpenChangeComplete={(open) => {
          if (open || !pendingViewerAction) return;
          const pending = pendingViewerAction;
          setPendingViewerAction(null);
          if (mounted.current) run(pending);
        }}
      >
        <DialogPopup
          finalFocus={pendingViewerAction ? false : undefined}
          bottomStickOnMobile={false}
          className="flex h-[min(92vh,64rem)] w-[min(94vw,96rem)] max-w-none flex-col overflow-hidden"
        >
          <DialogHeader className="flex-row items-center gap-3 border-b px-4 py-3 pe-12">
            <span className="min-w-0 flex-1">
              <DialogTitle className="truncate text-base" dir="auto">
                {props.displayName}
              </DialogTitle>
              <DialogDescription className="sr-only">
                Expanded image. Pinch or Control-scroll to zoom.
              </DialogDescription>
            </span>
            {menu}
          </DialogHeader>
          {message ? (
            <span role="status" className="border-b px-4 py-2 text-xs text-muted-foreground">
              {message}
            </span>
          ) : null}
          {viewer?.url ? (
            <PreviewImageSurface
              className={cn("min-h-0 flex-1", BACKGROUND_CLASS[background])}
              crossOrigin={props.imageCrossOrigin}
              source={{
                url: viewer.url,
                alt: props.alt,
                loadKey: String(viewer.request),
                ...(props.revisionKey ? { revisionKey: props.revisionKey } : {}),
              }}
              onLoadError={() => {
                setViewer((current) =>
                  current?.request === viewer.request
                    ? { ...current, url: null, error: "Unable to display this image" }
                    : current,
                );
                props.onLoadError?.();
              }}
            />
          ) : (
            <span
              role="status"
              className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
            >
              {viewer?.error ? viewer.error : "Loading image…"}
              {viewer?.error ? (
                <Button type="button" size="xs" variant="outline" onClick={loadViewer}>
                  Try again
                </Button>
              ) : null}
            </span>
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}
