import { useEffect, useRef, type RefObject } from "react";
import { ReaderPageThumbnail } from "../writing/ReaderPageThumbnail";
import { createEditorBackgroundTask } from "./editorBackgroundTask";
import {
  drawLatexPagePreview,
  latexPagePreviewStyles,
  measureLatexPagePreview,
} from "./latexPagePreview";
import "mathlive/static.css";

export function LatexPageThumbnails(props: {
  readonly stage: RefObject<HTMLDivElement | null>;
  readonly pageCount: number;
  readonly currentPage: number;
  readonly width: number;
  readonly height: number;
  readonly gap: number;
  readonly onSelect: (page: number) => void;
}) {
  const navigation = useRef<HTMLElement>(null);
  const { stage, pageCount, width, height, gap } = props;
  useEffect(() => {
    const source = stage.current;
    const nav = navigation.current;
    if (!source || !nav) return;
    const visible = new Set<HTMLElement>();
    const refresh = createEditorBackgroundTask(500, 2000);
    let styles: CSSStyleSheet | null = null;
    const update = () => {
      if (!visible.size) return;
      const measured = measureLatexPagePreview(source);
      if (!measured) return;
      styles ??= latexPagePreviewStyles(source.ownerDocument);
      for (const host of visible) {
        const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
        shadow.adoptedStyleSheets = [styles];
        drawLatexPagePreview(shadow, measured, Number(host.dataset.page), width, height, gap);
      }
    };
    const schedule = () => refresh.schedule(update);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const host = entry.target as HTMLElement;
          if (entry.isIntersecting) visible.add(host);
          else {
            visible.delete(host);
            host.shadowRoot?.replaceChildren();
          }
        }
        schedule();
      },
      { root: nav.closest("aside"), rootMargin: "240px" },
    );
    for (const host of nav.querySelectorAll<HTMLElement>("[data-page]")) observer.observe(host);
    const mutations = new MutationObserver(schedule);
    mutations.observe(source, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    const styleChanges = new MutationObserver(() => {
      styles = null;
      schedule();
    });
    styleChanges.observe(source.ownerDocument.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    source.addEventListener("input", schedule);
    source.addEventListener("load", schedule, true);
    source.ownerDocument.fonts.addEventListener("loadingdone", schedule);
    return () => {
      refresh.cancel();
      observer.disconnect();
      mutations.disconnect();
      styleChanges.disconnect();
      source.removeEventListener("input", schedule);
      source.removeEventListener("load", schedule, true);
      source.ownerDocument.fonts.removeEventListener("loadingdone", schedule);
    };
  }, [stage, pageCount, width, height, gap]);
  return (
    <nav ref={navigation} aria-label="Document pages">
      {Array.from({ length: pageCount }, (_, index) => (
        <ReaderPageThumbnail
          key={index + 1}
          pageNumber={index + 1}
          active={props.currentPage === index + 1}
          onSelect={props.onSelect}
        >
          <span
            data-page={index + 1}
            aria-hidden="true"
            inert
            style={{
              display: "block",
              width: 132,
              height: (height * 132) / width,
              overflow: "hidden",
            }}
          />
        </ReaderPageThumbnail>
      ))}
    </nav>
  );
}
