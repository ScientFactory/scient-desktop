import { Suspense, use, useEffect, useMemo, useState, type ReactNode } from "react";
import { toHtml } from "hast-util-to-html";
import { RenderErrorBoundary } from "~/components/RenderErrorBoundary";
import { HighlightedCodeLines } from "~/components/chat/HighlightedCodeLines";
import { fnv1a32, resolveDiffThemeName, type DiffThemeName } from "~/lib/diffRendering";
import { createIncrementalHighlightedDocument } from "~/lib/incrementalHighlighting";
import { LRUCache } from "~/lib/lruCache";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { CodeBlockActions, useCodeBlockWordWrap } from "./CodeBlockActions";
import { CodeBlockTitle } from "./CodeBlockTitle";

// Shared by ordinary chat fences and read-only rich-fence source fallbacks.
const highlightedCodeCache = new LRUCache<string>(500, 50 * 1024 * 1024);

export function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  theme,
  copyTextDirection = "ltr",
  isStreaming = false,
  className,
  fallback,
  onCopyFailure,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  copyTextDirection?: "auto" | "rtl" | "ltr";
  isStreaming?: boolean;
  className?: string;
  fallback?: ReactNode;
  onCopyFailure?: (cause: unknown) => void;
}) {
  const [wrapped, setWrapped] = useCodeBlockWordWrap();
  const themeName = resolveDiffThemeName(theme);
  const plainSource = fallback ?? (
    <pre>
      <code className={`language-${language}`}>{code}</code>
    </pre>
  );

  return (
    <div
      className={cn(
        "chat-markdown-codeblock my-[0.65rem] overflow-hidden rounded-[var(--radius)] border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32",
        className,
      )}
      dir={copyTextDirection}
      data-language={language}
      data-copy-text-direction={copyTextDirection}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div className="chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none">
        <span className="inline-flex min-w-0 items-center gap-[0.4rem] [font-family:var(--font-mono,ui-monospace,SFMono-Regular,monospace)] [font-size:0.6875rem]">
          <CodeBlockTitle fenceTitle={fenceTitle} language={language} theme={theme} />
        </span>
        <CodeBlockActions
          wrapped={wrapped}
          onWrapChange={setWrapped}
          readCode={() => code}
          {...(onCopyFailure ? { onCopyFailure } : {})}
        />
      </div>
      <RenderErrorBoundary
        resetKeys={[code, language, themeName, isStreaming]}
        fallback={plainSource}
      >
        <Suspense fallback={plainSource}>
          <HighlightedCode
            code={code}
            language={language}
            themeName={themeName}
            isStreaming={isStreaming}
          />
        </Suspense>
      </RenderErrorBoundary>
    </div>
  );
}

interface HighlightedCodeProps {
  code: string;
  language: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}

function HighlightedCode({ code, language, themeName, isStreaming }: HighlightedCodeProps) {
  const [hasStreamed, setHasStreamed] = useState(isStreaming);
  if (isStreaming && !hasStreamed) setHasStreamed(true);
  const cacheKey = `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
  // Once lines are mounted individually, retain that renderer after streaming
  // finishes so replacing the whole pre cannot clear an active selection.
  const cached = !isStreaming && !hasStreamed ? highlightedCodeCache.get(cacheKey) : null;
  if (cached != null) {
    return <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: cached }} />;
  }
  return (
    <UncachedHighlightedCode
      code={code}
      language={language}
      themeName={themeName}
      isStreaming={isStreaming}
      cacheKey={cacheKey}
      preserveLines={isStreaming || hasStreamed}
    />
  );
}

function UncachedHighlightedCode({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
  preserveLines,
}: HighlightedCodeProps & { cacheKey: string; preserveLines: boolean }) {
  const highlighter = use(getSyntaxHighlighterPromise(language));
  const incrementalHighlight = useMemo(
    () =>
      preserveLines ? createIncrementalHighlightedDocument(highlighter, language, themeName) : null,
    [highlighter, language, preserveLines, themeName],
  );
  const highlighted = useMemo(() => {
    try {
      if (incrementalHighlight) return incrementalHighlight(code);
      return preserveLines
        ? highlighter.codeToHast(code, { lang: language, theme: themeName })
        : highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      return preserveLines
        ? highlighter.codeToHast(code, { lang: "text", theme: themeName })
        : highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, incrementalHighlight, language, preserveLines, themeName]);

  useEffect(() => {
    if (!isStreaming) {
      const highlightedHtml = typeof highlighted === "string" ? highlighted : toHtml(highlighted);
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        Math.max(highlightedHtml.length * 2, code.length * 3),
      );
    }
  }, [cacheKey, code, highlighted, isStreaming]);

  return typeof highlighted === "string" ? (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlighted }} />
  ) : (
    <div className="chat-markdown-shiki">
      <HighlightedCodeLines root={highlighted} />
    </div>
  );
}
