import { ChevronDown, ChevronRight, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

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

  return (
    <div
      className="scient-markdown-find-bar flex flex-col gap-1.5 border-b border-border/80 bg-background/95 px-2 py-1.5 backdrop-blur-xs"
      role="search"
      aria-label="Find and replace"
    >
      <div className="scient-markdown-find-row flex items-center gap-1">
        {snapshot.editable ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label={replaceOpen ? "Hide replace" : "Show replace"}
                  aria-expanded={replaceOpen}
                  onClick={() => setReplaceOpen((open) => !open)}
                >
                  <ChevronRight
                    className={cn("size-3.5 transition-transform", replaceOpen && "rotate-90")}
                  />
                </button>
              }
            />
            <TooltipPopup>Toggle replace</TooltipPopup>
          </Tooltip>
        ) : null}

        <div className="relative flex min-w-44 max-w-96 flex-1 items-center">
          <Input
            ref={inputRef}
            aria-label="Find text"
            className="h-7 pe-14 text-xs"
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
                controller.setFindOpen(false);
                controller.view?.focus();
              }
            }}
          />
          <span
            aria-live="polite"
            className="scient-markdown-find-count pointer-events-none absolute end-2.5 text-[10px] text-muted-foreground font-mono"
          >
            {snapshot.findMatchCount === 0
              ? "0"
              : `${snapshot.findActiveIndex + 1}/${snapshot.findMatchCount}`}
          </span>
        </div>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={cn(
                  "inline-flex h-7 items-center rounded-md px-1.5 text-xs font-mono transition-colors hover:bg-accent",
                  snapshot.findCaseSensitive && "bg-accent font-bold text-foreground",
                )}
                aria-label="Match case"
                aria-pressed={snapshot.findCaseSensitive}
                onClick={() => configure({ caseSensitive: !snapshot.findCaseSensitive })}
              >
                Aa
              </button>
            }
          />
          <TooltipPopup>Match Case</TooltipPopup>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={cn(
                  "inline-flex h-7 items-center rounded-md px-1.5 text-xs font-mono transition-colors hover:bg-accent",
                  snapshot.findWholeWord && "bg-accent font-bold text-foreground",
                )}
                aria-label="Match whole word"
                aria-pressed={snapshot.findWholeWord}
                onClick={() => configure({ wholeWord: !snapshot.findWholeWord })}
              >
                "W"
              </button>
            }
          />
          <TooltipPopup>Match Whole Word</TooltipPopup>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-md text-foreground/80 hover:bg-accent disabled:opacity-35"
                aria-label="Previous match"
                disabled={snapshot.findMatchCount === 0}
                onClick={() => controller.navigateFind(-1)}
              >
                <ChevronUp className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup>Previous (Shift+Enter)</TooltipPopup>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-md text-foreground/80 hover:bg-accent disabled:opacity-35"
                aria-label="Next match"
                disabled={snapshot.findMatchCount === 0}
                onClick={() => controller.navigateFind(1)}
              >
                <ChevronDown className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup>Next (Enter)</TooltipPopup>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Close find"
                onClick={() => controller.setFindOpen(false)}
              >
                <X className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup>Close (Esc)</TooltipPopup>
        </Tooltip>
      </div>

      {snapshot.editable && replaceOpen ? (
        <div className="scient-markdown-find-row flex items-center gap-1 ps-7">
          <Input
            aria-label="Replacement text"
            className="h-7 max-w-96 flex-1 text-xs"
            placeholder="Replace with..."
            type="text"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                controller.replaceFind(replacement, false);
              }
            }}
          />
          <Button
            className="h-7 text-xs"
            disabled={snapshot.findMatchCount === 0}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => controller.replaceFind(replacement, false)}
          >
            Replace
          </Button>
          <Button
            className="h-7 text-xs"
            disabled={snapshot.findMatchCount === 0}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => controller.replaceFind(replacement, true)}
          >
            All
          </Button>
        </div>
      ) : null}
    </div>
  );
}
