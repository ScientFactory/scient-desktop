import { lazy, Suspense, use, type ReactNode } from "react";
import { MarkdownFindContext } from "~/components/chat/markdownFindContext";

// Find's source segmentation parses Markdown as the shared index does (remark), which loads only
// once Find opens, off the chat render path.
const ScientMathFindSource = lazy(() =>
  import("./ScientMathFindSource").then((module) => ({ default: module.ScientMathFindSource })),
);

/** Keep formula rendering stable; Find searches one source representation, not KaTeX internals. */
export function ScientMathFindSurface({
  sourceText,
  children,
}: {
  readonly sourceText: string;
  readonly children: ReactNode;
}) {
  const searching = use(MarkdownFindContext);
  return (
    <span className="contents" data-thread-find-canonical={searching ? "true" : undefined}>
      {children}
      {searching ? (
        <Suspense fallback={null}>
          <ScientMathFindSource key={sourceText} sourceText={sourceText} />
        </Suspense>
      ) : null}
    </span>
  );
}
