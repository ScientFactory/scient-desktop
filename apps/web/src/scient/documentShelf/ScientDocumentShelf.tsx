import {
  createContext,
  isValidElement,
  use,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";

/**
 * Keeps the views of documents left recently (a PDF, a Word file) mounted but hidden, so coming
 * back shows them exactly as left: same place, same drawn pages, nothing redrawn. A view stays only
 * while its reader keeps it, which parks its document in documentCache: one budget holds kept views
 * and kept documents, and past it the view left longest ago goes.
 */

/** What a hidden view's reader does to stay kept. */
export interface ShelfKeeper {
  /** The view is hidden. True keeps it, until `evict`; `viewBytes` is what its drawn pages hold. */
  readonly hide: (evict: () => void, viewBytes: () => number) => boolean;
  /** The view shows again. */
  readonly show: () => void;
}

export interface ShelfPlace {
  /** Lets the reader of this view keep it while hidden; returns the undo. */
  readonly keep: (keeper: ShelfKeeper) => () => void;
}

const ShelfPlaceContext = createContext<ShelfPlace | null>(null);
const ShelfHiddenContext = createContext(false);

/** The shelf place of the view rendering this, if a shelf holds it. */
export function useShelfPlace() {
  return use(ShelfPlaceContext);
}

/** The view rendering this is kept hidden: it draws only what is in view. */
export function useShelfHidden() {
  return use(ShelfHiddenContext);
}

/** A view the shelf may keep, named by its file. Only ScientDocumentShelf renders it. */
export function ShelfItem(props: { readonly shelfKey: string; readonly children: ReactNode }) {
  return props.children;
}

interface Place extends ShelfPlace {
  keeper: ShelfKeeper | null;
  element: HTMLDivElement | null;
}

interface Item {
  readonly key: string;
  readonly view: ReactNode;
  readonly place: Place;
}

function createPlace(): Place {
  const place: Place = {
    keeper: null,
    element: null,
    keep: (keeper) => {
      place.keeper = keeper;
      return () => {
        if (place.keeper === keeper) place.keeper = null;
      };
    },
  };
  return place;
}

/** The memory the canvases under `element` hold, at four bytes a pixel. */
function canvasBytes(element: Element | null) {
  let bytes = 0;
  for (const canvas of element?.querySelectorAll("canvas") ?? [])
    bytes += canvas.width * canvas.height * 4;
  return bytes;
}

/**
 * A box showing `children`. A `ShelfItem` child is shown in a place of its own that outlives it:
 * when another child replaces it, it stays hidden there while its reader keeps it.
 */
export function ScientDocumentShelf(props: {
  readonly className?: string;
  readonly inert?: boolean | undefined;
  readonly children: ReactNode;
}) {
  const current =
    isValidElement(props.children) && props.children.type === ShelfItem
      ? (props.children as ReactElement<{ shelfKey: string; children: ReactNode }>).props
      : null;
  const currentKey = current?.shelfKey ?? null;
  // In the order first shown, never reordered: moving a view's element would lose its scroll.
  const [items, setItems] = useState<readonly Item[]>([]);
  if (current) {
    const index = items.findIndex((item) => item.key === current.shelfKey);
    // A hidden view keeps the props it was last shown with.
    if (index === -1)
      setItems([...items, { key: current.shelfKey, view: current.children, place: createPlace() }]);
    else if (items[index]!.view !== current.children)
      setItems(items.with(index, { ...items[index]!, view: current.children }));
  }

  const shown = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the readers of the views that hid or showed, after the commit that did it, and drops a hidden view its reader does not keep
  useEffect(() => {
    const previous = shown.current;
    shown.current = currentKey;
    if (previous === currentKey) return;
    const placeOf = (key: string) => items.find((item) => item.key === key)?.place;
    const drop = (key: string) => {
      if (shown.current === key) return;
      setItems((all) => all.filter((item) => item.key !== key));
    };
    if (currentKey !== null) placeOf(currentKey)?.keeper?.show();
    if (previous === null) return;
    const place = placeOf(previous);
    const kept =
      place?.keeper?.hide(
        () => drop(previous),
        () => canvasBytes(place.element),
      ) ?? false;
    if (!kept) drop(previous);
  }, [currentKey, items]);

  return (
    <div className={cn("relative", props.className)} inert={props.inert}>
      {current ? null : props.children}
      {items.map((item) => {
        const hidden = item.key !== currentKey;
        return (
          <div
            key={item.key}
            ref={(element) => {
              item.place.element = element;
            }}
            className="absolute inset-0 flex min-h-0 flex-col"
            style={hidden ? { visibility: "hidden" } : undefined}
            inert={hidden || undefined}
            aria-hidden={hidden || undefined}
          >
            <ShelfPlaceContext value={item.place}>
              <ShelfHiddenContext value={hidden}>{item.view}</ShelfHiddenContext>
            </ShelfPlaceContext>
          </div>
        );
      })}
    </div>
  );
}

/**
 * How many times `key` changed while `file` was shown. A reload asked for one file then reaches its
 * view only, not the hidden views of the others.
 */
export function useChangesWhileShown(file: string, key: string): number {
  const [seen, setSeen] = useState<{
    readonly file: string;
    readonly key: string;
    readonly counts: ReadonlyMap<string, number>;
  }>({ file, key, counts: new Map() });
  if (seen.file !== file || seen.key !== key) {
    const counts = new Map(seen.counts);
    if (seen.file === file) counts.set(file, (counts.get(file) ?? 0) + 1);
    setSeen({ file, key, counts });
  }
  return seen.counts.get(file) ?? 0;
}
