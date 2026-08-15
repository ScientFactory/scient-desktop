import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type HTMLAttributes,
} from "react";

import { cn } from "~/lib/utils";

import {
  mountVegaLiteView,
  type MountedVegaLiteView,
  type VegaLiteTheme,
  type VegaLiteViewState,
} from "./vegaLiteRuntime";
import { isMeaningfulVegaLiteWidthChange } from "./vegaLiteResize";
import { buildVegaLiteRenderPlan, type ParsedVegaLiteSource } from "./vegaLiteSpec";

export interface VegaLiteViewController {
  readonly getDimensions: () => { readonly height: number; readonly width: number };
  readonly getState: () => VegaLiteViewState | null;
  readonly reset: () => Promise<void>;
  readonly setState: (state: VegaLiteViewState) => Promise<void>;
  readonly toCanvas: (scale: number) => Promise<HTMLCanvasElement>;
  readonly toSvg: () => Promise<string>;
}

interface VegaLiteViewMountIdentity {
  readonly initialState: VegaLiteViewState | null | undefined;
  readonly parsed: ParsedVegaLiteSource;
  readonly theme: VegaLiteTheme;
  readonly title: string;
}

export function shouldPreserveVegaLiteStateForThemeRemount(
  current: VegaLiteViewMountIdentity,
  next: VegaLiteViewMountIdentity,
): boolean {
  return (
    current.parsed === next.parsed &&
    current.initialState === next.initialState &&
    current.title === next.title &&
    current.theme !== next.theme
  );
}

interface VegaLiteViewProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "onError" | "title"
> {
  readonly initialState?: VegaLiteViewState | null | undefined;
  readonly onError: (error: Error) => void;
  readonly onReady: (mounted: MountedVegaLiteView) => void;
  readonly parsed: ParsedVegaLiteSource;
  readonly theme: VegaLiteTheme;
  readonly title: string;
}

export const VegaLiteView = forwardRef<VegaLiteViewController, VegaLiteViewProps>(
  function VegaLiteView(
    { className, initialState, onError, onReady, parsed, theme, title, ...props },
    forwardedRef,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mountedRef = useRef<MountedVegaLiteView | null>(null);
    const onErrorRef = useRef(onError);
    const onReadyRef = useRef(onReady);
    const observedWidthRef = useRef<number | null>(null);
    const preservedThemeStateRef = useRef<VegaLiteViewState | null>(null);
    const resizeQueueRef = useRef<Promise<void>>(Promise.resolve());
    const resizeFrameRef = useRef<number | null>(null);
    const renderPlan = useMemo(() => buildVegaLiteRenderPlan(parsed.spec), [parsed]);
    const latestMountIdentityRef = useRef<VegaLiteViewMountIdentity>({
      initialState,
      parsed,
      theme,
      title,
    });
    latestMountIdentityRef.current = { initialState, parsed, theme, title };

    useEffect(() => {
      onErrorRef.current = onError;
      onReadyRef.current = onReady;
    }, [onError, onReady]);

    useImperativeHandle(
      forwardedRef,
      () => ({
        getDimensions() {
          const mounted = mountedRef.current;
          if (mounted == null) throw new Error("The chart is not ready.");
          const padding = mounted.result.view.padding();
          const horizontalPadding =
            typeof padding === "number" ? padding * 2 : (padding.left ?? 0) + (padding.right ?? 0);
          const verticalPadding =
            typeof padding === "number" ? padding * 2 : (padding.top ?? 0) + (padding.bottom ?? 0);
          return {
            height: mounted.result.view.height() + verticalPadding,
            width: mounted.result.view.width() + horizontalPadding,
          };
        },
        getState: () => mountedRef.current?.result.view.getState() ?? null,
        async reset() {
          const mounted = mountedRef.current;
          if (mounted == null) throw new Error("The chart is not ready.");
          mounted.result.view.setState(mounted.initialState);
          await mounted.result.view.runAsync();
        },
        async setState(state) {
          const mounted = mountedRef.current;
          if (mounted == null) throw new Error("The chart is not ready.");
          mounted.result.view.setState(state);
          await mounted.result.view.runAsync();
        },
        async toCanvas(scale) {
          const mounted = mountedRef.current;
          if (mounted == null) throw new Error("The chart is not ready.");
          return mounted.result.view.toCanvas(scale);
        },
        async toSvg() {
          const mounted = mountedRef.current;
          if (mounted == null) throw new Error("The chart is not ready.");
          return mounted.result.view.toSVG(1);
        },
      }),
      [],
    );

    useEffect(() => {
      const container = containerRef.current;
      if (container == null) return;

      let disposed = false;
      const mountIdentity = { initialState, parsed, theme, title };
      const stateToRestore = preservedThemeStateRef.current ?? initialState;
      // Embed each generation into a detached-on-cleanup host. A superseded
      // async embed may still finish, but it can no longer replace the current
      // generation's DOM while it is being finalized.
      const mountHost = document.createElement("div");
      mountHost.className = "w-full";
      container.replaceChildren(mountHost);
      void mountVegaLiteView({
        container: mountHost,
        initialState: stateToRestore,
        parsed,
        renderPlan,
        theme,
        title,
      }).then(
        (mounted) => {
          if (disposed) {
            mounted.result.finalize();
            return;
          }
          mountedRef.current = mounted;
          preservedThemeStateRef.current = null;
          onReadyRef.current(mounted);
        },
        (cause) => {
          if (!disposed) {
            onErrorRef.current(
              cause instanceof Error ? cause : new Error("Vega-Lite could not render this chart."),
            );
          }
        },
      );

      return () => {
        disposed = true;
        const mounted = mountedRef.current;
        const preserveState = shouldPreserveVegaLiteStateForThemeRemount(
          mountIdentity,
          latestMountIdentityRef.current,
        );
        if (mounted != null && preserveState) {
          preservedThemeStateRef.current = mounted.result.view.getState();
        } else if (!preserveState) {
          preservedThemeStateRef.current = null;
        }
        mounted?.result.finalize();
        mountedRef.current = null;
        if (mountHost.parentNode === container) mountHost.remove();
      };
    }, [initialState, parsed, renderPlan, theme, title]);

    useEffect(() => {
      const container = containerRef.current;
      if (container == null || !renderPlan.responsive || typeof ResizeObserver === "undefined") {
        return;
      }

      const scheduleResize = (entries: ReadonlyArray<ResizeObserverEntry>) => {
        const nextWidth = entries[0]?.contentRect.width ?? container.clientWidth;
        if (!isMeaningfulVegaLiteWidthChange(observedWidthRef.current, nextWidth)) return;
        observedWidthRef.current = nextWidth;
        if (resizeFrameRef.current != null) return;
        resizeFrameRef.current = requestAnimationFrame(() => {
          resizeFrameRef.current = null;
          resizeQueueRef.current = resizeQueueRef.current
            .then(async () => {
              const mounted = mountedRef.current;
              if (mounted == null) return;
              mounted.result.view.resize();
              await mounted.result.view.runAsync();
            })
            .catch((cause: unknown) => {
              onErrorRef.current(
                cause instanceof Error ? cause : new Error("The chart could not be resized."),
              );
            });
        });
      };

      const observer = new ResizeObserver(scheduleResize);
      observer.observe(container);
      return () => {
        observer.disconnect();
        observedWidthRef.current = null;
        if (resizeFrameRef.current != null) cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      };
    }, [renderPlan.responsive]);

    return (
      <div
        {...props}
        ref={containerRef}
        className={cn("scient-vega-lite-view min-w-0", className)}
      />
    );
  },
);
