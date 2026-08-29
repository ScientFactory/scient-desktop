import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Replace,
  ReplaceAll,
  WholeWord,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

import { DockButton } from "./dockChrome";

/** The find-state slice a surface must publish for the shared find bar. */
export interface ScientFindBarState {
  readonly editable: boolean;
  readonly findActiveIndex: number;
  readonly findCaseSensitive: boolean;
  readonly findFocusRequest: number;
  readonly findMatchCount: number;
  readonly findOpen: boolean;
  readonly findQuery: string;
  readonly findWholeWord: boolean;
}

/** The find actions a surface must implement for the shared find bar. */
export interface ScientFindBarController {
  readonly view: { focus(): void } | null;
  configureFind(input: {
    readonly query: string;
    readonly caseSensitive: boolean;
    readonly wholeWord: boolean;
  }): void;
  navigateFind(direction: -1 | 1): void;
  replaceFind(replacement: string, all: boolean): boolean;
  setFindOpen(open: boolean): void;
}

/**
 * Compact find & replace strip under the dock. One row while searching;
 * expanding the replace chevron reveals a second slim row aligned under the
 * find field. All controls are dock-sized so the bar reads as one chrome
 * family with the editing dock above it.
 */
export function ScientFindBar({
  controller,
  snapshot,
}: {
  readonly controller: ScientFindBarController;
  readonly snapshot: ScientFindBarState;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");

  useEffect(() => {
    if (snapshot.findOpen) inputRef.current?.focus();
  }, [snapshot.findFocusRequest, snapshot.findOpen]);

  const configure = (input: {
    readonly query?: string;
    readonly caseSensitive?: boolean;
    readonly wholeWord?: boolean;
  }) => {
    controller.configureFind({
      query: input.query ?? snapshot.findQuery,
      caseSensitive: input.caseSensitive ?? snapshot.findCaseSensitive,
      wholeWord: input.wholeWord ?? snapshot.findWholeWord,
    });
  };

  const close = () => {
    controller.setFindOpen(false);
    controller.view?.focus();
  };

  const noMatches = snapshot.findQuery !== "" && snapshot.findMatchCount === 0;
  const countLabel =
    snapshot.findQuery === ""
      ? null
      : noMatches
        ? "No results"
        : `${snapshot.findActiveIndex + 1} of ${snapshot.findMatchCount}`;

  return (
    <div
      className="scient-markdown-find-bar flex flex-col gap-1 border-b border-border/80 bg-background/95 px-2 py-1 backdrop-blur-xs"
      role="search"
      aria-label="Find and replace"
    >
      <div className="flex items-center gap-1">
        {snapshot.editable ? (
          <DockButton
            label={replaceOpen ? "Hide replace" : "Show replace"}
            icon={
              <ChevronRight
                className={cn("size-4 transition-transform", replaceOpen && "rotate-90")}
              />
            }
            onClick={() => setReplaceOpen((open) => !open)}
          />
        ) : null}

        <div className="relative min-w-36 max-w-64 flex-1">
          <Input
            ref={inputRef}
            size="compact"
            aria-label="Find text"
            className={cn(countLabel !== null && "pe-16")}
            placeholder="Find"
            type="search"
            value={snapshot.findQuery}
            onChange={(event) => configure({ query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                controller.navigateFind(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
          />
          {countLabel !== null ? (
            <span
              aria-live="polite"
              className={cn(
                "pointer-events-none absolute end-2 top-1/2 -translate-y-1/2 text-[10px] whitespace-nowrap",
                noMatches ? "text-destructive" : "font-mono text-muted-foreground",
              )}
            >
              {countLabel}
            </span>
          ) : null}
        </div>

        <DockButton
          label="Match case"
          icon={<CaseSensitive className="size-4" />}
          active={snapshot.findCaseSensitive}
          onClick={() => configure({ caseSensitive: !snapshot.findCaseSensitive })}
        />
        <DockButton
          label="Match whole word"
          icon={<WholeWord className="size-4" />}
          active={snapshot.findWholeWord}
          onClick={() => configure({ wholeWord: !snapshot.findWholeWord })}
        />
        <DockButton
          label="Previous match (Shift+Enter)"
          icon={<ChevronUp className="size-4" />}
          disabled={snapshot.findMatchCount === 0}
          onClick={() => controller.navigateFind(-1)}
        />
        <DockButton
          label="Next match (Enter)"
          icon={<ChevronDown className="size-4" />}
          disabled={snapshot.findMatchCount === 0}
          onClick={() => controller.navigateFind(1)}
        />
        <div className="ms-auto">
          <DockButton label="Close (Esc)" icon={<X className="size-4" />} onClick={close} />
        </div>
      </div>

      {snapshot.editable && replaceOpen ? (
        <div className="flex items-center gap-1 ps-8">
          <div className="min-w-36 max-w-64 flex-1">
            <Input
              size="compact"
              aria-label="Replacement text"
              placeholder="Replace"
              type="text"
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  controller.replaceFind(replacement, false);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  close();
                }
              }}
            />
          </div>
          <DockButton
            label="Replace current match (Enter)"
            icon={<Replace className="size-4" />}
            disabled={snapshot.findMatchCount === 0}
            onClick={() => controller.replaceFind(replacement, false)}
          />
          <DockButton
            label="Replace all matches"
            icon={<ReplaceAll className="size-4" />}
            disabled={snapshot.findMatchCount === 0}
            onClick={() => controller.replaceFind(replacement, true)}
          />
        </div>
      ) : null}
    </div>
  );
}
