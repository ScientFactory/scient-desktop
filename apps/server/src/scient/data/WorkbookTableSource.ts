import { dataTableCellText, type DataTableColumn } from "@scientfactory/compute";
import { SaxesParser, type SaxesTagPlain } from "saxes";
import * as Yauzl from "yauzl";

import { formatDate, inferTextColumnType } from "./cellText.ts";
import type { SortKeys, TableSource } from "./TableView.ts";

/** Workbooks are read whole, so a sheet is bounded by cells rather than bytes. */
const MAX_CELLS = 4_000_000;
const MAX_COLUMNS = 16_384;
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
const SAMPLE_ROWS = 1000;

export class WorkbookFormatError extends Error {}

export interface WorkbookSheet {
  readonly sheets: ReadonlyArray<string>;
  readonly rows: Array<Array<string | null>>;
  readonly truncated: boolean;
}

/** Collects rows, skipping empty runs unless content follows them. */
class SheetRows {
  readonly rows: Array<Array<string | null>> = [];
  truncated = false;
  private cells = 0;
  private pendingRows = 0;
  private row: Array<string | null> = [];
  private pendingCells = 0;

  cell(value: string | null, repeat = 1) {
    if (value === null || value === "") {
      this.pendingCells += repeat;
      return;
    }
    for (let copy = 0; copy < repeat && this.row.length < MAX_COLUMNS; copy++) {
      while (this.pendingCells > 0 && this.row.length < MAX_COLUMNS) {
        this.row.push(null);
        this.pendingCells--;
      }
      this.row.push(value);
    }
    this.pendingCells = 0;
  }

  /** Places the next cell at a zero-based column, as `r="C7"` does. */
  at(column: number) {
    this.pendingCells = Math.max(0, column - this.row.length);
  }

  endRow(repeat = 1) {
    const row = this.row;
    this.row = [];
    this.pendingCells = 0;
    if (row.length === 0) {
      this.pendingRows += repeat;
      return;
    }
    for (let copy = 0; copy < repeat; copy++) {
      for (; this.pendingRows > 0; this.pendingRows--) this.push([]);
      this.push(copy === 0 ? row : [...row]);
    }
  }

  /** Moves to a one-based row number, as `<row r="12">` does. */
  rowAt(number: number) {
    this.pendingRows = Math.max(0, number - 1 - this.rows.length);
  }

  private push(row: Array<string | null>) {
    if (this.truncated) return;
    this.cells += Math.max(1, row.length);
    if (this.cells > MAX_CELLS) this.truncated = true;
    else this.rows.push(row);
  }
}

interface Archive {
  readonly entry: (name: string) => Yauzl.Entry | undefined;
  readonly parse: (entry: Yauzl.Entry, parser: SaxesParser) => Promise<void>;
  readonly close: () => void;
}

function openArchive(path: string): Promise<Archive> {
  return new Promise((resolve, reject) => {
    Yauzl.open(path, { lazyEntries: true, autoClose: false }, (openError, zip) => {
      if (openError || !zip) return reject(new WorkbookFormatError("Not a valid workbook."));
      const entries = new Map<string, Yauzl.Entry>();
      zip.on("error", () => reject(new WorkbookFormatError("Not a valid workbook.")));
      zip.on("entry", (entry: Yauzl.Entry) => {
        entries.set(entry.fileName, entry);
        zip.readEntry();
      });
      zip.on("end", () =>
        resolve({
          entry: (name) => entries.get(name),
          close: () => zip.close(),
          parse: (entry, parser) =>
            new Promise((done, fail) => {
              if (entry.uncompressedSize > MAX_ENTRY_BYTES)
                return fail(new WorkbookFormatError("This workbook is too large to open."));
              zip.openReadStream(entry, (streamError, stream) => {
                if (streamError || !stream)
                  return fail(new WorkbookFormatError("Not a valid workbook."));
                const decoder = new TextDecoder("utf-8");
                stream.on("data", (bytes: Uint8Array) => {
                  try {
                    parser.write(decoder.decode(bytes, { stream: true }));
                  } catch (cause) {
                    stream.destroy();
                    fail(cause);
                  }
                });
                stream.on("error", () => fail(new WorkbookFormatError("Not a valid workbook.")));
                stream.on("end", () => {
                  try {
                    parser.close();
                    done();
                  } catch (cause) {
                    fail(cause);
                  }
                });
              });
            }),
        }),
      );
      zip.readEntry();
    });
  });
}

const localName = (name: string) => name.slice(name.indexOf(":") + 1);

function columnIndex(reference: string): number {
  let column = 0;
  for (const char of reference) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    column = column * 26 + code - 64;
  }
  return column - 1;
}

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57,
]);

function isDateFormat(code: string): boolean {
  const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
  return bare.toLowerCase() !== "general" && /[dmyhs]/i.test(bare);
}

/** Excel serials count days from 1899-12-30 (or 1904-01-01) in local wall time. */
function serialDate(serial: number, date1904: boolean, withTime: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Math.round(serial * 86_400_000));
  if (serial < 1 && serial >= 0 && withTime) return formatDate(date, true).slice(11);
  return formatDate(date, withTime && serial % 1 !== 0);
}

