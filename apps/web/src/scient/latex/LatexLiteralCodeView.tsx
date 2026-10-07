import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { HighlightStyle, LanguageDescription, type Language } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightTree, tags } from "@lezer/highlight";
import { LatexTextField, restoredLatexFieldDraft } from "./LatexTextField";
import type { LatexListingPresentation } from "./latexLiteral";

const highlighting = HighlightStyle.define([
  { tag: tags.keyword, class: "scient-latex-listing-keyword" },
  { tag: tags.comment, class: "scient-latex-listing-comment" },
  { tag: tags.string, class: "scient-latex-listing-string" },
]);
const sizeFactors: Record<string, number> = {
  inherit: 1,
  tiny: 0.5,
  scriptsize: 0.7,
  footnotesize: 0.8,
  small: 0.9,
  normalsize: 1,
  large: 1.2,
  Large: 1.44,
};
function textStyle(style: LatexListingPresentation["basic"], base = 1): CSSProperties {
  return {
    color: style.color,
    ...(style.size === "inherit" ? {} : { fontSize: `${(sizeFactors[style.size] ?? 1) / base}em` }),
    ...(style.bold === null ? {} : { fontWeight: style.bold ? "bold" : "normal" }),
    ...(style.italic === null ? {} : { fontStyle: style.italic ? "italic" : "normal" }),
    ...(style.family === "tt"
      ? { fontFamily: '"KaTeX_Typewriter", var(--font-mono)' }
      : style.family === "rm"
        ? { fontFamily: '"KaTeX_Main", serif' }
        : style.family === "sf"
          ? { fontFamily: "sans-serif" }
          : {}),
  };
}

