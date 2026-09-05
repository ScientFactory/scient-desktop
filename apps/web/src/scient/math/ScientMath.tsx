import { Suspense, use, useMemo } from "react";

import { RenderErrorBoundary } from "~/components/RenderErrorBoundary";
import { LRUCache } from "~/lib/lruCache";

import "./scient-math.css";

let runtimePromise: Promise<typeof import("./katexRuntime")> | null = null;

/** Caches the promise rather than the module, so the chunk is requested once. */
export function getScientKatexRuntimePromise() {
  runtimePromise ??= import("./katexRuntime");
  return runtimePromise;
}

const MAX_MATH_CACHE_ENTRIES = 500;
const MAX_MATH_CACHE_MEMORY_BYTES = 5 * 1024 * 1024;
const renderedMathCache = new LRUCache<{ readonly html: string | null }>(
  MAX_MATH_CACHE_ENTRIES,
  MAX_MATH_CACHE_MEMORY_BYTES,
);

function estimateRenderedMathSize(html: string, tex: string): number {
  return Math.max(html.length * 2, tex.length * 3);
}

/** Shared by editor validation and presentation within the existing bounded cache. */
export function renderCachedScientMath(
  runtime: typeof import("./katexRuntime"),
  tex: string,
  displayMode: boolean,
): string | null {
  const key = `${displayMode}:${tex}`;
  const cached = renderedMathCache.get(key);
  if (cached !== null) return cached.html;
  const html = runtime.renderScientTexToHtml(tex, displayMode);
  renderedMathCache.set(key, { html }, estimateRenderedMathSize(html ?? "", tex));
  return html;
}

/**
 * What highlight-and-copy emits for a math node: the dollar-form source, so a
 * copied message re-renders as the same math (`markdown-clipboard.ts` returns
 * `data-markdown-copy` verbatim instead of walking KaTeX's DOM). Both modes
 * use `$$`: it re-renders unconditionally, while a single-dollar form would
 * be subject to the guarded tokenizer's plausibility rules on paste. The
 * newline framing keeps display math a block.
 */
function mathMarkdownCopySource(tex: string, displayMode: boolean): string {
  return displayMode ? `$$\n${tex}\n$$\n\n` : `$$${tex}$$`;
}

interface ScientMathProps {
  tex: string;
  displayMode: boolean;
  isStreaming: boolean;
}

/** The fallback for loading, render failure, and unsupported TeX: the source as typed. */
function ScientMathLiteral({ tex, displayMode }: Omit<ScientMathProps, "isStreaming">) {
  return (
    <code dir="ltr" data-markdown-copy={mathMarkdownCopySource(tex, displayMode)}>
      {`$$${tex}$$`}
    </code>
  );
}

function ScientMathHtml({
  html,
  tex,
  displayMode,
}: {
  html: string;
  tex: string;
  displayMode: boolean;
}) {
  // KaTeX escapes its own input, so its output is the only markup injected here.
  return (
    <span
      className={displayMode ? "scient-math-display" : "scient-math-inline"}
      dir="ltr"
      data-markdown-copy={mathMarkdownCopySource(tex, displayMode)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function UncachedScientMath({ displayMode, isStreaming, tex }: ScientMathProps) {
  const runtime = use(getScientKatexRuntimePromise());
  // Streaming prefixes stay outside the cache. Settled math, including failed
  // parses, shares one bounded result with editor validation.
  const html = useMemo(
    () =>
      isStreaming
        ? runtime.renderScientTexToHtml(tex, displayMode)
        : renderCachedScientMath(runtime, tex, displayMode),
    [displayMode, isStreaming, runtime, tex],
  );

  if (html === null) {
    return <ScientMathLiteral tex={tex} displayMode={displayMode} />;
  }
  return <ScientMathHtml html={html} tex={tex} displayMode={displayMode} />;
}

function ScientMath({ displayMode, isStreaming, tex }: ScientMathProps) {
  const literal = <ScientMathLiteral tex={tex} displayMode={displayMode} />;

  const cacheKey = `${displayMode}:${tex}`;
  const cachedHtml = isStreaming ? null : renderedMathCache.get(cacheKey);
  if (cachedHtml != null) {
    return cachedHtml.html === null ? (
      literal
    ) : (
      <ScientMathHtml html={cachedHtml.html} tex={tex} displayMode={displayMode} />
    );
  }

  return (
    <RenderErrorBoundary fallback={literal}>
      <Suspense fallback={literal}>
        <UncachedScientMath displayMode={displayMode} isStreaming={isStreaming} tex={tex} />
      </Suspense>
    </RenderErrorBoundary>
  );
}

export function ScientInlineMath({
  tex,
  isStreaming = false,
}: {
  tex: string;
  isStreaming?: boolean;
}) {
  return <ScientMath tex={tex} displayMode={false} isStreaming={isStreaming} />;
}

export function ScientDisplayMath({
  tex,
  isStreaming = false,
}: {
  tex: string;
  isStreaming?: boolean;
}) {
  return <ScientMath tex={tex} displayMode={true} isStreaming={isStreaming} />;
}
