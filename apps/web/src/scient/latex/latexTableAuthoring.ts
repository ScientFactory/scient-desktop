import {
  latexSourceArgument as arg,
  latexSourceCommands,
  patchLatexSource,
  type LatexSourceRange,
} from "./latexSourceSyntax";
import { latexColorCss } from "./latexColorBoxes";
import { longTableSections } from "./latexLongTable";

export interface LatexTableColumn extends LatexSourceRange {
  alignment: "left" | "center" | "right";
  kind: string;
  width: string;
  left: boolean;
  right: boolean;
  background: string;
}

/** Keep column modifiers and separators as source, independently of the grid. */
export function latexTableColumns(spec: string): LatexTableColumn[] | null {
  const columns: LatexTableColumn[] = [];
  let prefix = 0;
  for (let at = 0; at < spec.length;) {
    const ch = spec[at]!;
    if (/\s|\|/u.test(ch)) {
      at++;
      continue;
    }
    if ([">", "<", "@", "!"].includes(ch)) {
      const modifier = arg(spec, at + 1);
      if (!modifier) return null;
      at = modifier.end;
      continue;
    }
    if (!/[lcrXpmb]/u.test(ch)) return null;
    const dimension = /[pmb]/u.test(ch) ? arg(spec, at + 1) : null;
    if (/[pmb]/u.test(ch) && !dimension) return null;
    const from = at,
      to = dimension?.end ?? at + 1;
    const before = spec.slice(prefix, at);
    const color = /\\columncolor\s*\{([^{}]+)\}/u.exec(before)?.[1] ?? "";
    columns.push({
      from,
      to,
      kind: ch,
      width: dimension?.value ?? "",
      background: color,
      alignment:
        ch === "c" || /\\centering\b/u.test(before)
          ? "center"
          : ch === "r" || /\\raggedleft\b/u.test(before)
            ? "right"
            : "left",
      left: before.includes("|"),
      right: false,
    });
    prefix = to;
    at = to;
  }
  columns.forEach((column, index) => {
    column.right = spec.slice(column.to, columns[index + 1]?.from ?? spec.length).includes("|");
  });
  return columns.length ? columns : null;
}

export function latexTableSourceShape(source: string) {
  for (const command of latexSourceCommands(source)) {
    if (command.name !== "begin") continue;
    const env = arg(source, command.to);
    if (!env || !["tabular", "tabularx", "tabulary", "longtable"].includes(env.value)) continue;
    let at = env.end;
    const option = arg(source, at, "[", "]");
    if (option) at = option.end;
    if (["tabularx", "tabulary"].includes(env.value)) {
      const width = arg(source, at);
      if (!width) return null;
      at = width.end;
    }
    const spec = arg(source, at);
    const end = source.lastIndexOf(`\\end{${env.value}}`);
    if (!spec || end < spec.end) return null;
    const columns = latexTableColumns(spec.value);
    if (!columns) return null;
    return {
      environment: env.value,
      from: spec.end,
      to: end,
      spec,
      columns,
      openingFrom: command.from,
      endingTo: end + `\\end{${env.value}}`.length,
    };
  }
  return null;
}

