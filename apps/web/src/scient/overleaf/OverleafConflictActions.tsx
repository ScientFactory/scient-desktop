// SCIENT-OWNED: Scient's Overleaf conflict marks in the Source view. Each block
// is highlighted, with Use mine, Use Overleaf's and Keep both above it. A
// choice edits the text through the editor, so it is undoable and saved like
// any edit.
import type { Editor } from "@pierre/diffs/edit";
import { useEffect, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import {
  overleafConflictBlocks,
  resolvedConflictLines,
  type OverleafConflictBlock,
  type OverleafConflictResolution,
} from "./overleafModel";

interface BlockLayout {
  readonly startLine: number;
  readonly endLine: number;
  /** Relative to the surface. */
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  /** The `<<<<<<< Scient` row is on screen, so the actions can sit on it. */
  readonly startVisible: boolean;
}

const ACTIONS: ReadonlyArray<{
  readonly resolution: OverleafConflictResolution;
  readonly label: string;
}> = [
  { resolution: "mine", label: "Use mine" },
  { resolution: "theirs", label: "Use Overleaf's" },
  { resolution: "both", label: "Keep both" },
];

/** Every shadow root under `root`, where the editor draws its rows. */
function shadowRoots(root: Element): ShadowRoot[] {
  const found: ShadowRoot[] = [];
  const queue: Array<Element | ShadowRoot> = [root];
  for (let index = 0; index < queue.length; index++) {
    for (const element of queue[index]!.querySelectorAll("*")) {
      if (element.shadowRoot) {
        found.push(element.shadowRoot);
        queue.push(element.shadowRoot);
      }
    }
  }
  return found;
}

/** The rendered rows by one-based line number. Rows off screen aren't rendered. */
function renderedRows(roots: ReadonlyArray<ShadowRoot | Element>) {
  const rows = new Map<number, HTMLElement>();
  for (const root of roots)
    for (const row of root.querySelectorAll<HTMLElement>("[data-content] > [data-line]")) {
      const line = Number(row.dataset.line);
      if (Number.isInteger(line)) rows.set(line, row);
    }
  return rows;
}

function measure(
  surface: HTMLElement,
  scroller: Element,
  blocks: ReadonlyArray<OverleafConflictBlock>,
): ReadonlyArray<BlockLayout> {
  const rows = renderedRows([scroller, ...shadowRoots(scroller)]);
  const origin = surface.getBoundingClientRect();
  const bounds = scroller.getBoundingClientRect();
  const layouts: BlockLayout[] = [];
  for (const block of blocks) {
    let top = Infinity;
    let bottom = -Infinity;
    let left = Infinity;
    let right = -Infinity;
    for (let line = block.startLine + 1; line <= block.endLine + 1; line++) {
      const rect = rows.get(line)?.getBoundingClientRect();
      if (!rect || rect.height === 0) continue;
      top = Math.min(top, rect.top);
      bottom = Math.max(bottom, rect.bottom);
      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    }
    // Clipped to the scrolling area, so nothing draws over the toolbar above it.
    top = Math.max(top, bounds.top);
    bottom = Math.min(bottom, bounds.bottom);
    if (!(bottom > top)) continue;
    const start = rows.get(block.startLine + 1)?.getBoundingClientRect();
    layouts.push({
      startLine: block.startLine,
      endLine: block.endLine,
      top: top - origin.top,
      left: Math.max(left, bounds.left) - origin.left,
      width: Math.min(right, bounds.right) - Math.max(left, bounds.left),
      height: bottom - top,
      startVisible: start !== undefined && start.top >= bounds.top && start.bottom <= bounds.bottom,
    });
  }
  return layouts;
}

const sameLayouts = (left: ReadonlyArray<BlockLayout>, right: ReadonlyArray<BlockLayout>) =>
  left.length === right.length &&
  left.every((entry, index) => {
    const other = right[index]!;
    return (
      entry.startLine === other.startLine &&
      entry.endLine === other.endLine &&
      Math.abs(entry.top - other.top) < 0.5 &&
      Math.abs(entry.left - other.left) < 0.5 &&
      Math.abs(entry.width - other.width) < 0.5 &&
      Math.abs(entry.height - other.height) < 0.5 &&
      entry.startVisible === other.startVisible
    );
  });

/** Replaces one block, found again in the editor's current text, with the lines kept. */
function resolveBlock<Annotation>(
  editor: Editor<"file", Annotation, undefined>,
  target: Pick<OverleafConflictBlock, "startLine" | "endLine">,
  resolution: OverleafConflictResolution,
): boolean {
  const text = editor.getText();
  const block = overleafConflictBlocks(text).find(
    (candidate) => candidate.startLine === target.startLine && candidate.endLine === target.endLine,
  );
  if (!block) return false;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  const kept = resolvedConflictLines(block, resolution);
  const hasNext = block.endLine + 1 < lines.length;
  editor.applyEdits([
    {
      range: {
        start: { line: block.startLine, character: 0 },
        end: hasNext
          ? { line: block.endLine + 1, character: 0 }
          : { line: block.endLine, character: lines[block.endLine]!.length },
      },
      newText: kept.length === 0 ? "" : `${kept.join(eol)}${hasNext ? eol : ""}`,
    },
  ]);
  return true;
}

export function OverleafConflictActions<Annotation>(props: {
  readonly editor: Editor<"file", Annotation, undefined> | null;
  /** The editor's surface: positioned, holding the scrolling rows. */
  readonly surface: HTMLElement | null;
  /** The editor's current text. */
  readonly source: string;
  readonly disabled: boolean;
}) {
  const { editor, surface, source, disabled } = props;
  const blocks = overleafConflictBlocks(source);
  const [layout, setLayout] = useState<{
    readonly source: string;
    readonly blocks: ReadonlyArray<BlockLayout>;
  } | null>(null);
  const hasBlocks = blocks.length > 0;

  useEffect(() => {
    if (!surface || !hasBlocks) return;
    const scroller = surface.querySelector(".file-preview-virtualizer") ?? surface;
    let frame: number | null = null;
    const observed = new Set<Node>();
    const mutations = new MutationObserver(() => schedule());
    const observe = () => {
      for (const root of [scroller, ...shadowRoots(scroller)]) {
        if (observed.has(root)) continue;
        observed.add(root);
        mutations.observe(root, { childList: true, subtree: true });
      }
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        observe();
        const next = measure(surface, scroller, overleafConflictBlocks(source));
        setLayout((current) =>
          current?.source === source && sameLayouts(current.blocks, next)
            ? current
            : { source, blocks: next },
        );
      });
    };
    const stopResize = observeResize(scroller, () => schedule());
    // Scroll doesn't bubble; the capture phase sees the scroller's.
    surface.addEventListener("scroll", schedule, { capture: true, passive: true });
    schedule();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      mutations.disconnect();
      stopResize();
      surface.removeEventListener("scroll", schedule, { capture: true });
    };
  }, [surface, source, hasBlocks]);

  if (!hasBlocks || layout?.source !== source) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
      data-overleaf-conflicts={blocks.length}
    >
      {layout.blocks.map((block) => (
        <div key={`${block.startLine}:${block.endLine}`}>
          <div
            aria-hidden
            className="absolute rounded-sm border-s-2 border-warning/70 bg-warning/8"
            style={{ top: block.top, left: block.left, width: block.width, height: block.height }}
          />
          {block.startVisible ? (
            <div
              role="group"
              aria-label={`Overleaf conflict at line ${block.startLine + 1}`}
              className="pointer-events-auto absolute flex items-center gap-0.5 rounded-md border border-border/70 bg-popover px-0.5 shadow-xs"
              style={{ top: block.top + 1, right: 12 }}
            >
              {ACTIONS.map((action) => (
                <button
                  key={action.resolution}
                  type="button"
                  disabled={disabled || !editor}
                  className={cn(
                    "h-5 cursor-pointer rounded px-1.5 text-2xs text-muted-foreground transition-colors duration-75",
                    "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    "disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent",
                  )}
                  // Keep the editor's caret and selection where they are.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (editor && !disabled) resolveBlock(editor, block, action.resolution);
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
