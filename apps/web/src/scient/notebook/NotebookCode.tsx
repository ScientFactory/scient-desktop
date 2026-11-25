import { useGT } from "gt-react";
import { ChevronRight } from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { cn } from "~/lib/utils";
import { hasSpecificPierreIconForFileName, syntheticFileNameForLanguageId } from "~/pierre-icons";
import {
  highlightedCodeSpans,
  type HighlightedCodeSpan,
} from "~/scient/markdownEditor/nodes/codeMirrorCodeEditor";
import { CodeBlockActions } from "~/scient/presentation/CodeBlockActions";

export const notebookCodeCardSurface =
  "group/code-box @container/code-box min-w-0 rounded-lg bg-(--markdown-code-block-background)";

function lineCount(source: string): number {
  const body = source.endsWith("\n") ? source.slice(0, -1) : source;
  return body === "" ? 0 : body.split("\n").length;
}

export function NotebookCodeHeader(props: {
  readonly language: string;
  readonly theme: "light" | "dark";
  readonly wrapped: boolean;
  readonly onWrapChange: (wrapped: boolean) => void;
  readonly readCode: () => string;
  readonly status?: ReactNode;
  /** With a handler, the language label folds and unfolds the code. */
  readonly folded?: boolean;
  readonly onFoldChange?: (folded: boolean) => void;
  readonly children?: ReactNode;
}) {
  const gt = useGT();
  const fileName = syntheticFileNameForLanguageId(props.language);
  const hasIcon = hasSpecificPierreIconForFileName(fileName);
  const folded = props.folded === true;
  const status = folded
    ? gt("{count, plural, one {# line} other {# lines}}", { count: lineCount(props.readCode()) })
    : props.status;
  const label = (
    <>
      {props.onFoldChange === undefined ? null : (
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform rtl:rotate-180",
            !folded &&
              "rotate-90 opacity-0 group-focus-within/code-box:opacity-100 group-hover/code-box:opacity-100 rtl:rotate-90",
          )}
        />
      )}
      {hasIcon ? (
        <PierreEntryIcon
          pathValue={fileName}
          kind="file"
          theme={props.theme}
          className="size-3.5 shrink-0 opacity-85"
        />
      ) : null}
      <span className={cn("truncate", hasIcon && "hidden @[19rem]/code-box:inline")}>
        {props.language}
      </span>
      {status === undefined ? null : <span className="truncate font-sans">{status}</span>}
    </>
  );
  const labelClass =
    "inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground/80";
  return (
    <div
      className={cn(
        "scient-markdown-code-header flex min-h-7 items-center justify-between gap-1.5 pt-1.5 pr-1.5 pl-3 select-none",
        folded ? "pb-1.5" : "pb-0",
      )}
    >
      {props.onFoldChange === undefined ? (
        <span className={labelClass}>{label}</span>
      ) : (
        <button
          type="button"
          aria-expanded={!folded}
          className={cn(
            labelClass,
            "-ml-1.5 rounded-sm px-1.5 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
          )}
          onClick={(event) => {
            event.stopPropagation();
            props.onFoldChange?.(!folded);
          }}
        >
          <span className="sr-only">{folded ? gt("Show code") : gt("Hide code")}</span>
          {label}
        </button>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        {props.children}
        {folded ? null : (
          <CodeBlockActions
            wrapped={props.wrapped}
            onWrapChange={props.onWrapChange}
            readCode={props.readCode}
          />
        )}
      </div>
    </div>
  );
}

interface HighlightedCodeLine {
  readonly number: number;
  readonly startOffset: number;
  readonly spans: ReadonlyArray<HighlightedCodeSpan>;
}

function splitHighlightedLines(
  source: string,
  spans: ReadonlyArray<HighlightedCodeSpan> | null,
): ReadonlyArray<HighlightedCodeLine> {
  const input = spans ?? [{ text: source, className: "" }];
  const lines: Array<{ number: number; startOffset: number; spans: HighlightedCodeSpan[] }> = [
    { number: 1, startOffset: 0, spans: [] },
  ];
  let offset = 0;
  for (const span of input) {
    const parts = span.text.split("\n");
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      if (index > 0) {
        offset += 1;
        lines.push({ number: lines.length + 1, startOffset: offset, spans: [] });
      }
      if (part.length > 0) {
        lines[lines.length - 1]!.spans.push({ text: part, className: span.className });
        offset += part.length;
      }
    }
  }
  return lines;
}

