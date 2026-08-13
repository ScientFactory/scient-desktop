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

interface ScientMathProps {
  tex: string;
  displayMode: boolean;
}

function ScientMathLiteral({ tex, displayMode }: ScientMathProps) {
  return <code dir="ltr">{displayMode ? `$$${tex}$$` : `$${tex}$`}</code>;
}

/** Currency reads as prose, so it goes back into the sentence unstyled. */
function ScientMathCurrencyText({ tex, displayMode }: ScientMathProps) {
  return <span dir="ltr">{displayMode ? `$$${tex}$$` : `$${tex}$`}</span>;
}

function ScientMathHtml({ html, displayMode }: { html: string; displayMode: boolean }) {
  // KaTeX escapes its own input, so its output is the only markup injected here.
  return displayMode ? (
    <span className="scient-math-display" dir="ltr" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className="scient-math-inline" dir="ltr" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

interface UncachedScientMathProps extends ScientMathProps {
  cacheKey: string;
}

function UncachedScientMath({ cacheKey, displayMode, tex }: UncachedScientMathProps) {
  const { renderScientTexToHtml } = use(getScientKatexRuntimePromise());
  const html = useMemo(
    () => renderScientTexToHtml(tex, displayMode),
    [displayMode, renderScientTexToHtml, tex],
  );

  useEffect(() => {
    renderedMathCache.set(cacheKey, html, estimateRenderedMathSize(html, tex));
  }, [cacheKey, html, tex]);

  return <ScientMathHtml html={html} displayMode={displayMode} />;
}

function ScientMath({ displayMode, tex }: ScientMathProps) {
  const literal = <ScientMathLiteral tex={tex} displayMode={displayMode} />;
  if (isLikelyCurrencyText(tex)) {
    return <ScientMathCurrencyText tex={tex} displayMode={displayMode} />;
  }

  const cacheKey = `${displayMode}:${tex}`;
  const cachedHtml = renderedMathCache.get(cacheKey);
  if (cachedHtml != null) {
    return <ScientMathHtml html={cachedHtml} displayMode={displayMode} />;
  }

  return (
    <RenderErrorBoundary fallback={literal}>
      <Suspense fallback={literal}>
        <UncachedScientMath cacheKey={cacheKey} displayMode={displayMode} tex={tex} />
      </Suspense>
    </RenderErrorBoundary>
  );
}

export function ScientInlineMath({ tex }: { tex: string }) {
  return <ScientMath tex={tex} displayMode={false} />;
}

export function ScientDisplayMath({ tex }: { tex: string }) {
  return <ScientMath tex={tex} displayMode={true} />;
}