async function readXlsx(path: string, sheet: number): Promise<WorkbookSheet> {
  const archive = await openArchive(path);
  try {
    const part = (name: string) => archive.entry(name);
    const workbookEntry = part("xl/workbook.xml");
    if (!workbookEntry) throw new WorkbookFormatError("Not a valid workbook.");
    const sheets: Array<{ name: string; relation: string }> = [];
    let date1904 = false;
    const workbook = new SaxesParser();
    workbook.on("opentag", (tag: SaxesTagPlain) => {
      const name = localName(tag.name);
      if (name === "workbookPr") date1904 = /^(?:1|true)$/.test(String(tag.attributes.date1904));
      if (name === "sheet")
        sheets.push({
          name: String(tag.attributes.name ?? `Sheet ${sheets.length + 1}`),
          relation: String(tag.attributes["r:id"] ?? ""),
        });
    });
    await archive.parse(workbookEntry, workbook);

    const targets = new Map<string, string>();
    const relationsEntry = part("xl/_rels/workbook.xml.rels");
    if (relationsEntry) {
      const relations = new SaxesParser();
      relations.on("opentag", (tag: SaxesTagPlain) => {
        if (localName(tag.name) !== "Relationship") return;
        const target = String(tag.attributes.Target ?? "");
        targets.set(
          String(tag.attributes.Id ?? ""),
          target.startsWith("/") ? target.slice(1) : `xl/${target}`,
        );
      });
      await archive.parse(relationsEntry, relations);
    }

    const dateStyles: boolean[] = [];
    const stylesEntry = part("xl/styles.xml");
    if (stylesEntry) {
      const formats = new Map<number, string>();
      let inCellFormats = false;
      const styles = new SaxesParser();
      styles.on("opentag", (tag: SaxesTagPlain) => {
        const name = localName(tag.name);
        if (name === "numFmt")
          formats.set(Number(tag.attributes.numFmtId), String(tag.attributes.formatCode ?? ""));
        else if (name === "cellXfs") inCellFormats = true;
        else if (name === "xf" && inCellFormats) {
          const id = Number(tag.attributes.numFmtId ?? 0);
          const code = formats.get(id);
          dateStyles.push(code === undefined ? BUILTIN_DATE_FORMATS.has(id) : isDateFormat(code));
        }
      });
      styles.on("closetag", (tag) => {
        if (localName(tag.name) === "cellXfs") inCellFormats = false;
      });
      await archive.parse(stylesEntry, styles);
    }

    const strings: string[] = [];
    const stringsEntry = part("xl/sharedStrings.xml");
    if (stringsEntry) {
      let current = "";
      let inText = false;
      let phonetic = false;
      const parser = new SaxesParser();
      parser.on("opentag", (tag: SaxesTagPlain) => {
        const name = localName(tag.name);
        if (name === "si") current = "";
        else if (name === "rPh") phonetic = true;
        else if (name === "t") inText = !phonetic;
      });
      parser.on("closetag", (tag) => {
        const name = localName(tag.name);
        if (name === "si") strings.push(current);
        else if (name === "rPh") phonetic = false;
        else if (name === "t") inText = false;
      });
      parser.on("text", (text) => {
        if (inText) current += text;
      });
      await archive.parse(stringsEntry, parser);
    }

    const chosen = sheets[sheet];
    const sheetEntry = chosen ? part(targets.get(chosen.relation) ?? "") : undefined;
    if (!chosen || !sheetEntry) throw new WorkbookFormatError("This sheet could not be found.");
    const rows = new SheetRows();
    let type = "n";
    let style = 0;
    let value = "";
    let inValue = false;
    const parser = new SaxesParser();
    parser.on("opentag", (tag: SaxesTagPlain) => {
      const name = localName(tag.name);
      if (name === "row") {
        if (tag.attributes.r !== undefined) rows.rowAt(Number(tag.attributes.r));
      } else if (name === "c") {
        type = String(tag.attributes.t ?? "n");
        style = Number(tag.attributes.s ?? 0);
        value = "";
        if (tag.attributes.r !== undefined) rows.at(columnIndex(String(tag.attributes.r)));
      } else if (name === "v" || (name === "t" && type === "inlineStr")) inValue = true;
    });
    parser.on("text", (text) => {
      if (inValue) value += text;
    });
    parser.on("closetag", (tag) => {
      const name = localName(tag.name);
      if (name === "v" || name === "t") inValue = false;
      else if (name === "row") rows.endRow();
      else if (name === "c") {
        if (value === "") rows.cell(null);
        else if (type === "s") rows.cell(strings[Number(value)] ?? "");
        else if (type === "b") rows.cell(value === "1" ? "true" : "false");
        else if (type === "n" && dateStyles[style]) rows.cell(serialDate(Number(value), date1904, true));
        else if (type === "d") rows.cell(value.replace("T", " ").replace(/(?: 00:00:00)?(?:\.000)?Z?$/, ""));
        else rows.cell(value);
      }
    });
    await archive.parse(sheetEntry, parser);
    return { sheets: sheets.map((item) => item.name), rows: rows.rows, truncated: rows.truncated };
  } finally {
    archive.close();
  }
}

