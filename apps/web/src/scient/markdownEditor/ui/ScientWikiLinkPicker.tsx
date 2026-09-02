import { Brackets, FileText, Search, Unlink } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import type { ScientMarkdownEditorView } from "../prosemirror/view";
import {
  buildWikiLinkPickerSections,
  type ScientMarkdownWikiLinkCandidate,
  wikiLinkCandidateName,
  wikiLinkTargetForSelection,
} from "../wikiLinkPicker";
import { dockButtonClass } from "./dockChrome";

interface ScientWikiLinkPickerProps {
  readonly candidates: ReadonlyArray<ScientMarkdownWikiLinkCandidate>;
  readonly controller: ScientMarkdownEditorView;
  readonly disabled: boolean;
  readonly onLinked: (path: string) => void;
  readonly openRequest: number;
  readonly recentPaths: ReadonlyArray<string>;
  readonly selectedTarget: string | null;
}

function editQueryForTarget(
  target: string,
  candidates: ReadonlyArray<ScientMarkdownWikiLinkCandidate>,
): string {
  const withoutHeading = target.split("#", 1)[0]?.trim() ?? "";
  const candidate = candidates.find(
    (item) => item.target === target || item.target === withoutHeading,
  );
  return candidate ? wikiLinkCandidateName(candidate) : withoutHeading;
}

function WikiLinkOption(props: {
  readonly active: boolean;
  readonly candidate: ScientMarkdownWikiLinkCandidate;
  readonly id: string;
  readonly onActivate: () => void;
  readonly onChoose: () => void;
}) {
  return (
    <button
      id={props.id}
      type="button"
      role="option"
      aria-selected={props.active}
      className={cn(
        "flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-start outline-none",
        props.active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
      )}
      onClick={props.onChoose}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={props.onActivate}
    >
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {wikiLinkCandidateName(props.candidate)}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {props.candidate.path}
        </span>
      </span>
    </button>
  );
}

/** Choose a real Markdown target before replacing the current text selection. */
export function ScientWikiLinkPicker(props: ScientWikiLinkPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [editingTarget, setEditingTarget] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const sections = useMemo(
    () =>
      buildWikiLinkPickerSections({
        candidates: props.candidates,
        query,
        recentPaths: props.recentPaths,
      }),
    [props.candidates, props.recentPaths, query],
  );
  const visibleCandidates = useMemo(
    () => [...sections.recent, ...sections.results],
    [sections.recent, sections.results],
  );
  const safeActiveIndex = Math.min(activeIndex, Math.max(0, visibleCandidates.length - 1));

  useEffect(() => {
    if (!open) return;
    const timeout = window.setTimeout(() => {
      inputRef.current?.focus();
      if (editingTarget !== null) inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [editingTarget, open]);

  useEffect(() => {
    if (props.openRequest === 0) return;
    if (!props.disabled && props.selectedTarget !== null) {
      setEditingTarget(props.selectedTarget);
      setQuery(editQueryForTarget(props.selectedTarget, props.candidates));
      setActiveIndex(0);
      setOpen(true);
    }
    props.controller.acknowledgeWikiLinkEditRequest(props.openRequest);
  }, [props.candidates, props.controller, props.disabled, props.openRequest, props.selectedTarget]);

  useEffect(() => {
    if (!props.disabled || !open) return;
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    setEditingTarget(null);
  }, [open, props.disabled]);

  const changeOpen = (nextOpen: boolean) => {
    if (nextOpen && props.disabled) return;
    if (nextOpen) {
      setEditingTarget(props.selectedTarget);
      setQuery(
        props.selectedTarget === null
          ? ""
          : editQueryForTarget(props.selectedTarget, props.candidates),
      );
      setActiveIndex(0);
    }
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
      setActiveIndex(0);
      setEditingTarget(null);
    }
  };

  const choose = (candidate: ScientMarkdownWikiLinkCandidate) => {
    if (props.disabled) return;
    const target = wikiLinkTargetForSelection(candidate.target, editingTarget);
    if (target !== editingTarget && !props.controller.setWikiLink(target)) return;
    props.onLinked(candidate.path);
    changeOpen(false);
  };

  const remove = () => {
    if (editingTarget === null || !props.controller.removeWikiLink()) return;
    changeOpen(false);
  };

  const renderOptions = (
    candidates: ReadonlyArray<ScientMarkdownWikiLinkCandidate>,
    offset: number,
  ) =>
    candidates.map((candidate, index) => {
      const absoluteIndex = offset + index;
      return (
        <WikiLinkOption
          key={candidate.path}
          id={`${listId}-option-${absoluteIndex}`}
          candidate={candidate}
          active={absoluteIndex === safeActiveIndex}
          onActivate={() => setActiveIndex(absoluteIndex)}
          onChoose={() => choose(candidate)}
        />
      );
    });

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  className={dockButtonClass(false)}
                  aria-label="Link selection to a Markdown file"
                  disabled={props.disabled}
                >
                  <Brackets className="size-4" />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="top">Wiki link</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        align="center"
        className="w-80 max-w-[calc(100vw-1rem)]"
        side="bottom"
        viewportClassName="p-2"
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <PopoverTitle className="text-xs font-medium">
              {editingTarget === null ? "Link to Markdown" : "Edit wiki link"}
            </PopoverTitle>
            <span className="text-[10px] text-muted-foreground">Enter to select</span>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute start-2 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              aria-autocomplete="list"
              aria-activedescendant={
                visibleCandidates.length > 0 ? `${listId}-option-${safeActiveIndex}` : undefined
              }
              aria-controls={listId}
              aria-expanded={open}
              aria-label="Search Markdown files"
              className="[&_[data-slot=input]]:ps-7"
              placeholder="Search Markdown files…"
              role="combobox"
              size="compact"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  changeOpen(false);
                  return;
                }
                if (visibleCandidates.length === 0) return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  setActiveIndex(
                    (safeActiveIndex + direction + visibleCandidates.length) %
                      visibleCandidates.length,
                  );
                  return;
                }
                if (event.key === "Home" || event.key === "End") {
                  event.preventDefault();
                  setActiveIndex(event.key === "Home" ? 0 : visibleCandidates.length - 1);
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  const candidate = visibleCandidates[safeActiveIndex];
                  if (candidate) choose(candidate);
                }
              }}
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label="Markdown files"
            className="max-h-72 overflow-y-auto rounded-md"
          >
            {visibleCandidates.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {query.trim() ? "No matching Markdown files." : "No other Markdown files."}
              </div>
            ) : (
              <>
                {sections.recent.length > 0 ? (
                  <div role="group" aria-label="Recently linked">
                    <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      Recently linked
                    </div>
                    {renderOptions(sections.recent, 0)}
                  </div>
                ) : null}
                {sections.results.length > 0 ? (
                  <div
                    role="group"
                    aria-label={query.trim() ? "Search results" : "Markdown files"}
                    className={sections.recent.length > 0 ? "mt-1 border-t border-border pt-1" : ""}
                  >
                    {!query.trim() && sections.recent.length > 0 ? (
                      <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Markdown files
                      </div>
                    ) : null}
                    {renderOptions(sections.results, sections.recent.length)}
                  </div>
                ) : null}
              </>
            )}
          </div>
          {editingTarget !== null ? (
            <div className="border-t border-border pt-1">
              <Button
                className="text-muted-foreground hover:text-destructive"
                size="xs"
                type="button"
                variant="ghost"
                onMouseDown={(event) => event.preventDefault()}
                onClick={remove}
              >
                <Unlink className="size-3.5" />
                Remove link
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