/** Where a click landed in the code, so the editor opens with the caret there. */
function textOffsetAt(root: HTMLElement, x: number, y: number): number | "end" {
  const point = root.ownerDocument.caretRangeFromPoint(x, y);
  if (point === null || !root.contains(point.startContainer)) return "end";
  const anchorElement =
    point.startContainer instanceof Element
      ? point.startContainer
      : point.startContainer.parentElement;
  const lineElement = anchorElement?.closest<HTMLElement>("[data-line-start]");
  if (lineElement !== null && lineElement !== undefined && root.contains(lineElement)) {
    const base = Number(lineElement.dataset.lineStart);
    if (!Number.isNaN(base)) {
      const walker = root.ownerDocument.createTreeWalker(lineElement, NodeFilter.SHOW_TEXT);
      let offset = 0;
      while (walker.nextNode()) {
        if (walker.currentNode === point.startContainer) return base + offset + point.startOffset;
        offset += walker.currentNode.textContent?.length ?? 0;
      }
      return base;
    }
  }
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  while (walker.nextNode()) {
    if (walker.currentNode === point.startContainer) return offset + point.startOffset;
    offset += walker.currentNode.textContent?.length ?? 0;
  }
  return "end";
}

/** A cell's code without an editor. It lays out exactly like one, so opening never moves it. */
export function NotebookCodeSource(props: {
  readonly source: string;
  readonly language: string;
  readonly wrapped: boolean;
  readonly lineNumbers: boolean;
  readonly theme: "light" | "dark";
  readonly near?: boolean;
  readonly onEdit?: (offset: number | "end") => void;
}) {
  const { source, language, wrapped, lineNumbers, theme, near = true, onEdit } = props;
  const [spans, setSpans] = useState<ReadonlyArray<HighlightedCodeSpan> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- colors arrive once the language parser has loaded or theme changes.
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    void highlightedCodeSpans(source, language, theme).then((next) => {
      if (!cancelled) setSpans(next);
    });
    return () => {
      cancelled = true;
    };
  }, [language, near, source, theme]);
  const editable = onEdit !== undefined;
  const editAt = (event: MouseEvent<HTMLPreElement>) => {
    if (event.currentTarget.ownerDocument.getSelection()?.isCollapsed === false) return;
    onEdit?.(textOffsetAt(event.currentTarget, event.clientX, event.clientY));
  };
  if (lineNumbers) {
    const lines = splitHighlightedLines(source, spans);
    return (
      <pre
        className={cn(
          "min-w-0 px-3 pt-1.5 pb-3 font-mono text-[13px] leading-5",
          editable && "cursor-text",
          wrapped
            ? "wrap-anywhere whitespace-break-spaces"
            : "scient-content-scrollbar overflow-x-auto whitespace-pre",
        )}
        onClick={editable ? editAt : undefined}
      >
        <span className={wrapped ? "block" : "block w-max min-w-full"}>
          {lines.map((line) => (
            <span
              key={line.number}
              data-line={line.number}
              data-line-start={line.startOffset}
              className={cn(
                "grid gap-x-2.5 before:content-[attr(data-line)] before:text-right before:font-mono before:text-[11px] before:leading-5 before:text-muted-foreground/65 before:tabular-nums before:select-none",
                wrapped
                  ? "grid-cols-[2rem_minmax(0,1fr)]"
                  : "grid-cols-[2rem_max-content] before:sticky before:left-0 before:bg-(--markdown-code-block-background)",
              )}
            >
              <span className="min-h-5 min-w-0">
                {line.spans.map((span, index) =>
                  span.className === "" ? (
                    span.text
                  ) : (
                    // oxlint-disable-next-line react/no-array-index-key -- spans are the text in order and have no identity.
                    <span key={index} className={span.className}>
                      {span.text}
                    </span>
                  ),
                )}
              </span>
            </span>
          ))}
        </span>
      </pre>
    );
  }
  return (
    <pre
      className={cn(
        "min-w-0 py-[calc(--spacing(1)+4px)] pr-[calc(--spacing(1)+2px)] pl-[calc(--spacing(1)+6px)] font-mono text-[13px] leading-[1.4] wrap-anywhere whitespace-break-spaces",
        editable && "cursor-text",
      )}
      onClick={editable ? editAt : undefined}
    >
      {spans === null
        ? source
        : spans.map((span, index) =>
            span.className === "" ? (
              span.text
            ) : (
              // oxlint-disable-next-line react/no-array-index-key -- spans are the text in order and have no identity.
              <span key={index} className={span.className}>
                {span.text}
              </span>
            ),
          )}
      {source === "" || source.endsWith("\n") ? "\n" : null}
    </pre>
  );
}
