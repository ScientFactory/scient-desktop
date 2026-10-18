import type { LatexTableCellLayout } from "./latexVisualDocument";
import { latexTableRulePresentation } from "./latexTableAuthoring";
import type { Editor } from "@tiptap/core";
import { LatexProsePreview } from "./LatexProsePreview";

export interface LongTableBand {
  rows: string[][];
  layout: (LatexTableCellLayout | null)[][];
  rule: boolean;
  sizes: string[];
}

/** Continuation furniture is a read-only repetition; body cells remain the edit targets. */
export function LatexLongTableBand({
  band,
  kind,
  columns,
  alignments,
  number,
  repeat = false,
  left = 0,
  editor,
  rootSource,
}: {
  band: LongTableBand;
  kind: string;
  columns: number;
  alignments: readonly string[];
  number: string | null;
  repeat?: boolean;
  left?: number;
  editor?: Editor;
  rootSource?: string;
}) {
  return (
    <>
      {band.rows.map((row, rowIndex) => (
        <tr
          key={rowIndex}
          data-latex-longtable-band={kind}
          data-paged-repeat={repeat || undefined}
          style={{
            position: "relative",
            left,
            fontSize: band.sizes[rowIndex]
              ? `var(--scient-latex-size-${band.sizes[rowIndex]})`
              : "inherit",
            lineHeight: band.sizes[rowIndex]
              ? `var(--scient-latex-baseline-${band.sizes[rowIndex]})`
              : "inherit",
          }}
        >
          {row.map((text, column) => {
            const layout = band.layout[rowIndex]?.[column];
            if (layout && (layout.row !== rowIndex || layout.column !== column)) return null;
            const topRule = latexTableRulePresentation(layout?.topRule);
            const bottomRule = latexTableRulePresentation(layout?.bottomRule);
            return (
              <td
                key={column}
                colSpan={layout?.colSpan}
                rowSpan={layout?.rowSpan}
                data-align={layout?.alignment ?? alignments[column] ?? "left"}
                data-paragraph-column={layout?.justified || undefined}
                style={{
                  borderTop: layout?.top
                    ? `${topRule.width} solid ${layout.topColor ?? "currentColor"}`
                    : "none",
                  borderBottom: layout?.bottom
                    ? `${bottomRule.width} solid ${layout.bottomColor ?? "currentColor"}`
                    : "none",
                  borderInlineStart: layout?.left ? "0.4pt solid currentColor" : "none",
                  borderInlineEnd: layout?.right ? "0.4pt solid currentColor" : "none",
                  backgroundColor: layout?.background ?? undefined,
                  paddingTop: layout?.top ? topRule.after : 0,
                  paddingBottom: layout?.bottom ? bottomRule.before : 0,
                }}
              >
                <LatexProsePreview
                  source={text.replaceAll("SCIENTTABLENUMBER", number ?? "??")}
                  {...(editor === undefined ? {} : { editor })}
                  {...(rootSource === undefined ? {} : { rootSource })}
                />
              </td>
            );
          })}
        </tr>
      ))}
      {band.rows.length === 0 && band.rule ? (
        <tr
          data-latex-longtable-band={kind}
          data-paged-repeat={repeat || undefined}
          style={{ position: "relative", left }}
        >
          <td
            colSpan={columns}
            className="scient-latex-longtable-rule"
            style={{ padding: 0, height: 0, lineHeight: 0, borderBottom: "none" }}
          />
        </tr>
      ) : null}
    </>
  );
}
