import { CornerDownLeft } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { focusNewDocumentWhenOpen } from "./focusNewDocument";

/** Marks the new document's own controls, so focus there still counts as naming it. */
export const STRIP_ATTRIBUTE = "data-new-document-strip";
const strip = { [STRIP_ATTRIBUTE]: "" };

const LATEX_TITLE = 'textarea[aria-label="Document title"]';
/** Type size of the margin row in page pixels; it never reads smaller than this on screen. */
const PAGE_FONT_PX = 12;
const MIN_SCREEN_FONT_PX = 11;

type Page =
  | { readonly kind: "latex"; readonly paper: HTMLElement; readonly zoom: number }
  | { readonly kind: "markdown"; readonly host: HTMLElement };

/**
 * What a new document shows on its own page until it is named: in LaTeX, the
 * template row and, for a template without a title, the name line, both in the
 * first page's top margin; and the file name the document will take, under its
 * title or heading, with Enter to take it.
 */
export function NewDocumentOnPage(props: {
  readonly row: ReactNode;
  /** A template without a title: the name typed above the page, as last entered. */
  readonly name: { readonly value: string; readonly onCommit: (name: string) => void } | null;
  /** Show the file name under the title or heading. */
  readonly hint: boolean;
  readonly currentFileName: string;
  readonly fileNameFor: (title: string) => string;
  /** The first edit on the page beyond the title or name; null once that has happened. */
  readonly onEdit: (() => void) | null;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const page = usePage(anchor);
  const onEdit = useEffectEvent(() => props.onEdit?.());
  const watching = props.onEdit !== null;
  const surface = page ? (page.kind === "latex" ? page.paper : page.host) : null;
  useEffect(() => {
    if (!surface || !watching) return;
    // An included file is edited on the same page, so the page is where to listen.
    const input = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(`[${STRIP_ATTRIBUTE}], ${LATEX_TITLE}`)) return;
      onEdit();
    };
    surface.addEventListener("beforeinput", input, true);
    return () => surface.removeEventListener("beforeinput", input, true);
  }, [surface, watching]);
  const fileName = (typed: string) =>
    typed.trim() ? props.fileNameFor(typed) : props.currentFileName;
  let content: ReactNode = null;
  if (page?.kind === "latex") {
    const fontSize = Math.max(PAGE_FONT_PX, MIN_SCREEN_FONT_PX / Math.max(page.zoom, 0.1));
    content = (
      <>
        {props.row || props.name ? (
          <div
            className="scient-new-document-margin"
            dir="ltr"
            style={{ fontSize: `${fontSize}px` }}
            {...strip}
          >
            {props.row}
            {props.name ? (
              <NameLine
                key={props.name.value}
                initial={props.name.value}
                fileName={fileName}
                onCommit={props.name.onCommit}
              />
            ) : null}
          </div>
        ) : null}
        {props.hint ? (
          <LatexTitleHint paper={page.paper} fontSize={fontSize} fileName={fileName} />
        ) : null}
      </>
    );
  } else if (page?.kind === "markdown" && props.hint) {
    content = <MarkdownHeadingHint host={page.host} fileName={fileName} />;
  }
  return (
    <>
      <span ref={anchor} hidden />
      {page && content
        ? createPortal(content, page.kind === "latex" ? page.paper : page.host)
        : null}
    </>
  );
}

/**
 * The page drawn next to `anchor`: Visual's first page, or the Markdown editor.
 * Editors draw their page later than this and may draw it again, and Source or
 * PDF has none; the parts show only while there is a page.
 */
function usePage(anchor: RefObject<HTMLElement | null>): Page | null {
  const [page, setPage] = useState<Page | null>(null);
  useEffect(() => {
    const scope = anchor.current?.parentElement;
    if (!scope) return;
    let target: HTMLElement | null = null;
    let zoomFrame: HTMLElement | null = null;
    const resize = new ResizeObserver(() => measure());
    const measure = () => {
      if (!target) return setPage(null);
      if (target.matches(".scient-markdown-document-host")) {
        const host = target;
        return setPage((current) =>
          current?.kind === "markdown" && current.host === host
            ? current
            : { kind: "markdown", host },
        );
      }
      // Visual scales the page with a transform; its frame carries the scaled width.
      const paper = target;
      const zoom = zoomFrame && paper.offsetWidth ? zoomFrame.offsetWidth / paper.offsetWidth : 1;
      setPage((current) =>
        current?.kind === "latex" && current.paper === paper && current.zoom === zoom
          ? current
          : { kind: "latex", paper, zoom },
      );
    };
    const find = () => {
      if (target?.isConnected) return;
      resize.disconnect();
      target = scope.querySelector<HTMLElement>(
        ".scient-latex-visual-paper, .scient-markdown-document-host",
      );
      zoomFrame = target?.closest<HTMLElement>(".scient-latex-page-zoom-frame") ?? null;
      if (zoomFrame) resize.observe(zoomFrame);
      measure();
    };
    const mutations = new MutationObserver(find);
    mutations.observe(scope, { childList: true, subtree: true });
    find();
    return () => {
      mutations.disconnect();
      resize.disconnect();
    };
  }, [anchor]);
  return page;
}