/** Native fields retain the existing draft/save/undo path; the backdrop only paints code. */
export function LatexLiteralCodeView(props: {
  body: string;
  environment: string;
  caption: string | null;
  captionEditing: boolean;
  ordinal: string;
  presentation: LatexListingPresentation | null;
  disabled: boolean;
  bodyDraftKey?: string | undefined;
  captionDraftKey?: string | undefined;
  onBodyChange: (value: string) => void;
  onCaptionChange: (value: string) => void;
  onCaptionEditing: (editing: boolean) => void;
  onExit: () => void;
}) {
  const [live, setLive] = useState(() => restoredLatexFieldDraft(props.bodyDraftKey, props.body));
  const host = useRef<HTMLDivElement>(null);
  const [syntax, setSyntax] = useState<{ name: string; language: Language } | null>(null);
  const name = props.presentation?.language.replace(/^\[[^\]]*\]/u, "") ?? "";
  useEffect(() => {
    let active = true;
    const description = LanguageDescription.matchLanguageName(languages, name, false);
    if (description)
      void description
        .load()
        .then((support) => {
          if (active) setSyntax({ name, language: support.language });
        })
        .catch(() => {
          /* Code remains readable and editable if a language cannot load. */
        });
    return () => {
      active = false;
    };
  }, [name]);
  useLayoutEffect(() => {
    const field = host.current?.querySelector<HTMLTextAreaElement>("textarea");
    setLive(field?.value ?? props.body);
  }, [props.body]);
  const lines = useMemo(() => {
    const ranges: { from: number; to: number; classes: string }[] = [];
    if (syntax?.name === name && live.length <= 100000)
      highlightTree(syntax.language.parser.parse(live), highlighting, (from, to, classes) =>
        ranges.push({ from, to, classes }),
      );
    let offset = 0,
      rangeIndex = 0;
    return live.split(/\r?\n/u).map((line, lineIndex) => {
      const from = offset,
        to = from + line.length;
      offset = to + (live[to] === "\r" ? 2 : 1);
      const pieces: { text: string; classes: string; from: number }[] = [];
      let cursor = from;
      while (rangeIndex < ranges.length && ranges[rangeIndex]!.to <= from) rangeIndex++;
      for (let index = rangeIndex; index < ranges.length && ranges[index]!.from < to; index++) {
        const range = ranges[index]!;
        const start = Math.max(cursor, range.from),
          end = Math.min(to, range.to);
        if (start > cursor)
          pieces.push({ text: live.slice(cursor, start), classes: "", from: cursor });
        if (end > start)
          pieces.push({ text: live.slice(start, end), classes: range.classes, from: start });
        cursor = Math.max(cursor, end);
      }
      if (cursor < to) pieces.push({ text: live.slice(cursor, to), classes: "", from: cursor });
      return { line, lineIndex, pieces };
    });
  }, [live, syntax, name]);
  const settings = props.presentation;
  const base = sizeFactors[settings?.basic.size ?? "inherit"] ?? 1;
  const paint = (classes: string) =>
    classes.includes("keyword")
      ? textStyle(settings!.keyword, base)
      : classes.includes("comment")
        ? textStyle(settings!.comment, base)
        : classes.includes("string")
          ? textStyle(settings!.string, base)
          : undefined;
  const caption =
    props.caption === null && !props.captionEditing ? null : (
      <div className="scient-latex-listing-caption">
        {props.caption !== null && <span>Listing {props.ordinal}: </span>}
        <LatexTextField
          aria-label="Listing caption"
          rows={1}
          value={props.caption ?? ""}
          disabled={props.disabled}
          draftKey={props.captionDraftKey}
          onValueChange={props.onCaptionChange}
          onFocus={() => props.onCaptionEditing(true)}
          onBlur={(event) => {
            if (!event.relatedTarget && !event.currentTarget.ownerDocument.hasFocus()) return;
            props.onCaptionEditing(false);
          }}
          onRemoveEmpty={() => {
            props.onCaptionChange("");
            props.onCaptionEditing(false);
            host.current
              ?.querySelector<HTMLTextAreaElement>("textarea")
              ?.focus({ preventScroll: true });
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || (event.key !== "Escape" && event.key !== "Enter"))
              return;
            event.preventDefault();
            event.stopPropagation();
            host.current
              ?.querySelector<HTMLTextAreaElement>("textarea")
              ?.focus({ preventScroll: true });
          }}
        />
      </div>
    );
  return (
    <>
      {settings?.captionPosition !== "b" ? caption : null}
      <div
        ref={host}
        className="scient-latex-literal-code"
        data-frame={settings?.frame ?? "none"}
        data-numbers={settings?.numbers ?? "none"}
        data-wrap={settings?.breakLines === true || undefined}
        style={
          {
            ...(settings
              ? textStyle(settings.basic)
              : { fontFamily: '"KaTeX_Typewriter", var(--font-mono)' }),
            tabSize: settings?.tabSize ?? 8,
            "--scient-latex-listing-number-sep": settings?.numberSep,
          } as CSSProperties
        }
      >
        <div className="scient-latex-listing-highlight" aria-hidden="true">
          {lines.map(({ line, lineIndex, pieces }) => {
            const number = (settings?.firstNumber ?? 1) + lineIndex;
            const numbered =
              settings &&
              settings.numbers !== "none" &&
              settings.step > 0 &&
              number % settings.step === 0 &&
              (line.trim() !== "" || settings.numberBlankLines);
            return (
              <div className="scient-latex-listing-line" key={lineIndex}>
                {numbered ? (
                  <span
                    className="scient-latex-listing-number"
                    style={{
                      ...textStyle(settings.number, base),
                      fontFamily: '"KaTeX_Main", serif',
                    }}
                  >
                    {number}
                  </span>
                ) : null}
                {pieces.map((piece) => (
                  <span
                    key={piece.from}
                    className={piece.classes || undefined}
                    style={settings ? paint(piece.classes) : undefined}
                  >
                    {props.environment === "verbatim*" ||
                    (settings?.showStringSpaces && piece.classes.includes("string"))
                      ? piece.text.replaceAll(" ", "\u2423")
                      : piece.text}
                  </span>
                ))}
                {!line ? "\u200b" : null}
              </div>
            );
          })}
        </div>
        <LatexTextField
          className="scient-latex-listing-editor"
          aria-label={
            ["lstlisting", "tcblisting"].includes(props.environment)
              ? "Code listing"
              : "Literal text"
          }
          rows={1}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap={settings?.breakLines ? "soft" : "off"}
          value={props.body}
          disabled={props.disabled}
          draftKey={props.bodyDraftKey}
          onInput={(event) => setLive(event.currentTarget.value)}
          onValueChange={props.onBodyChange}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              props.onExit();
            }
          }}
        />
      </div>
      {settings?.captionPosition === "b" ? caption : null}
    </>
  );
}
