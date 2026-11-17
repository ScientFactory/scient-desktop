/** A request names at most this many sources; a longer list makes a table no one can check. */
export const COMPARE_SOURCES_LIMIT = 12;

const LEAD = "Compare these sources from my Library with the compare-sources skill:";
const QUESTION = "Question: ";

export interface ComparedSource {
  readonly sourceId: string;
  readonly title: string | null;
  readonly citationKey?: string | undefined;
}

export type CompareSourcesInsertion =
  /** Put `text` before the draft; the caret then follows `Question: `. */
  | { readonly kind: "insert"; readonly text: string; readonly listed: number }
  /** The draft already starts with this request. */
  | { readonly kind: "present" }
  /** The draft starts with a request to compare other sources. */
  | { readonly kind: "other-request" };

function compareSourcesRequest(sources: ReadonlyArray<ComparedSource>): string {
  const listed = sources.slice(0, COMPARE_SOURCES_LIMIT).map((source) => {
    const title = source.title?.replace(/\s+/gu, " ").trim() || "Untitled source";
    return `${title} (${source.citationKey ?? source.sourceId})`;
  });
  const left =
    sources.length > listed.length
      ? ` I selected ${sources.length}; these are the first ${listed.length}.`
      : "";
  return `${LEAD} ${listed.join("; ")}.${left} ${QUESTION}`;
}

/** What Compare puts in the chat draft for these selected sources, in their order. */
export function compareSourcesInsertion(
  prompt: string,
  sources: ReadonlyArray<ComparedSource>,
): CompareSourcesInsertion {
  const text = compareSourcesRequest(sources);
  const draft = prompt.trimStart();
  if (draft.startsWith(text.trimEnd())) return { kind: "present" };
  if (draft.startsWith(LEAD)) return { kind: "other-request" };
  return { kind: "insert", text, listed: Math.min(sources.length, COMPARE_SOURCES_LIMIT) };
}
