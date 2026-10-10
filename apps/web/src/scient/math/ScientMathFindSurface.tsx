import { use, useCallback, useMemo, useState, type ReactNode } from "react";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import { MarkdownFindContext, useFindRevealRef } from "~/components/chat/markdownFindContext";

/** Mounted only during Find, so closing it resets transient reveal state by unmounting. */
function ScientMathFindSource({ sourceText }: { readonly sourceText: string }) {
  const [sourceVisible, setSourceVisible] = useState(false);
  const revealSource = useCallback(() => setSourceVisible(true), []);
  const sourceRef = useFindRevealRef(revealSource);
  const segments = useMemo(() => {
    const occurrences = new Map<string, number>();
    return (
      searchableMessageSegments({ role: "assistant", text: sourceText, streaming: false }) ?? []
    ).map((text) => {
      const occurrence = occurrences.get(text) ?? 0;
      occurrences.set(text, occurrence + 1);
      return { text, key: JSON.stringify([text, occurrence]) };
    });
  }, [sourceText]);

  return (
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
        <span key={segment.key}>
          {index > 0 ? <br /> : null}
          {segment.text}
        </span>
      ))}
    </span>
  );
}

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
      {searching ? <ScientMathFindSource key={sourceText} sourceText={sourceText} /> : null}
    </span>
  );
}
