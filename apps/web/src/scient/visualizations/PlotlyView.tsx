import { forwardRef, useEffect, useImperativeHandle, useRef, type HTMLAttributes } from "react";

import { cn } from "~/lib/utils";

import { plotlyMountQueue } from "./plotlyMountQueue";
import {
  mountPlotlyView,
  normalizedPlotlyError,
  type PlotlyInteractionMode,
  type MountedPlotlyView,
  type PlotlySurface,
  type PlotlyTheme,
  type PlotlyViewState,
} from "./plotlyRuntime";
import type { ParsedPlotlySource } from "./plotlySpec";

export interface PlotlyViewController {
  readonly getDimensions: () => { readonly height: number; readonly width: number };
  readonly getInteractionMode: () => PlotlyInteractionMode;
  readonly getState: () => PlotlyViewState | null;
  readonly reset: () => Promise<void>;
  readonly setInteractionMode: (mode: PlotlyInteractionMode) => Promise<void>;
  readonly setState: (state: PlotlyViewState) => Promise<void>;
  readonly toImage: (format: "png" | "svg", scale: number) => Promise<string>;
}

export function plotlyResizeChanged(
  surface: PlotlySurface,
  previous: { readonly height: number | null; readonly width: number | null },
  next: { readonly height: number; readonly width: number },
): boolean {
  if (previous.width == null || Math.abs(previous.width - next.width) >= 1) return true;
  return (
    surface === "expanded" &&
    (previous.height == null || Math.abs(previous.height - next.height) >= 1)
  );
}

interface PlotlyViewProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "onError" | "title"
> {
  readonly initialState?: PlotlyViewState | null | undefined;
  readonly onError: (error: Error) => void;
  readonly onReady: (mounted: MountedPlotlyView) => void;
  readonly onWebGlContextLost: () => void;
  readonly parsed: ParsedPlotlySource;
  readonly surface: PlotlySurface;
  readonly theme: PlotlyTheme;
}

