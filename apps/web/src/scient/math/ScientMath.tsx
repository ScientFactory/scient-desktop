import { Suspense, use, useEffect, useMemo } from "react";

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
const renderedMathCache = new LRUCache<string>(MAX_MATH_CACHE_ENTRIES, MAX_MATH_CACHE_MEMORY_BYTES);

function estimateRenderedMathSize(html: string, tex: string): number {
  return Math.max(html.length * 2, tex.length * 3);
}

/**
 * What highlight-and-copy emits for a math node: the dollar-form source, so a
 * copied message re-renders as the same math (`markdown-clipboard.ts` returns
 * `data-markdown-copy` verbatim instead of walking KaTeX's DOM). Both modes
 * use `$$`, the only dollar form recognized — single-dollar `$...$` would not
 * re-render on paste; the newline framing keeps display math a block.
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

interface UncachedScientMathProps extends ScientMathProps {
  cacheKey: string;
}

function UncachedScientMath({ cacheKey, displayMode, isStreaming, tex }: UncachedScientMathProps) {
  const { renderScientTexToHtml } = use(getScientKatexRuntimePromise());
  const html = useMemo(
    () => renderScientTexToHtml(tex, displayMode),
    [displayMode, renderScientTexToHtml, tex],
  );

  // A streaming message re-renders per token, so an unclosed block's growing
  // prefixes would each occupy an entry; only settled math is worth caching.
  useEffect(() => {
    if (html !== null && !isStreaming) {
      renderedMathCache.set(cacheKey, html, estimateRenderedMathSize(html, tex));
    }
  }, [cacheKey, html, isStreaming, tex]);

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
    return <ScientMathHtml html={cachedHtml} tex={tex} displayMode={displayMode} />;
  }

  return (
    <RenderErrorBoundary fallback={literal}>
      <Suspense fallback={literal}>
        <UncachedScientMath
          cacheKey={cacheKey}
          displayMode={displayMode}
          isStreaming={isStreaming}
          tex={tex}
        />
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
