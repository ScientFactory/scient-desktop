import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { SearchIcon } from "lucide-react";
import { type ReactNode, type RefObject, useRef, useState } from "react";

import { PreviewFaviconIcon } from "~/components/preview/PreviewFaviconIcon";
import {
  Autocomplete,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "~/components/ui/autocomplete";

import type { BrowserSuggestion } from "./suggestionList";
import { useBrowserSuggestions } from "./useBrowserSuggestions";

/** The search box's own input, so the list below can follow it. */
export const BrowserSuggestionInput = AutocompletePrimitive.Input;

/**
 * A search box's suggestions. It keeps the box's own Enter unless a suggestion is highlighted, and
 * `onPick` gets an address or a search, as if typed. `active` is false until someone types.
 */
export function BrowserSuggestions({
  threadRef,
  profileId,
  text,
  active,
  anchor,
  onTextChange,
  onPick,
  children,
}: {
  threadRef: ScopedThreadRef;
  profileId: string;
  text: string;
  active: boolean;
  anchor: RefObject<HTMLElement | null>;
  onTextChange: (text: string) => void;
  onPick: (value: string) => void;
  children: ReactNode;
}) {
  const items = useBrowserSuggestions({
    environmentId: threadRef.environmentId,
    profileId,
    text,
    active,
  });
  const [wantsOpen, setWantsOpen] = useState(false);
  const highlighted = useRef<BrowserSuggestion | undefined>(undefined);
  const open = active && wantsOpen && items.length > 0;

  const pick = (item: BrowserSuggestion) => {
    setWantsOpen(false);
    onPick(item.value);
  };

  return (
    <div
      className="contents"
      onKeyDownCapture={(event) => {
        if (event.key !== "Enter" || !open || !highlighted.current) return;
        event.preventDefault();
        event.stopPropagation();
        pick(highlighted.current);
      }}
    >
      <Autocomplete
        items={items}
        open={open}
        onOpenChange={setWantsOpen}
        value={text}
        onValueChange={(next, details) => {
          if (details.reason === "input-change") onTextChange(next);
        }}
        filter={null}
        itemToStringValue={(item: BrowserSuggestion) => item.value}
        openOnInputClick={false}
        onItemHighlighted={(item) => {
          highlighted.current = item;
        }}
      >
        {children}
        <AutocompletePopup anchor={anchor}>
          <AutocompleteList>
            {(item: BrowserSuggestion) => (
              <AutocompleteItem key={item.value} value={item} onClick={() => pick(item)}>
                <span className="flex min-w-0 items-center gap-2">
                  {item.kind === "page" ? (
                    <PreviewFaviconIcon threadRef={threadRef} url={item.value} className="size-4" />
                  ) : (
                    <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">
                    {item.kind === "page" ? item.title || item.value : item.value}
                  </span>
                  {item.kind === "page" && item.title ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {new URL(item.value).host}
                    </span>
                  ) : null}
                </span>
              </AutocompleteItem>
            )}
          </AutocompleteList>
        </AutocompletePopup>
      </Autocomplete>
    </div>
  );
}
