/* oxlint-disable react/no-array-index-key -- A match keeps its place among a page's matches while the query stands. */
import { useEffect, useRef, useState } from "react";

import { findBoxes, type FindMatch } from "./officeFind";

/**
 * Marks a query's matches on one page, over its text layer, in the PDF reader's find colours.
 * `active` is the match among the page's own that find stands on; it is scrolled into view. Find
 * counts a Word page's body only, so `active` skips its header, footer and notes unless `everywhere`.
 */
export function OfficeFindMarks(props: {
  readonly query: string;
  readonly active: number | null;
  readonly everywhere?: boolean;
}) {
  const { query, active, everywhere = false } = props;
  const marks = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<FindMatch[]>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the page's text layer DOM, which its worker fills in after this mounts, and marks the query in it
  useEffect(() => {
    const own = marks.current;
    const page = own?.parentElement;
    if (!own || !page) return;
    const mark = () => setBoxes(findBoxes(page, query, (node) => own.contains(node)));
    mark();
    const observer = new MutationObserver((records) => {
      if (records.some((record) => !own.contains(record.target))) mark();
    });
    observer.observe(page, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [query]);
  // Each match find moves to is brought into view once, so the person can scroll away from it.
  const shown = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the pages' scroller DOM node to the active match once it is marked
  useEffect(() => {
    if (active === null) shown.current = null;
    if (boxes.length === 0) return;
    const box = marks.current?.querySelector<HTMLElement>("[data-active]");
    const scroller = box?.closest<HTMLElement>("[data-office-pages]");
    if (!box || !scroller || shown.current === `${active}:${query}`) return;
    shown.current = `${active}:${query}`;
    const view = scroller.getBoundingClientRect();
    const at = box.getBoundingClientRect();
    if (
      at.top >= view.top &&
      at.bottom <= view.bottom &&
      at.left >= view.left &&
      at.right <= view.right
    )
      return;
    scroller.scrollBy({
      top: at.top + at.height / 2 - (view.top + view.height / 2),
      left: at.left < view.left || at.right > view.right ? at.left - view.left - 24 : 0,
    });
  }, [active, boxes, query]);
  return (
    <div ref={marks} aria-hidden="true" className="pointer-events-none absolute inset-0">
      {boxes.map((match, index) => {
        const counted = everywhere || !match.aside;
        const ordinal = counted
          ? boxes.slice(0, index).filter((m) => everywhere || !m.aside).length
          : -1;
        return match.boxes.map((box, part) => (
          <div
            key={`${index}:${part}`}
            data-active={(counted && ordinal === active) || undefined}
            className="absolute bg-[rgb(255_208_0/45%)] data-active:bg-[rgb(255_140_0/68%)]"
            style={{
              left: `${box.left * 100}%`,
              top: `${box.top * 100}%`,
              width: `${box.width * 100}%`,
              height: `${box.height * 100}%`,
            }}
          />
        ));
      })}
    </div>
  );
}
