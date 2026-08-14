import { LRUCache } from "~/lib/lruCache";

export type MermaidTheme = "light" | "dark";

export interface RenderedMermaidDiagram {
  readonly svg: string;
  readonly diagramType: string;
}

export const MAX_MERMAID_SOURCE_LENGTH = 50_000;
const MAX_MERMAID_EDGES = 500;
const MAX_RENDER_CACHE_ENTRIES = 100;
const MAX_RENDER_CACHE_MEMORY_BYTES = 20 * 1024 * 1024;

interface CachedMermaidDiagram {
  readonly svgTemplate: string;
  readonly diagramType: string;
}

let mermaidRuntimePromise: Promise<typeof import("mermaid")> | null = null;
let renderQueue: Promise<void> = Promise.resolve();
let renderSequence = 0;

const renderCache = new LRUCache<CachedMermaidDiagram>(
  MAX_RENDER_CACHE_ENTRIES,
  MAX_RENDER_CACHE_MEMORY_BYTES,
);
const inFlightRenders = new Map<string, Promise<CachedMermaidDiagram>>();

/** Mermaid is a large dependency, so it is requested only after a settled diagram enters view. */
export function getMermaidRuntimePromise(): Promise<typeof import("mermaid")> {
  mermaidRuntimePromise ??= import("mermaid");
  return mermaidRuntimePromise;
}

function nextRenderId(prefix: string): string {
  renderSequence += 1;
  return `scient-${prefix}-${renderSequence.toString(36)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Cached Mermaid SVGs contain document-level ids for markers, masks, and
 * accessibility labels. Rebase every id and its fragment/list references so
 * two copies of the same diagram can coexist without cross-wiring their SVGs.
 */
export function rebaseMermaidSvgIds(svg: string, prefix: string): string {
  const idPattern = /\bid=(['"])([^'"\s<>]+)\1/g;
  const replacements = new Map<string, string>();
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = idPattern.exec(svg)) != null) {
    const currentId = match[2];
    if (currentId && !replacements.has(currentId)) {
      replacements.set(currentId, `${prefix}-${index.toString(36)}`);
      index += 1;
    }
  }

  if (replacements.size === 0) return svg;

  let rebased = svg.replace(idPattern, (fullMatch, quote: string, currentId: string) => {
    const replacement = replacements.get(currentId);
    return replacement == null ? fullMatch : `id=${quote}${replacement}${quote}`;
  });

  for (const [currentId, replacement] of replacements) {
    const fragmentPattern = new RegExp(`#${escapeRegExp(currentId)}(?![\\w:.-])`, "g");
    rebased = rebased.replace(fragmentPattern, `#${replacement}`);
  }

  const listReferencePattern = /\b(aria-labelledby|aria-describedby)=(["'])([^"']*)\2/g;
  rebased = rebased.replace(
    listReferencePattern,
    (fullMatch, attribute: string, quote: string, value: string) => {
      const tokens = value.split(/\s+/).map((token) => replacements.get(token) ?? token);
      return `${attribute}=${quote}${tokens.join(" ")}${quote}`;
    },
  );

  return rebased;
}

function validateSource(source: string): string {
  if (source.trim().length === 0) {
    throw new Error("The diagram source is empty.");
  }
  if (source.length > MAX_MERMAID_SOURCE_LENGTH) {
    throw new Error(
      `The diagram is too large to render (${source.length.toLocaleString()} characters; maximum ${MAX_MERMAID_SOURCE_LENGTH.toLocaleString()}).`,
    );
  }
  return source;
}

function renderCacheKey(source: string, theme: MermaidTheme): string {
  return `${theme}\u0000${source}`;
}

function estimateDiagramSize(source: string, svg: string): number {
  return source.length * 2 + svg.length * 2;
}

function normalizedRenderError(cause: unknown): Error {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    const firstLine = cause.message.split("\n").find((line) => line.trim().length > 0);
    return new Error(firstLine?.trim() || "Mermaid could not render this diagram.", {
      cause,
    });
  }
  return new Error("Mermaid could not render this diagram.", { cause });
}

function enqueueRender<T>(operation: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(operation, operation);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function renderTemplate(source: string, theme: MermaidTheme): Promise<CachedMermaidDiagram> {
  return enqueueRender(async () => {
    const { default: mermaid } = await getMermaidRuntimePromise();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: theme === "dark" ? "dark" : "default",
      darkMode: theme === "dark",
      maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
      maxEdges: MAX_MERMAID_EDGES,
      htmlLabels: true,
      forceLegacyMathML: true,
      fontFamily:
        'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      logLevel: "fatal",
    });

    const result = await mermaid.render(nextRenderId("render"), source);
    if (!result.svg.includes("<svg")) {
      throw new Error("Mermaid returned an invalid diagram.");
    }
    return { svgTemplate: result.svg, diagramType: result.diagramType };
  });
}

async function getTemplate(source: string, theme: MermaidTheme): Promise<CachedMermaidDiagram> {
  const key = renderCacheKey(source, theme);
  const cached = renderCache.get(key);
  if (cached != null) return cached;

  const existing = inFlightRenders.get(key);
  if (existing != null) return existing;

  const pending = renderTemplate(source, theme)
    .then((rendered) => {
      renderCache.set(key, rendered, estimateDiagramSize(source, rendered.svgTemplate));
      return rendered;
    })
    .finally(() => {
      inFlightRenders.delete(key);
    });
  inFlightRenders.set(key, pending);
  return pending;
}

export async function renderMermaidDiagram(
  unvalidatedSource: string,
  theme: MermaidTheme,
): Promise<RenderedMermaidDiagram> {
  const source = validateSource(unvalidatedSource);

  try {
    const template = await getTemplate(source, theme);
    return {
      svg: rebaseMermaidSvgIds(template.svgTemplate, nextRenderId("instance")),
      diagramType: template.diagramType,
    };
  } catch (cause) {
    throw normalizedRenderError(cause);
  }
}