export const PlotlyView = forwardRef<PlotlyViewController, PlotlyViewProps>(function PlotlyView(
  {
    className,
    initialState,
    onError,
    onReady,
    onWebGlContextLost,
    parsed,
    surface,
    theme,
    ...props
  },
  forwardedRef,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef<MountedPlotlyView | null>(null);
  const onErrorRef = useRef(onError);
  const onReadyRef = useRef(onReady);
  const onWebGlContextLostRef = useRef(onWebGlContextLost);
  const surfaceRef = useRef(surface);
  const themeRef = useRef(theme);
  const resizeFrameRef = useRef<number | null>(null);
  const observedSizeRef = useRef<{ height: number | null; width: number | null }>({
    height: null,
    width: null,
  });
  const presentationQueueRef = useRef<Promise<void>>(Promise.resolve());

  onErrorRef.current = onError;
  onReadyRef.current = onReady;
  onWebGlContextLostRef.current = onWebGlContextLost;
  surfaceRef.current = surface;
  themeRef.current = theme;

  useImperativeHandle(
    forwardedRef,
    () => ({
      getDimensions() {
        const mounted = mountedRef.current;
        if (mounted == null) throw new Error("The Plotly figure is not ready.");
        return mounted.getDimensions();
      },
      getInteractionMode() {
        const mounted = mountedRef.current;
        if (mounted == null) throw new Error("The Plotly figure is not ready.");
        return mounted.getInteractionMode();
      },
      getState: () => mountedRef.current?.getState() ?? null,
      async reset() {
        const mounted = mountedRef.current;
        if (mounted == null) throw new Error("The Plotly figure is not ready.");
        await mounted.reset();
      },
      async setInteractionMode(mode) {
        const mounted = mountedRef.current;
        if (mounted == null) throw new Error("The Plotly figure is not ready.");
        await mounted.setInteractionMode(mode);
      },
      async setState(state) {
        const mounted = mountedRef.current;
        if (mounted == null) throw new Error("The Plotly figure is not ready.");
        await mounted.setState(state);
      },
      async toImage(format, scale) {
        const mounted = mountedRef.current;
        if (mounted == null) throw new Error("The Plotly figure is not ready.");
        return mounted.toImage(format, scale);
      },
    }),
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (host == null) return;

    // Plotly mutates its graph div (including its class list and private plot
    // markers). Keep that div outside React's reconciliation boundary so a
    // loading/ready class update on the host cannot invalidate the live plot.
    const container = host.ownerDocument.createElement("div");
    container.className = "scient-plotly-graph";
    host.replaceChildren(container);

    let cancelled = false;
    let ownedMount: MountedPlotlyView | null = null;
    const releaseOwnedMount = () => {
      const mounted = ownedMount;
      if (mounted == null) return;
      ownedMount = null;
      if (mountedRef.current === mounted) mountedRef.current = null;
      mounted.dispose();
    };

    // Let React's Strict Mode probe cancel before Plotly mutates the graph div.
    let startFrame: number | null = requestAnimationFrame(() => {
      startFrame = null;
      void plotlyMountQueue.enqueue(async () => {
        if (cancelled) return;
        container.replaceChildren();
        try {
          ownedMount = await mountPlotlyView({
            container,
            initialState,
            onWebGlContextLost: () => onWebGlContextLostRef.current(),
            parsed,
            surface: surfaceRef.current,
            theme: themeRef.current,
          });
          if (cancelled) {
            releaseOwnedMount();
            return;
          }
          if (themeRef.current !== theme || surfaceRef.current !== surface) {
            await ownedMount.updatePresentation(themeRef.current, surfaceRef.current);
          }
          if (cancelled) {
            releaseOwnedMount();
            return;
          }
          mountedRef.current = ownedMount;
          onReadyRef.current(ownedMount);
        } catch (cause) {
          releaseOwnedMount();
          if (!cancelled) {
            console.error("[scient-visualizations] Plotly mount failed", cause);
            onErrorRef.current(normalizedPlotlyError(cause));
          }
        }
      });
    });

    return () => {
      cancelled = true;
      if (startFrame != null) cancelAnimationFrame(startFrame);
      const mounted = ownedMount;
      ownedMount = null;
      if (mounted != null) {
        if (mountedRef.current === mounted) mountedRef.current = null;
        void plotlyMountQueue.enqueue(async () => mounted.dispose());
      }
      container.remove();
    };
  }, [initialState, parsed]);

  useEffect(() => {
    const mounted = mountedRef.current;
    if (mounted == null) return;
    presentationQueueRef.current = presentationQueueRef.current
      .then(async () => {
        if (mountedRef.current !== mounted) return;
        await mounted.updatePresentation(theme, surface);
      })
      .catch((cause: unknown) => {
        if (mountedRef.current === mounted) onErrorRef.current(normalizedPlotlyError(cause));
      });
  }, [surface, theme]);

  useEffect(() => {
    const host = hostRef.current;
    if (host == null || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const nextWidth = entry?.contentRect.width ?? host.clientWidth;
      const nextHeight = entry?.contentRect.height ?? host.clientHeight;
      if (!(nextWidth > 0) || (surfaceRef.current === "expanded" && !(nextHeight > 0))) return;
      const previous = observedSizeRef.current;
      if (
        !plotlyResizeChanged(surfaceRef.current, previous, {
          height: nextHeight,
          width: nextWidth,
        })
      ) {
        return;
      }
      observedSizeRef.current = { height: nextHeight, width: nextWidth };
      if (resizeFrameRef.current != null) return;
      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        try {
          mountedRef.current?.resize();
        } catch (cause) {
          onErrorRef.current(normalizedPlotlyError(cause));
        }
      });
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      observedSizeRef.current = { height: null, width: null };
      if (resizeFrameRef.current != null) cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    };
  }, []);

  return <div {...props} ref={hostRef} className={cn("scient-plotly-view", className)} />;
});