function split(source: string, separator: "&" | "\\\\", offset: number) {
  const ranges: LatexSourceRange[] = [];
  let start = 0,
    depth = 0,
    env = 0;
  for (let at = 0; at < source.length; at++) {
    if (source[at] === "%") {
      const end = source.indexOf("\n", at);
      if (end < 0) break;
      at = end;
    } else if (source[at] === "{") depth++;
    else if (source[at] === "}") depth--;
    else if (!depth && !env && source.startsWith(separator, at)) {
      ranges.push({ from: start + offset, to: at + offset });
      at += separator.length - 1;
      start = at + 1;
    } else if (source[at] === "\\") {
      const token = /^\\(begin|end)\{/u.exec(source.slice(at));
      if (token && !depth) env += token[1] === "begin" ? 1 : -1;
      at++;
    }
  }
  ranges.push({ from: start + offset, to: source.length + offset });
  return ranges;
}

function skipRowPrefix(source: string, range: LatexSourceRange) {
  let at = range.from;
  for (;;) {
    const trivia = /^(?:\s|%[^\r\n]*(?:\r?\n|$))*/u.exec(source.slice(at, range.to))![0];
    at += trivia.length;
    const token = /^\\(hline|toprule|midrule|bottomrule|cline|rowcolor|arrayrulecolor)\b/u.exec(
      source.slice(at),
    );
    if (!token) return at;
    at += token[0].length;
    if (["cline", "rowcolor", "arrayrulecolor"].includes(token[1]!)) {
      const value = arg(source, at);
      if (!value) return null;
      at = value.end;
    }
  }
}

export interface LatexTableBounds {
  firstRow: number;
  lastRow: number;
  firstColumn: number;
  lastColumn: number;
}
export type LatexTableAction =
  | { kind: "background" | "foreground"; scope: "cell" | "row" | "column" | "table"; color: string }
  | { kind: "stripes"; first: string; second: string; startRow: number }
  | { kind: "rule-color"; color: string }
  | {
      kind: "column";
      alignment: "left" | "center" | "right";
      width: string;
      wrapping: "natural" | "fixed" | "flexible";
    }
  | { kind: "rule"; edge: "above" | "below"; enabled: boolean }
  | { kind: "merge" | "split" }
  | { kind: "caption-position"; position: "above" | "below" }
  | { kind: "placement"; value: string }
  | { kind: "multipage" }
  | {
      kind: "row" | "column-structure";
      operation: "insert-before" | "insert-after" | "delete" | "previous" | "next";
    }
  | { kind: "repeat-header"; rows: number }
  | { kind: "continuation"; text: string };

function tableRows(source: string, shape: NonNullable<ReturnType<typeof latexTableSourceShape>>) {
  const parts =
    shape.environment === "longtable" ? longTableSections(source, shape.from, shape.to) : null;
  if (shape.environment === "longtable" && !parts) return null;
  const first = parts?.sections.get("firsthead") ?? parts?.sections.get("head");
  const bands = first
    ? [first, { from: parts!.bodyFrom, to: shape.to }]
    : [{ from: shape.from, to: shape.to }];
  return bands.flatMap((band, bandIndex) =>
    split(source.slice(band.from, band.to), "\\\\", band.from).flatMap((range) => {
      const from = skipRowPrefix(source, range);
      // A longtable caption owns a whole alignment row, independently of data cells.
      if (from === null || source.startsWith("\\caption", from)) return [];
      return source.slice(from, range.to).trim() || range.to < band.to
        ? [
            {
              ...range,
              contentFrom: from,
              band: bandIndex,
              cells: split(source.slice(from, range.to), "&", from),
            },
          ]
        : [];
    }),
  );
}

/** Structural controls use the same source grid as styling; colors do not make a table immutable. */
export function latexTableStructureEditable(source: string) {
  const shape = latexTableSourceShape(source);
  if (
    !shape ||
    /\\(?:multirow|multicolumn|rowcolor|endfirsthead|endhead|endfoot|endlastfoot)\b/u.test(
      source.slice(shape.from, shape.to),
    )
  )
    return false;
  const rows = tableRows(source, shape);
  return Boolean(
    rows?.length &&
    rows.every(
      (row) =>
        row.cells.length === shape.columns.length &&
        row.cells.every(
          (cell) => !/^\s*\\(?:input|include)\b/u.test(source.slice(cell.from, cell.to)),
        ),
    ),
  );
}

/** Owned-range operations retain every unrelated cell, caption, option and comment. */
export function editLatexTable(
  source: string,
  bounds: LatexTableBounds,
  action: LatexTableAction,
): { source: string } | { error: string } {
  const shape = latexTableSourceShape(source);
  const fail = (error: string) => ({ error });
  if (!shape) return fail("This column specification needs a Source edit.");
  const { columns } = shape;
  if (action.kind === "rule-color") {
    if (action.color && !latexColorCss(action.color))
      return fail("Choose a document color or a color mixture.");
    const patches: (LatexSourceRange & { value: string })[] = [];
    for (const command of latexSourceCommands(source))
      if (
        command.name === "arrayrulecolor" &&
        command.from >= shape.from &&
        command.from < shape.to
      ) {
        const color = arg(source, command.to);
        if (!color) return fail("This rule color has custom arguments. Edit it in Source.");
        patches.push({ from: command.from, to: color.end, value: "" });
      }
    const parts =
      shape.environment === "longtable" ? longTableSections(source, shape.from, shape.to) : null;
    const bands = parts?.sections.size
      ? [...parts.sections.values()]
      : [{ from: shape.from, to: shape.to }];
    const starts = new Set(
      bands.map((band) => {
        const caption = latexSourceCommands(source.slice(band.from, band.to)).find(
          (command) => command.name === "caption" && command.depth === 0,
        );
        if (!caption) return band.from;
        const at = band.from + caption.to;
        const option = arg(source, at, "[", "]");
        const title = arg(source, option?.end ?? at);
        const separator = title ? source.indexOf("\\\\", title.end) : -1;
        return separator >= 0 && separator < band.to ? separator + 2 : band.from;
      }),
    );
    if (action.color)
      for (const at of starts)
        patches.push({ from: at, to: at, value: `\n\\arrayrulecolor{${action.color}}\n` });
    const next = patchLatexSource(source, patches);
    return next === null ? fail("The table color ranges overlap.") : { source: next };
  }
  if (action.kind === "placement") {
    if (!/^[htbpH!]+$/u.test(action.value)) return fail("Choose a valid float placement.");
    const opening = /\\begin\{table\*?\}(?:\[[^\]]*\])?/u.exec(source);
    if (!opening) return fail("This table is not a float.");
    return {
      source:
        source.slice(0, opening.index) +
        opening[0].replace(/(?:\[[^\]]*\])?$/u, `[${action.value}]`) +
        source.slice(opening.index + opening[0].length),
    };
  }
  if (action.kind === "caption-position") {
    if (shape.environment === "longtable")
      return fail("Multipage captions belong to the first header.");
    const caption = latexSourceCommands(source).find((c) => c.name === "caption" && c.depth === 0);
    if (!caption) return fail("Add a caption on the page first.");
    const short = arg(source, caption.to, "[", "]");
    const title = arg(source, short?.end ?? caption.to);
    if (!title) return fail("This caption needs a Source edit.");
    let to = title.end;
    const labelCommand = /^\s*\\label/u.exec(source.slice(to));
    if (labelCommand) to = arg(source, to + labelCommand[0].length)?.end ?? to;
    const at = action.position === "above" ? shape.openingFrom : shape.endingTo;
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const next = patchLatexSource(source, [
      { from: caption.from, to, value: "" },
      { from: at, to: at, value: `${eol}${source.slice(caption.from, to)}${eol}` },
    ]);
    return next === null ? fail("The caption overlaps the table.") : { source: next };
  }
  if (action.kind === "column") {
    const column = columns[bounds.firstColumn];
    if (!column) return fail("Choose a column first.");
    if (action.wrapping === "flexible" && shape.environment !== "tabularx")
      return fail("Flexible columns need a Fit page table.");
    if (
      action.wrapping === "fixed" &&
      (!(parseFloat(action.width) > 0) ||
        !/^(?:\d+(?:\.\d+)?|\.\d+)(?:mm|cm|in|pt|em|\\linewidth)$/u.test(action.width.trim()))
    )
      return fail("Use a positive width such as 30mm or 0.3\\linewidth.");
    const letter = action.alignment === "center" ? "c" : action.alignment === "right" ? "r" : "l";
    const prefix =
      action.alignment === "center"
        ? "\\centering"
        : action.alignment === "right"
          ? "\\raggedleft"
          : "\\raggedright";
    const value =
      action.wrapping === "natural"
        ? letter
        : `>{${prefix}\\arraybackslash}${action.wrapping === "flexible" ? "X" : `p{${action.width.trim()}}`}`;
    // Remove only our known alignment modifier; retain colors and custom modifiers.
    let from = shape.spec.from + column.from;
    const before = source.slice(shape.spec.from, from);
    const alignment = />\{\\(?:centering|raggedleft|raggedright)\\arraybackslash\}\s*$/u.exec(
      before,
    );
    if (alignment) from -= alignment[0].length;
    return { source: source.slice(0, from) + value + source.slice(shape.spec.from + column.to) };
  }
  const rows = tableRows(source, shape);
  if (!rows?.length) return fail("This table's row source could not be resolved.");
  if (action.kind === "repeat-header" || action.kind === "continuation") {
    if (shape.environment !== "longtable")
      return fail("Convert the table to multipage before adding repeated bands.");
    const parts = longTableSections(source, shape.from, shape.to)!;
    if (action.kind === "continuation") {
      if (/[\\{}%#$&_^~]/u.test(action.text)) return fail("Use plain continuation text.");
      const foot = parts.sections.get("foot");
      const value = action.text
        ? `\n\\multicolumn{${columns.length}}{r}{${action.text}}\\\\\n`
        : "\n";
      if (foot) return { source: source.slice(0, foot.from) + value + source.slice(foot.to) };
      const last = parts.sections.get("lastfoot");
      const at = last?.from ?? parts.bodyFrom;
      return { source: source.slice(0, at) + value + "\\endfoot\n" + source.slice(at) };
    }
    if (
      !Number.isInteger(action.rows) ||
      action.rows < 1 ||
      action.rows > Math.min(rows.length, 10)
    )
      return fail("Choose an existing header row count between one and ten.");
    if (parts.sections.size) {
      const first = parts.sections.get("firsthead"),
        head = parts.sections.get("head");
      if (!first || !head)
        return fail(
          "This imported table has custom bands. Edit their contents directly or in Source.",
        );
      const selected = rows.slice(0, action.rows);
      if (selected.some((row) => row.band !== 0))
        return fail("Choose rows from the first header only.");
      const value = source.slice(selected[0]!.from, selected.at(-1)!.to + 2) + "\n";
      return { source: source.slice(0, head.from) + value + source.slice(head.to) };
    }
    const last = rows[action.rows - 1]!;
    if (!source.startsWith("\\\\", last.to))
      return fail("The header needs a terminating row break.");
    const at = last.to + 2;
    const header = source.slice(rows[0]!.from, at);
    return {
      source:
        source.slice(0, at) + "\n\\endfirsthead\n" + header + "\n\\endhead\n" + source.slice(at),
    };
  }
  if (
    bounds.firstRow < 0 ||
    bounds.lastRow < bounds.firstRow ||
    bounds.lastRow >= rows.length ||
    bounds.firstColumn < 0 ||
    bounds.lastColumn < bounds.firstColumn ||
    bounds.lastColumn >= columns.length
  )
    return fail("Select cells inside this table.");
  const grid = rows.map((row) => {
    let column = 0;
    const cells = row.cells.map((cell) => {
      let from = cell.from + /^\s*/u.exec(source.slice(cell.from, cell.to))![0].length;
      let to = cell.to - /\s*$/u.exec(source.slice(from, cell.to))![0].length;
      const start = from;
      let colSpan = 1,
        rowSpan = 1;
      for (const name of ["multicolumn", "multirow"]) {
        if (!source.startsWith(`\\${name}`, from)) continue;
        const count = arg(source, from + name.length + 1);
        const format = count && arg(source, count.end);
        const body = format && arg(source, format.end);
        if (!count || !body || body.end !== to || !/^\d+$/u.test(count.value)) return null;
        if (name === "multicolumn") colSpan = Number(count.value);
        else rowSpan = Number(count.value);
        from = body.from;
        to = body.to;
      }
      const result = { ...cell, bodyFrom: from, bodyTo: to, start, column, colSpan, rowSpan };
      column += colSpan;
      return result;
    });
    return column === columns.length && cells.every((cell) => cell !== null) ? cells : null;
  });
  if (!rows.length || grid.some((row) => row === null))
    return fail("This table has unsupported row structure. Keep its exact structure in Source.");
  const patches: (LatexSourceRange & { value: string })[] = [];
  if (action.kind === "row" || action.kind === "column-structure") {
    if (!latexTableStructureEditable(source))
      return fail("Split spans or edit custom table bands before reordering its grid.");
    if (action.kind === "row") {
      const index = bounds.firstRow,
        row = rows[index]!;
      if (action.operation.startsWith("insert")) {
        const at = action.operation === "insert-before" ? row.contentFrom : row.to;
        const empty = " & ".repeat(columns.length - 1);
        patches.push({
          from: at,
          to: at,
          value: action.operation === "insert-before" ? `${empty}\\\\\n` : `\\\\\n${empty}`,
        });
      } else if (action.operation === "delete") {
        if (rows.length <= 1) return fail("Keep at least one row.");
        const terminated = source.startsWith("\\\\", row.to);
        patches.push({ from: row.contentFrom, to: row.to + (terminated ? 2 : 0), value: "" });
      } else {
        const other = rows[index + (action.operation === "previous" ? -1 : 1)];
        if (!other || other.band !== row.band)
          return fail("This row cannot move beyond its table band.");
        patches.push(
          { from: row.contentFrom, to: row.to, value: source.slice(other.contentFrom, other.to) },
          { from: other.contentFrom, to: other.to, value: source.slice(row.contentFrom, row.to) },
        );
      }
    } else {
      if (/[<>@!]/u.test(shape.spec.value))
        return fail(
          "This column specification has custom modifiers. Its content and widths remain editable.",
        );
      const index = bounds.firstColumn,
        column = columns[index]!;
      if (action.operation.startsWith("insert")) {
        const before = action.operation === "insert-before";
        const at = shape.spec.from + (before ? column.from : column.to);
        patches.push({ from: at, to: at, value: "l" });
        for (const row of rows) {
          const cell = row.cells[index]!;
          const at = before ? cell.from : cell.to;
          patches.push({ from: at, to: at, value: " & " });
        }
      } else if (action.operation === "delete") {
        if (columns.length <= 1) return fail("Keep at least one column.");
        patches.push({
          from: shape.spec.from + column.from,
          to: shape.spec.from + column.to,
          value: "",
        });
        for (const row of rows) {
          const cell = row.cells[index]!;
          patches.push({
            from: index === 0 ? cell.from : cell.from - 1,
            to: index === 0 ? cell.to + 1 : cell.to,
            value: "",
          });
        }
      } else {
        const other = index + (action.operation === "previous" ? -1 : 1),
          target = columns[other];
        if (!target) return fail("This column is already at the table edge.");
        patches.push(
          {
            from: shape.spec.from + column.from,
            to: shape.spec.from + column.to,
            value: shape.spec.value.slice(target.from, target.to),
          },
          {
            from: shape.spec.from + target.from,
            to: shape.spec.from + target.to,
            value: shape.spec.value.slice(column.from, column.to),
          },
        );
        for (const row of rows) {
          const a = row.cells[index]!,
            b = row.cells[other]!;
          patches.push(
            { ...a, value: source.slice(b.from, b.to) },
            { ...b, value: source.slice(a.from, a.to) },
          );
        }
      }
      if (/\\(?:cline|cmidrule)\b/u.test(source.slice(shape.from, shape.to)))
        return fail("Remove partial rules before changing the column order or count.");
    }
  } else if (
    action.kind === "background" ||
    action.kind === "foreground" ||
    action.kind === "stripes"
  ) {
    const stripe = action.kind === "stripes";
    if (
      (stripe ? [action.first, action.second] : [action.color]).some(
        (color) => color && !latexColorCss(color),
      )
    )
      return fail("Choose a document color or a mixture such as blue!10.");
    if (
      stripe &&
      (!Number.isInteger(action.startRow) || action.startRow < 0 || action.startRow >= rows.length)
    )
      return fail("Choose a starting row inside the table.");
    if (stripe && grid.some((row) => row!.some((cell) => cell && cell.rowSpan > 1)))
      return fail("Set colors on merged rows individually.");
    for (const [r, cells] of grid.entries())
      for (const cell of cells!) {
        if (!cell) continue;
        const inRows = r >= bounds.firstRow && r <= bounds.lastRow;
        const inColumns =
          cell.column <= bounds.lastColumn && cell.column + cell.colSpan - 1 >= bounds.firstColumn;
        if (
          stripe
            ? r < action.startRow
            : !(
                action.scope === "table" ||
                (action.scope === "row"
                  ? inRows
                  : action.scope === "column"
                    ? inColumns
                    : inRows && inColumns)
              )
        )
          continue;
        const color = stripe
          ? (r - action.startRow) % 2 === 0
            ? action.first
            : action.second
          : action.color;
        let body = source.slice(cell.bodyFrom, cell.bodyTo);
        const prefix = /^\s*/u.exec(body)![0],
          suffix = /\s*$/u.exec(body)![0];
        body = body.trim();
        if (action.kind === "background" || stripe) {
          body = body.replace(/^\\cellcolor\{[^{}]*\}\s*/u, "");
          if (color) body = `\\cellcolor{${color}}${body}`;
        } else {
          const background = /^\\cellcolor\{[^{}]*\}\s*/u.exec(body)?.[0] ?? "";
          body = body.slice(background.length);
          const colorCommand = /^\\textcolor\{[^{}]*\}/u.exec(body);
          const text = colorCommand && arg(body, colorCommand[0].length);
          if (text?.end === body.length) body = text.value;
          if (color) body = `\\textcolor{${color}}{${body}}`;
          body = background + body;
        }
        patches.push({ from: cell.bodyFrom, to: cell.bodyTo, value: prefix + body + suffix });
      }
  } else if (action.kind === "rule") {
    const row = action.edge === "above" ? bounds.firstRow : bounds.lastRow + 1;
    const last = rows[bounds.lastRow]!;
    const nextRow = rows[row];
    const atBandEnd = action.edge === "below" && (!nextRow || nextRow.band !== last.band);
    const terminated = source.startsWith("\\\\", last.to);
    const from = atBandEnd ? last.to + (terminated ? 2 : 0) : nextRow!.from;
    const bands =
      shape.environment === "longtable" ? longTableSections(source, shape.from, shape.to) : null;
    const to = atBandEnd
      ? last.band === 0
        ? ((bands?.sections.get("firsthead") ?? bands?.sections.get("head"))?.to ?? shape.to)
        : shape.to
      : nextRow!.contentFrom;
    const old = source.slice(from, to);
    const coverage = Array.from({ length: columns.length }, () => false);
    for (const match of old.matchAll(
      /\\(hline|toprule|midrule|bottomrule)\b|\\cline\{(\d+)-(\d+)\}/gu,
    )) {
      const start = match[1] ? 0 : Number(match[2]) - 1,
        end = match[1] ? columns.length : Number(match[3]);
      for (let c = start; c < end; c++) coverage[c] = true;
    }
    if (action.enabled && coverage.slice(bounds.firstColumn, bounds.lastColumn + 1).every(Boolean))
      return { source };
    for (let c = bounds.firstColumn; c <= bounds.lastColumn; c++) coverage[c] = action.enabled;
    const clean = old.replace(/\\(?:hline|toprule|midrule|bottomrule)\b|\\cline\{\d+-\d+\}/gu, "");
    let rules = "";
    for (let c = 0; c < coverage.length; c++)
      if (coverage[c]) {
        const first = c;
        while (coverage[c + 1]) c++;
        rules += `\\cline{${first + 1}-${c + 1}}`;
      }
    const value =
      (atBandEnd && !terminated && rules ? "\\\\" : "") + clean + rules + (rules ? "\n" : "");
    patches.push({ from, to, value });
  } else if (action.kind === "merge") {
    if (rows[bounds.firstRow]!.band !== rows[bounds.lastRow]!.band)
      return fail("A merged cell must stay within one table band.");
    if (
      grid
        .slice(bounds.firstRow, bounds.lastRow + 1)
        .some((row) =>
          row!.some(
            (cell) =>
              cell &&
              cell.colSpan > 1 &&
              cell.column <= bounds.lastColumn &&
              cell.column + cell.colSpan > bounds.firstColumn,
          ),
        )
    )
      return fail("Split existing column spans before merging this selection.");
    if (
      grid.some(
        (row, index) =>
          index <= bounds.lastRow &&
          row!.some(
            (cell) =>
              cell &&
              cell.rowSpan > 1 &&
              index + cell.rowSpan > bounds.firstRow &&
              cell.column <= bounds.lastColumn &&
              cell.column + cell.colSpan > bounds.firstColumn,
          ),
      )
    )
      return fail("Split existing row spans before merging this selection.");
    if (bounds.firstColumn === bounds.lastColumn && bounds.firstRow === bounds.lastRow)
      return fail("Select two or more adjacent cells first.");
    const cells = grid[bounds.firstRow]!.filter(
      (cell) => cell && cell.column >= bounds.firstColumn && cell.column <= bounds.lastColumn,
    );
    const first = cells[0]!,
      last = cells.at(-1)!;
    const selected = grid
      .slice(bounds.firstRow, bounds.lastRow + 1)
      .flatMap((row) =>
        row!.filter(
          (cell) => cell && cell.column >= bounds.firstColumn && cell.column <= bounds.lastColumn,
        ),
      );
    const contents = selected
      .map((cell) => source.slice(cell!.from, cell!.to).trim())
      .filter(Boolean);
    if (contents.some((text) => /\\(?:multirow|multicolumn)\b/u.test(text)))
      return fail("Split existing spans before merging again.");
    const backgrounds = new Set(
      contents.map((text) => /^\\cellcolor\{([^{}]+)\}/u.exec(text)?.[1] ?? ""),
    );
    if (backgrounds.size > 1)
      return fail("Set the same background on the selected cells before merging them.");
    const background = [...backgrounds][0];
    let body =
      (background ? `\\cellcolor{${background}}` : "") +
      contents.map((text) => text.replace(/^\\cellcolor\{[^{}]+\}/u, "")).join(" ");
    const height = bounds.lastRow - bounds.firstRow + 1;
    if (height > 1) body = `\\multirow{${height}}{*}{${body}}`;
    const left = columns[bounds.firstColumn]!.left ? "|" : "",
      right = columns[bounds.lastColumn]!.right ? "|" : "";
    const width = bounds.lastColumn - bounds.firstColumn + 1;
    patches.push({
      from: first.from,
      to: last.to,
      value: width > 1 ? `\\multicolumn{${width}}{${left}c${right}}{${body}}` : body,
    });
    for (let r = bounds.firstRow + 1; r <= bounds.lastRow; r++) {
      const rowCells = grid[r]!.filter(
        (cell) => cell && cell.column >= bounds.firstColumn && cell.column <= bounds.lastColumn,
      );
      patches.push({
        from: rowCells[0]!.from,
        to: rowCells.at(-1)!.to,
        value: " & ".repeat(width - 1),
      });
      const row = rows[r]!;
      const rules = source.slice(row.from, row.contentFrom);
      if (/\\(?:hline|midrule|cline)\b/u.test(rules)) {
        const outside =
          (bounds.firstColumn ? `\\cline{1-${bounds.firstColumn}}` : "") +
          (bounds.lastColumn < columns.length - 1
            ? `\\cline{${bounds.lastColumn + 2}-${columns.length}}`
            : "");
        patches.push({
          from: row.from,
          to: row.contentFrom,
          value: rules.replace(/\\(?:hline|midrule)\b|\\cline\{\d+-\d+\}/gu, "") + outside,
        });
      }
    }
  } else if (action.kind === "split") {
    const cell = grid[bounds.firstRow]?.find(
      (cell) =>
        cell &&
        cell.column <= bounds.firstColumn &&
        cell.column + cell.colSpan > bounds.firstColumn,
    );
    if (!cell || (cell.colSpan === 1 && cell.rowSpan === 1))
      return fail("Choose a merged cell to split.");
    patches.push({
      from: cell.from,
      to: cell.to,
      value: source.slice(cell.bodyFrom, cell.bodyTo) + " & ".repeat(cell.colSpan - 1),
    });
  } else if (action.kind === "multipage") {
    if (shape.environment !== "tabular")
      return fail(
        "Convert a Fit content table to multipage first; flexible columns need fixed widths.",
      );
    let next = source
      .slice(shape.openingFrom, shape.endingTo)
      .replace(/\\begin\{tabular\}/u, "\\begin{longtable}")
      .replace(/\\end\{tabular\}$/u, "\\end{longtable}");
    const outside = source.slice(0, shape.openingFrom) + source.slice(shape.endingTo);
    const caption =
      /\\caption(?:\[[^\]]*\])?\{[^{}]*\}(?:\s*\\label\{[^{}]*\})?/u.exec(outside)?.[0] ?? "";
    if (
      outside
        .replace(/\\begin\{table\}(?:\[[^\]]*\])?|\\end\{table\}|\\centering/gu, "")
        .replace(caption, "")
        .trim()
    )
      return fail("This float contains additional source. Keep its structure in Source.");
    if (caption) {
      const converted = latexTableSourceShape(next)!;
      next = next.slice(0, converted.from) + `\n${caption}\\\\\n` + next.slice(converted.from);
    }
    return { source: next };
  }
  const next = patchLatexSource(source, patches);
  return next === null ? fail("The selected ranges overlap.") : { source: next };
}
