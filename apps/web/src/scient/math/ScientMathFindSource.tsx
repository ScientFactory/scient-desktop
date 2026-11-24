import { useState } from "react";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import { findRevealRef } from "~/components/chat/markdownFindContext";

/** Mounted only during Find, so closing it resets transient reveal state by unmounting. */
export function ScientMathFindSource({ sourceText }: { readonly sourceText: string }) {
  const [sourceVisible, setSourceVisible] = useState(false);
  const sourceRef = findRevealRef(() => setSourceVisible(true));
  const occurrences = new Map<string, number>();
  const segments = (
    searchableMessageSegments({ role: "assistant", text: sourceText, streaming: false }) ?? []
  ).map((text) => {
    const occurrence = occurrences.get(text) ?? 0;
    occurrences.set(text, occurrence + 1);
    return { text, key: JSON.stringify([text, occurrence]) };
  });

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
