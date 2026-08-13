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

const CURRENCY_TEXT_PATTERN = /^[\d\s.,;:!?+\-*/^%~()]+$/;
const PROSE_WORD_PATTERN = /[a-zA-Z]{2,}/;
const MATH_STRUCTURE_PATTERN = /[=^_{}]/;

/**
 * Prices are the one thing single-dollar math gets wrong: `$5 and $10` reads to
 * remark-math as one math span whose TeX is `5 and `. Anything digit-only goes
 * back out literally, and so does digit-led prose — a word of two or more
 * letters with no control sequence or math structure around it.
 */
export function isLikelyCurrencyText(tex: string): boolean {
  if (!/\d/.test(tex) || tex.includes("\\")) {
    return false;
  }
  if (CURRENCY_TEXT_PATTERN.test(tex)) {
    return true;
  }
  return /^\s*\d/.test(tex) && PROSE_WORD_PATTERN.test(tex) && !MATH_STRUCTURE_PATTERN.test(tex);
}

function estimateRenderedMathSize(html: string, tex: string): number {
  return Math.max(html.length * 2, tex.length * 3);
}

/**
 * Display math is always intentional math — `$$` around a bare number still
 * means an equation. Only single-dollar inline spans are ambiguous with money.
 */
export function shouldRenderMathAsCurrency(tex: string, displayMode: boolean): boolean {
  return !displayMode && isLikelyCurrencyText(tex);
}

/**
 * What highlight-and-copy emits for a math node: the dollar-form source, so a
 * copied message re-renders as the same math (`markdown-clipboard.ts` returns
 * `data-markdown-copy` verbatim instead of walking KaTeX's DOM).
 */
function mathMarkdownCopySource(tex: string, displayMode: boolean): string {
  return displayMode ? `$$\n${tex}\n$$\n\n` : `$${tex}$`;
}

interface ScientMathProps {
  tex: string;
  displayMode: boolean;
  isStreaming: boolean;
}

function ScientMathLiteral({ tex, displayMode }: Omit<ScientMathProps, "isStreaming">) {
  return (
    <code dir="ltr" data-markdown-copy={mathMarkdownCopySource(tex, displayMode)}>
      {displayMode ? `$$${tex}$$` : `$${tex}$`}
    </code>
  );
}

/** Currency reads as prose, so it goes back into the sentence unstyled. */
function ScientMathCurrencyText({ tex }: { tex: string }) {
  return <span dir="ltr">{`$${tex}$`}</span>;
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
    if (!isStreaming) {
      renderedMathCache.set(cacheKey, html, estimateRenderedMathSize(html, tex));
    }
  }, [cacheKey, html, isStreaming, tex]);

  return <ScientMathHtml html={html} tex={tex} displayMode={displayMode} />;
}

function ScientMath({ displayMode, isStreaming, tex }: ScientMathProps) {
  const literal = <ScientMathLiteral tex={tex} displayMode={displayMode} />;
  if (shouldRenderMathAsCurrency(tex, displayMode)) {
    return <ScientMathCurrencyText tex={tex} />;
  }

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