/** Re-reads `read` whenever `root` changes, is typed in, resizes, or focus moves. */
function useLive<T>(root: HTMLElement, read: () => T, same: (a: T, b: T) => boolean): T {
  const [value, setValue] = useState(read);
  const refresh = useEffectEvent(() => {
    const next = read();
    setValue((current) => (same(current, next) ? current : next));
  });
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refresh);
    };
    const mutations = new MutationObserver(update);
    mutations.observe(root, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(update);
    resize.observe(root);
    root.addEventListener("input", update, true);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    document.addEventListener("selectionchange", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      resize.disconnect();
      root.removeEventListener("input", update, true);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      document.removeEventListener("selectionchange", update);
    };
  }, [root]);
  return value;
}

interface Placed {
  readonly top: number;
  readonly left: number | null;
  readonly typed: string;
  readonly naming: boolean;
}

function samePlaced(a: Placed | null, b: Placed | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.top === b.top &&
      a.left === b.left &&
      a.typed === b.typed &&
      a.naming === b.naming)
  );
}

/** The file name under a LaTeX title, centred like the title. */
function LatexTitleHint(props: {
  readonly paper: HTMLElement;
  readonly fontSize: number;
  readonly fileName: (typed: string) => string;
}) {
  const placed = useLive<Placed | null>(
    props.paper,
    () => {
      const field = props.paper.querySelector<HTMLTextAreaElement>(LATEX_TITLE);
      const title = field?.closest<HTMLElement>(".scient-latex-title-preview");
      if (!field || !title) return null;
      const scale = props.paper.getBoundingClientRect().width / (props.paper.offsetWidth || 1);
      // Under the title's own lines (title, author, date), not its whole block: on a
      // title page the block fills the page.
      const bottom = Math.max(
        ...[...title.querySelectorAll("textarea, input")].map(
          (line) => line.getBoundingClientRect().bottom,
        ),
      );
      const top = (bottom - props.paper.getBoundingClientRect().top) / scale;
      return {
        top: Math.round(top),
        left: null,
        typed: field.value,
        naming: document.activeElement === field,
      };
    },
    samePlaced,
  );
  if (!placed) return null;
  const enter = () => {
    // The title field's own Enter: leave the title for the text below it.
    props.paper
      .querySelector(LATEX_TITLE)
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };
  return (
    <div
      className="scient-new-document-hint"
      dir="ltr"
      style={{ top: placed.top, fontSize: `${props.fontSize}px` }}
      {...strip}
    >
      <FileName name={props.fileName(placed.typed)} onEnter={placed.naming ? enter : null} />
    </div>
  );
}

/** The file name after a Markdown document's first heading, on its line. */
function MarkdownHeadingHint(props: {
  readonly host: HTMLElement;
  readonly fileName: (typed: string) => string;
}) {
  const placed = useLive<Placed | null>(
    props.host,
    () => {
      const heading = props.host.querySelector<HTMLElement>(".scient-markdown-document > h1");
      if (!heading || heading !== heading.parentElement?.firstElementChild) return null;
      const origin = props.host.getBoundingClientRect();
      const box = heading.getBoundingClientRect();
      // The end of the heading's text, or its start while it is empty.
      const range = document.createRange();
      range.selectNodeContents(heading);
      const rects = range.getClientRects();
      const last = rects[rects.length - 1];
      const end = last && heading.textContent?.trim() ? last.right : box.left;
      const lineHeight = parseFloat(getComputedStyle(heading).lineHeight) || box.height;
      const lineTop = last && heading.textContent?.trim() ? last.top : box.top;
      const selection = window.getSelection()?.anchorNode;
      return {
        top: Math.round(lineTop - origin.top + lineHeight / 2),
        left: Math.round(end - origin.left),
        typed: heading.textContent ?? "",
        naming: selection != null && heading.contains(selection),
      };
    },
    samePlaced,
  );
  if (!placed) return null;
  const enter = () => {
    // The heading's own Enter: a new line under it.
    props.host
      .querySelector(".scient-markdown-document")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };
  return (
    <div
      className="scient-new-document-hint scient-new-document-hint-inline"
      dir="ltr"
      style={{ top: placed.top, left: placed.left ?? 0 }}
      {...strip}
    >
      <FileName name={props.fileName(placed.typed)} onEnter={placed.naming ? enter : null} />
    </div>
  );
}

function FileName(props: { readonly name: string; readonly onEnter: (() => void) | null }) {
  return (
    <>
      <span className="scient-new-document-file">{props.name}</span>
      {props.onEnter ? (
        <button
          type="button"
          className="scient-new-document-enter"
          aria-label="Name the file"
          onMouseDown={(event) => event.preventDefault()}
          onClick={props.onEnter}
        >
          <CornerDownLeft aria-hidden="true" />
        </button>
      ) : null}
    </>
  );
}

/** In a template without a title: the name, typed in the top margin. */
function NameLine(props: {
  readonly initial: string;
  readonly fileName: (typed: string) => string;
  readonly onCommit: (name: string) => void;
}) {
  const [value, setValue] = useState(props.initial);
  const [focused, setFocused] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const enter = () => {
    field.current?.blur();
    // Writing starts at the top of the text.
    focusNewDocumentWhenOpen({ offset: 0 });
  };
  return (
    <div className="scient-new-document-name">
      <input
        ref={field}
        aria-label="Document name"
        placeholder="Document name"
        value={value}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          props.onCommit(value.trim());
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          enter();
        }}
      />
      <div className="scient-new-document-name-file">
        <FileName name={props.fileName(value)} onEnter={focused ? enter : null} />
      </div>
    </div>
  );
}
