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

import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { cn } from "~/lib/utils";

import { scientMarkdownShortcut } from "../shortcuts";
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
  closeFind(): void;
  setFindOpen(open: boolean): void;
}

const findIconClassName = "size-3.5";
const findInputClassName =
  "h-7 has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-0";

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
    controller.closeFind();
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
      onKeyDown={(event) => {
        if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <div className="flex items-center gap-1">
        {snapshot.editable ? (
          <DockButton
            label={replaceOpen ? "Hide replace" : "Show replace"}
            icon={
              <ChevronRight
                className={cn(
                  findIconClassName,
                  "transition-transform",
                  replaceOpen && "rotate-90",
                )}
              />
            }
            onClick={() => setReplaceOpen((open) => !open)}
          />
        ) : null}

        <InputGroup variant="ghost" className={cn("min-w-36 max-w-64 flex-1", findInputClassName)}>
          <InputGroupInput
            ref={inputRef}
            size="sm"
            aria-label="Find text"
            placeholder="Find"
            type="search"
            value={snapshot.findQuery}
            onChange={(event) => configure({ query: event.target.value })}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
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
            <InputGroupAddon align="inline-end" className="pe-2">
              <span
                aria-live="polite"
                className={cn(
                  "pointer-events-none text-[10px] whitespace-nowrap",
                  noMatches ? "text-destructive" : "font-mono text-muted-foreground",
                )}
              >
                {countLabel}
              </span>
            </InputGroupAddon>
          ) : null}
        </InputGroup>

        <DockButton
          label="Match case"
          icon={<CaseSensitive className={findIconClassName} />}
          active={snapshot.findCaseSensitive}
          onClick={() => configure({ caseSensitive: !snapshot.findCaseSensitive })}
        />
        <DockButton
          label="Match whole word"
          icon={<WholeWord className={findIconClassName} />}
          active={snapshot.findWholeWord}
          onClick={() => configure({ wholeWord: !snapshot.findWholeWord })}
        />
        <DockButton
          label="Previous match"
          icon={<ChevronUp className={findIconClassName} />}
          disabled={snapshot.findMatchCount === 0}
          shortcut={scientMarkdownShortcut("findPrevious")}
          onClick={() => controller.navigateFind(-1)}
        />
        <DockButton
          label="Next match"
          icon={<ChevronDown className={findIconClassName} />}
          disabled={snapshot.findMatchCount === 0}
          shortcut={scientMarkdownShortcut("findNext")}
          onClick={() => controller.navigateFind(1)}
        />
        <div className="ms-auto">
          <DockButton
            label="Close"
            icon={<X className={findIconClassName} />}
            shortcut={scientMarkdownShortcut("close")}
            onClick={close}
          />
        </div>
      </div>

      {snapshot.editable && replaceOpen ? (
        <div className="flex items-center gap-1 ps-8">
          <InputGroup
            variant="ghost"
            className={cn("min-w-36 max-w-64 flex-1", findInputClassName)}
          >
            <InputGroupInput
              size="sm"
              aria-label="Replacement text"
              placeholder="Replace"
              type="text"
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  controller.replaceFind(replacement, false);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  close();
                }
              }}
            />
          </InputGroup>
          <DockButton
            label="Replace current match"
            icon={<Replace className={findIconClassName} />}
            disabled={snapshot.findMatchCount === 0}
            shortcut={scientMarkdownShortcut("replaceCurrent")}
            onClick={() => controller.replaceFind(replacement, false)}
          />
          <DockButton
            label="Replace all matches"
            icon={<ReplaceAll className={findIconClassName} />}
            disabled={snapshot.findMatchCount === 0}
            onClick={() => controller.replaceFind(replacement, true)}
          />
        </div>
      ) : null}
    </div>
  );
}
