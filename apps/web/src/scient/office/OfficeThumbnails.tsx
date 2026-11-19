/* oxlint-disable react/no-array-index-key -- A page keeps its ordinal throughout incremental layout. */
import { useEffect, useRef, useState } from "react";

import type { PageSize, PaintPage } from "~/components/files/office/OfficePages";
import { ReaderPageThumbnail } from "../writing/ReaderPageThumbnail";

const THUMBNAIL_WIDTH = 132;

/** The reader's sidebar of pages, in the PDF reader's look. Pages paint as they scroll into it. */
export function OfficeThumbnails(props: {
  readonly label: string;
  readonly pages: readonly PageSize[];
  readonly paint: PaintPage;
  readonly active: number;
  readonly onSelect: (index: number) => void;
  readonly onError: (error: unknown) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const { active } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the sidebar DOM node so the page being read stays in it
  useEffect(() => {
    const scroller = list.current;
    const item = scroller?.querySelector<HTMLElement>(`[data-office-thumbnail="${active}"]`);
    if (!scroller || !item) return;
    const view = scroller.getBoundingClientRect();
    const at = item.getBoundingClientRect();
    if (at.top < view.top) scroller.scrollTop -= view.top - at.top;
    else if (at.bottom > view.bottom) scroller.scrollTop += at.bottom - view.bottom;
  }, [active]);
  return (
    <aside className="scient-pdf-sidebar" aria-label={`${props.label}s`}>
      <div ref={list} className="scient-pdf-sidebar-content">
        <div className="scient-pdf-thumbnails">
          {props.pages.map((page, index) => (
            <OfficeThumbnail
              key={index}
              index={index}
              page={page}
              root={list}
              active={index === active}
              paint={props.paint}
              onSelect={props.onSelect}
              onError={props.onError}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}

function OfficeThumbnail(props: {
  readonly index: number;
  readonly page: PageSize;
  readonly root: React.RefObject<HTMLDivElement | null>;
  readonly active: boolean;
  readonly paint: PaintPage;
  readonly onSelect: (index: number) => void;
  readonly onError: (error: unknown) => void;
}) {
  const { index, page, root, paint, onError } = props;
  const item = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the thumbnail DOM node's nearness to the sidebar's view, so only those paint
  useEffect(() => {
    if (!item.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry?.isIntersecting ?? false),
      {
        root: root.current,
        rootMargin: "240px 0px",
      },
    );
    observer.observe(item.current);
    return () => observer.disconnect();
  }, [root]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints the page into the canvas DOM node through its engine's worker and cancels the paint when it leaves
  useEffect(() => {
    const target = canvas.current;
    if (!near || !target) return;
    const controller = new AbortController();
    void paint(index, target, THUMBNAIL_WIDTH / page.width, controller.signal).catch(
      (cause: unknown) => {
        if (!controller.signal.aborted) onError(cause);
      },
    );
    return () => controller.abort();
  }, [near, index, page, paint, onError]);
  return (
    <div ref={item} className="scient-pdf-thumbnail-item" data-office-thumbnail={index}>
      <ReaderPageThumbnail
        pageNumber={index + 1}
        active={props.active}
        onSelect={() => props.onSelect(index)}
      >
        <canvas
          ref={canvas}
          aria-hidden="true"
          style={{
            width: THUMBNAIL_WIDTH,
            height: (THUMBNAIL_WIDTH * page.height) / page.width,
            background: page.background ?? "#fff",
          }}
        />
      </ReaderPageThumbnail>
    </div>
  );
}
