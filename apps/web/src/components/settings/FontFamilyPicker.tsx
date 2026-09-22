import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isMonospaceFamily, queryInstalledFontFamilies } from "../../appearanceFonts";
import { cn } from "../../lib/utils";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { selectTriggerVariants } from "../ui/select";
import {
  DEFAULT_FONT_VALUE,
  getFontFamilyPreference,
  getFontPickerDisplayLabel,
  getFontPickerItems,
} from "./FontFamilyPicker.logic";

function supportsFontEnumeration(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as { queryLocalFonts?: unknown }).queryLocalFonts === "function"
  );
}

type FontEnumerationState =
  | { readonly status: "unknown" }
  | { readonly status: "granted"; readonly families: readonly string[] }
  | { readonly status: "unavailable" };

// Shared across every row: once one picker learns the fonts (or learns the
// permission is blocked), the others follow without re-querying — and the
// rows can swap to the plain-input control together.
let enumerationState: FontEnumerationState = supportsFontEnumeration()
  ? { status: "unknown" }
  : { status: "unavailable" };
const enumerationListeners = new Set<() => void>();

function subscribeToEnumeration(listener: () => void): () => void {
  enumerationListeners.add(listener);
  return () => enumerationListeners.delete(listener);
}

function readEnumerationState(): FontEnumerationState {
  return enumerationState;
}

let enumerationLoad: Promise<void> | null = null;

/** Query installed fonts; call from a user gesture (the permission prompt needs one). */
export function discoverInstalledFonts(): void {
  if (enumerationState.status !== "unknown" || enumerationLoad !== null) return;
  enumerationLoad = queryInstalledFontFamilies().then((result) => {
    enumerationState =
      result.status === "granted"
        ? { status: "granted", families: result.families }
        : { status: "unavailable" };
    enumerationLoad = null;
    for (const listener of enumerationListeners) listener();
  });
}

let grantedProbeStarted = false;

/**
 * Discover eagerly when the permission is already granted, so the picker
 * renders without waiting for a focus. Electron's default permission handler
 * approves silently (it has no prompt UI), and a browser that granted once
 * reports "granted" on later visits — in both, no user gesture is needed.
 * "prompt" and "denied" states change nothing: the focus-driven flow stays,
 * because raising the browser prompt still requires a gesture.
 */
function probeAlreadyGrantedPermission(): void {
  if (grantedProbeStarted || enumerationState.status !== "unknown") return;
  grantedProbeStarted = true;
  const permissions = typeof navigator !== "undefined" ? navigator.permissions : undefined;
  if (typeof permissions?.query !== "function") return;
  permissions.query({ name: "local-fonts" as PermissionName }).then(
    (status) => {
      if (status.state === "granted") discoverInstalledFonts();
    },
    () => {
      // The engine does not recognize the permission name; keep the
      // focus-driven flow.
    },
  );
}

/**
 * Whether the engine can list installed fonts (Local Font Access API —
 * Chromium and Electron). "unknown" until discovery resolves the permission;
 * rows render a plain family-name input until the state is known granted,
 * then upgrade to the picker. Where the permission is already granted,
 * discovery starts at mount and the picker appears without a focus.
 */
export function useFontEnumeration(): FontEnumerationState {
  useEffect(probeAlreadyGrantedPermission, []);
  return useSyncExternalStore(subscribeToEnumeration, readEnumerationState);
}

/**
 * A searchable picker over every installed family, the way native editors
 * list system fonts. An unset preference keeps its semantic label in the
 * trigger while the menu also names the family it currently resolves to.
 */
