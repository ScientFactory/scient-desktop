import type { LatexTableCellLayout } from "./latexVisualDocument";

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
}: {
  band: LongTableBand;
  kind: string;
  columns: number;
  alignments: readonly string[];
  number: string | null;
}) {
  return (
    <>
      {band.rows.map((row, rowIndex) => (
        <tr
          key={rowIndex}
          data-latex-longtable-band={kind}
          style={{
            fontSize: `var(--scient-latex-size-${band.sizes[rowIndex] ?? "normalsize"})`,
            lineHeight: `var(--scient-latex-baseline-${band.sizes[rowIndex] ?? "normalsize"})`,
          }}
        >
          {row.map((text, column) => {
            const layout = band.layout[rowIndex]?.[column];
            if (layout && (layout.row !== rowIndex || layout.column !== column)) return null;
            return (
              <td
                key={column}
                colSpan={layout?.colSpan}
                rowSpan={layout?.rowSpan}
                data-align={layout?.alignment ?? alignments[column] ?? "left"}
                style={{
                  borderTop: layout?.top ? "0.4pt solid currentColor" : "none",
                  borderBottom: layout?.bottom ? "0.4pt solid currentColor" : "none",
                  borderLeft: layout?.left ? "0.4pt solid currentColor" : "none",
                  borderRight: layout?.right ? "0.4pt solid currentColor" : "none",
                  backgroundColor: layout?.background ?? undefined,
                  paddingTop: layout?.top ? "0.65ex" : 0,
                  paddingBottom: layout?.bottom ? "0.4ex" : 0,
                }}
              >
                {text.replaceAll("SCIENTTABLENUMBER", number ?? "??")}
              </td>
            );
          })}
        </tr>
      ))}
      {band.rows.length === 0 && band.rule ? (
        <tr data-latex-longtable-band={kind}>
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
