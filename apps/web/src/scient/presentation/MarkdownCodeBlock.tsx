import { Suspense, use, useEffect, useMemo, type ReactNode } from "react";
import { RenderErrorBoundary } from "~/components/RenderErrorBoundary";
import { fnv1a32, resolveDiffThemeName, type DiffThemeName } from "~/lib/diffRendering";
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
  const cacheKey = `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
  const cached = !isStreaming ? highlightedCodeCache.get(cacheKey) : null;
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
    />
  );
}

function UncachedHighlightedCode({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
}: HighlightedCodeProps & { cacheKey: string }) {
  const highlighter = use(getSyntaxHighlighterPromise(language));
  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, language, themeName]);

  useEffect(() => {
    if (!isStreaming) {
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        Math.max(highlightedHtml.length * 2, code.length * 3),
      );
    }
  }, [cacheKey, code, highlightedHtml, isStreaming]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}
