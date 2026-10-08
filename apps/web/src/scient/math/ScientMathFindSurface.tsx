import { use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import { MarkdownFindContext, useFindRevealRef } from "~/components/chat/markdownFindContext";

/** Keep formula rendering stable; Find searches one source representation, not KaTeX internals. */
export function ScientMathFindSurface({
  sourceText,
  children,
}: {
  readonly sourceText: string;
  readonly children: ReactNode;
}) {
  const searching = use(MarkdownFindContext);
  const [sourceVisible, setSourceVisible] = useState(false);
  const revealSource = useCallback(() => setSourceVisible(true), []);
  const sourceRef = useFindRevealRef(revealSource);
  const segments = useMemo(
    () =>
      searching
        ? (searchableMessageSegments({ role: "assistant", text: sourceText, streaming: false }) ??
          [])
        : [],
    [searching, sourceText],
  );
  useEffect(() => {
    if (!searching) setSourceVisible(false);
  }, [searching]);

  return (
    <span className="contents" data-thread-find-canonical={searching ? "true" : undefined}>
      {children}
      {searching ? (
        <span
          data-thread-find-canonical-source
          aria-hidden="true"
          data-markdown-copy=""
          ref={sourceRef}
          hidden={!sourceVisible}
          dir="ltr"
          className="font-mono text-xs text-muted-foreground"
        >
          {segments.map((segment, index) => (
            <span key={index}>
              {index > 0 ? <br /> : null}
              {segment}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