export function FontFamilyPicker({
  ariaLabel,
  triggerClassName,
  defaultFamily,
  defaultOptionLabel,
  selectedFamily,
  requireMonospace = false,
  initialOpen = false,
  onSelect,
}: {
  ariaLabel: string;
  triggerClassName?: string;
  /** What an unset preference renders as, e.g. "Menlo". */
  defaultFamily: string;
  /** Semantic meaning of an unset preference, e.g. "System default". */
  defaultOptionLabel: string;
  /** Committed family name; empty string means the default is in use. */
  selectedFamily: string;
  requireMonospace?: boolean;
  /** Open the popup on mount — set when the control upgrades under focus. */
  initialOpen?: boolean;
  onSelect: (family: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Open after mount rather than mounting open: a popup that first renders in
  // its open state never receives Base UI's entrance style baseline, so the
  // exit transition on close has no style delta, never fires transitionend,
  // and the popup lingers on screen forever.
  useEffect(() => {
    if (initialOpen) setOpen(true);
    // The prop is only meaningful at mount - the control just swapped in
    // under an active focus - so later changes are deliberately ignored.
  }, []);
  const listRef = useRef<LegendListRef | null>(null);
  const enumeration = useFontEnumeration();

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setQuery("");
  };

  const families = useMemo(() => {
    if (enumeration.status !== "granted") return [];
    return requireMonospace ? enumeration.families.filter(isMonospaceFamily) : enumeration.families;
  }, [enumeration, requireMonospace]);

  const items = useMemo(() => {
    return getFontPickerItems({ families, query, defaultFamily, defaultOptionLabel });
  }, [defaultFamily, defaultOptionLabel, families, query]);

  const selectedValue = selectedFamily.length === 0 ? DEFAULT_FONT_VALUE : selectedFamily;

  const handlePick = (value: string) => {
    setOpen(false);
    onSelect(getFontFamilyPreference(value));
  };

  const renderItem = (item: string, index: number) => {
    const isDefault = item === DEFAULT_FONT_VALUE;
    const family = isDefault ? defaultFamily : item;
    return (
      <ComboboxItem hideIndicator index={index} key={item} value={item}>
        <div className="flex w-full min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate" style={{ fontFamily: family }}>
            {isDefault ? defaultOptionLabel : family}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {isDefault ? (
              <span className="max-w-28 truncate text-[10px] text-muted-foreground/60">
                Currently {defaultFamily}
              </span>
            ) : null}
            {item === selectedValue ? (
              <CheckIcon className="size-3.5 text-muted-foreground" />
            ) : null}
          </span>
        </div>
      </ComboboxItem>
    );
  };

  return (
    <Combobox
      items={items}
      filteredItems={items}
      autoHighlight
      virtualized
      open={open}
      onOpenChange={handleOpenChange}
      value={selectedValue}
      onValueChange={(next) => {
        if (typeof next === "string") handlePick(next);
      }}
      onItemHighlighted={(_value, eventDetails) => {
        // Keyboard highlights must pull the virtualized row into view, or
        // arrow keys walk past the rendered window and navigate blind.
        if (!open || eventDetails.index < 0 || eventDetails.reason !== "keyboard") return;
        void listRef.current?.scrollIndexIntoView?.({ index: eventDetails.index, animated: false });
      }}
    >
      <ComboboxTrigger
        aria-label={ariaLabel}
        className={cn(selectTriggerVariants({ size: "sm" }), triggerClassName)}
      >
        <span className="min-w-0 truncate">
          {getFontPickerDisplayLabel(selectedFamily, defaultOptionLabel)}
        </span>
        <ChevronDownIcon className="-me-1 size-3 opacity-50" />
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="flex w-72 flex-col">
        <ComboboxSearchInput
          placeholder="Search fonts…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ComboboxEmpty>No fonts found.</ComboboxEmpty>
          <div className="relative min-h-0 max-h-72 w-full flex-1 overflow-hidden">
            <ComboboxListVirtualized className="size-full min-w-0 p-0">
              <LegendList<string>
                ref={listRef}
                data={items}
                keyExtractor={(item) => item}
                renderItem={({ item, index }) => renderItem(item, index)}
                estimatedItemSize={30}
                drawDistance={360}
                style={{ height: Math.min(items.length * 30, 288) }}
              />
            </ComboboxListVirtualized>
          </div>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}