async function readOds(path: string, sheet: number): Promise<WorkbookSheet> {
  const archive = await openArchive(path);
  try {
    const content = archive.entry("content.xml");
    if (!content) throw new WorkbookFormatError("Not a valid workbook.");
    const sheets: string[] = [];
    const rows = new SheetRows();
    let inSheet = false;
    let depth = 0;
    let cell: { value: string | null; text: string; repeat: number } | null = null;
    let paragraphs = 0;
    let annotation = 0;
    let rowRepeat = 1;
    const parser = new SaxesParser();
    parser.on("opentag", (tag: SaxesTagPlain) => {
      const name = tag.name;
      const attribute = (key: string) => tag.attributes[key] as string | undefined;
      if (name === "table:table") {
        depth++;
        if (depth === 1) {
          inSheet = sheets.length === sheet;
          sheets.push(attribute("table:name") ?? `Sheet ${sheets.length + 1}`);
        }
      }
      if (!inSheet || depth !== 1) return;
      if (name === "table:table-row")
        rowRepeat = Number(attribute("table:number-rows-repeated") ?? 1);
      else if (name === "table:table-cell" || name === "table:covered-table-cell") {
        const type = attribute("office:value-type");
        const value =
          type === "float" || type === "percentage" || type === "currency"
            ? (attribute("office:value") ?? null)
            : type === "date"
              ? (attribute("office:date-value")?.replace("T", " ").replace(/ 00:00:00$/, "") ?? null)
              : type === "boolean"
                ? (attribute("office:boolean-value") ?? null)
                : null;
        cell = { value, text: "", repeat: Number(attribute("table:number-columns-repeated") ?? 1) };
        paragraphs = 0;
      } else if (name === "office:annotation") annotation++;
      else if (cell && annotation === 0) {
        if (name === "text:p" && paragraphs++ > 0) cell.text += "\n";
        else if (name === "text:s") cell.text += " ".repeat(Number(attribute("text:c") ?? 1));
        else if (name === "text:tab") cell.text += "\t";
        else if (name === "text:line-break") cell.text += "\n";
      }
    });
    parser.on("text", (text) => {
      if (cell && annotation === 0) cell.text += text;
    });
    parser.on("closetag", (tag) => {
      const name = tag.name;
      if (name === "table:table") {
        depth--;
        if (depth === 0) inSheet = false;
      }
      if (!inSheet || depth !== 1) return;
      if (name === "office:annotation") annotation--;
      else if ((name === "table:table-cell" || name === "table:covered-table-cell") && cell) {
        rows.cell(cell.value ?? cell.text, Math.min(cell.repeat, MAX_COLUMNS));
        cell = null;
      } else if (name === "table:table-row") rows.endRow(rowRepeat);
    });
    await archive.parse(content, parser);
    if (sheet >= sheets.length) throw new WorkbookFormatError("This sheet could not be found.");
    return { sheets, rows: rows.rows, truncated: rows.truncated };
  } finally {
    archive.close();
  }
}

export function readWorkbookSheet(
  path: string,
  format: "xlsx" | "ods",
  sheet: number,
): Promise<WorkbookSheet> {
  return format === "xlsx" ? readXlsx(path, sheet) : readOds(path, sheet);
}

/** A sheet held in memory, its first non-empty row naming the columns. */
export function workbookTableSource(sheet: WorkbookSheet): TableSource {
  const start = sheet.rows.findIndex((row) => row.length > 0);
  const [header = [], ...rows] = start < 0 ? [] : sheet.rows.slice(start);
  const width = rows.reduce((max, row) => Math.max(max, row.length), header.length);
  const sample = rows.slice(0, SAMPLE_ROWS);
  const columns: DataTableColumn[] = Array.from({ length: width }, (_, column) => ({
    name: header[column] || `Column ${column + 1}`,
    ...inferTextColumnType(sample.map((row) => row[column] ?? undefined)),
  }));
  return {
    columns,
    rowCount: rows.length,
    truncated: sheet.truncated,
    readRows: async (indices, columnLimit) =>
      indices.map((index) =>
        Array.from({ length: Math.min(columnLimit, width) }, (_, column) => {
          const value = rows[index]![column];
          return value == null ? null : dataTableCellText(value);
        }),
      ),
    sortKeys: async (column): Promise<SortKeys> => {
      const type = columns[column]!.type;
      if (type === "integer" || type === "number")
        return Float64Array.from(rows, (row) => {
          const value = row[column];
          return value ? Number(value) : Number.NaN;
        });
      return rows.map((row) => row[column] || null);
    },
    search: async (needle) => {
      const matches: number[] = [];
      rows.forEach((row, index) => {
        if (row.some((value) => value?.toLowerCase().includes(needle))) matches.push(index);
      });
      return Uint32Array.from(matches);
    },
  };
}
