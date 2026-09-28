import { LRUCache } from "~/lib/lruCache";
import { dependencies } from "../../../package.json";
import { sharedIsolatedMermaid } from "./isolatedMermaid";
import {
  isMermaidSyntaxError,
  planMermaidRecovery,
  MAX_MERMAID_SOURCE_LENGTH,
  type MermaidRecovery,
} from "./mermaidRecovery";
import { stripSvgExternalResources } from "./svgExternalResources";
export { MAX_MERMAID_SOURCE_LENGTH } from "./mermaidRecovery";

export const MERMAID_VERSION = dependencies.mermaid;

export type MermaidTheme = "light" | "dark";

/**
 * Where Mermaid draws. `frame` is the shared no-network frame (`isolatedMermaid.ts`), and
 * its SVG is stripped of anything that would load from outside before it is returned.
 * `page` draws in this document; only a page that itself cannot fetch (the PDF document
 * page) uses it.
 */
export type MermaidIsolation = "frame" | "page";

export interface RenderedMermaidDiagram {
  readonly svg: string;
  readonly diagramType: string;
  readonly recovery?: MermaidRecovery;
  /** Outside addresses the diagram named and that were left out of it. */
  readonly blocked?: ReadonlyArray<string>;
}

const MAX_MERMAID_EDGES = 500;
const MAX_RENDER_CACHE_ENTRIES = 100;
const MAX_RENDER_CACHE_MEMORY_BYTES = 20 * 1024 * 1024;

interface CachedMermaidDiagram {
  readonly svgTemplate: string;
  readonly diagramType: string;
  readonly recovery?: MermaidRecovery;
  readonly blocked?: ReadonlyArray<string>;
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

function renderCacheKey(source: string, theme: MermaidTheme, isolation: MermaidIsolation): string {
  return `${isolation}\u0000${theme}\u0000${source}`;
}

function estimateDiagramSize(source: string, rendered: CachedMermaidDiagram): number {
  return (
    source.length * 2 +
    rendered.svgTemplate.length * 2 +
    (rendered.recovery ? JSON.stringify(rendered.recovery).length * 2 : 0) +
    (rendered.blocked ? JSON.stringify(rendered.blocked).length * 2 : 0)
  );
}

/** Keep the parser's source excerpt/caret for repair, without exposing a stack trace. */
export class MermaidRenderError extends Error {
  readonly details: string;

  constructor(cause: unknown) {
    const detail =
      cause instanceof Error && cause.message.trim()
        ? cause.message.trim()
        : "Mermaid could not render this diagram.";
    super(detail.split("\n")[0]?.slice(0, 240), { cause });
    this.name = "MermaidRenderError";
    this.details = detail.length > 8_000 ? `${detail.slice(0, 8_000)}\n[Error truncated]` : detail;
  }
}

function enqueueRender<T>(operation: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(operation, operation);
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** The settings every Scient Mermaid render uses, in chat and in exports alike. */
export function mermaidRenderConfig(theme: MermaidTheme): import("mermaid").MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    // Mermaid 12 changes these defaults. Preserve existing diagrams' appearance;
    // authors can still opt into ELK/neo through valid Mermaid frontmatter.
    layout: "dagre",
    look: "classic",
    theme: theme === "dark" ? "dark" : "default",
    darkMode: theme === "dark",
    maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
    maxEdges: MAX_MERMAID_EDGES,
    htmlLabels: true,
    forceLegacyMathML: true,
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    logLevel: "fatal",
  };
}

async function renderIsolatedTemplate(
  source: string,
  theme: MermaidTheme,
): Promise<CachedMermaidDiagram> {
  const frame = await sharedIsolatedMermaid();
  const result = await frame.render(source, { theme, awaitRefusals: false });
  if (!result.svg.includes("<svg")) {
    throw new Error("Mermaid returned an invalid diagram.");
  }
  // The note names what the SVG itself referred to. The frame's own refusal reports arrive
  // later and could belong to the previous draw, so they are not used here.
  const stripped = stripSvgExternalResources(result.svg);
  return {
    svgTemplate: stripped.svg,
    diagramType: result.diagramType,
    ...(stripped.blocked.length > 0 ? { blocked: stripped.blocked } : {}),
  };
}

async function renderNativeTemplate(
  source: string,
  theme: MermaidTheme,
  isolation: MermaidIsolation,
): Promise<CachedMermaidDiagram> {
  if (isolation === "frame") return renderIsolatedTemplate(source, theme);
  const { default: mermaid } = await getMermaidRuntimePromise();
  mermaid.initialize(mermaidRenderConfig(theme));

  const result = await mermaid.render(nextRenderId("render"), source);
  if (!result.svg.includes("<svg")) {
    throw new Error("Mermaid returned an invalid diagram.");
  }
  return { svgTemplate: result.svg, diagramType: result.diagramType };
}

async function renderTemplate(
  source: string,
  theme: MermaidTheme,
  isolation: MermaidIsolation,
): Promise<CachedMermaidDiagram> {
  return enqueueRender(async () => {
    try {
      return await renderNativeTemplate(source, theme, isolation);
    } catch (originalError) {
      if (isMermaidSyntaxError(originalError)) {
        try {
          const recovery = planMermaidRecovery(source);
          if (recovery) {
            // One atomic candidate, containing every compatible edit. A later
            // parse/layout failure must not expose partial repairs or its error.
            const rendered = await renderNativeTemplate(recovery.source, theme, isolation);
            return { ...rendered, recovery };
          }
        } catch {
          // Preserve the original diagnostic, source and existing agent fallback.
        }
      }
      throw originalError;
    }
  });
}

async function getTemplate(
  source: string,
  theme: MermaidTheme,
  isolation: MermaidIsolation,
): Promise<CachedMermaidDiagram> {
  const key = renderCacheKey(source, theme, isolation);
  const cached = renderCache.get(key);
  if (cached != null) return cached;

  const existing = inFlightRenders.get(key);
  if (existing != null) return existing;

  const pending = renderTemplate(source, theme, isolation)
    .then((rendered) => {
      renderCache.set(key, rendered, estimateDiagramSize(source, rendered));
      return rendered;
    })
    .finally(() => {
      inFlightRenders.delete(key);
    });
  inFlightRenders.set(key, pending);
  return pending;
}

/** Draws a diagram in the no-network frame unless `isolation` says otherwise. */
export async function renderMermaidDiagram(
  unvalidatedSource: string,
  theme: MermaidTheme,
  isolation: MermaidIsolation = "frame",
): Promise<RenderedMermaidDiagram> {
  const source = validateSource(unvalidatedSource);

  try {
    const template = await getTemplate(source, theme, isolation);
    return {
      svg: rebaseMermaidSvgIds(template.svgTemplate, nextRenderId("instance")),
      diagramType: template.diagramType,
      ...(template.recovery ? { recovery: template.recovery } : {}),
      ...(template.blocked ? { blocked: template.blocked } : {}),
    };
  } catch (cause) {
    throw new MermaidRenderError(cause);
  }
}
