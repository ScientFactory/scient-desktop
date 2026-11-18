// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStreamConsumers from "node:stream/consumers";

import { afterEach, describe, expect, it } from "vite-plus/test";
import * as yazl from "yazl";

import { readWorkbookSheet } from "./WorkbookTableSource.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) NodeFS.rmSync(directory, { recursive: true });
});

async function writeArchive(name: string, parts: Record<string, string>): Promise<string> {
  const zip = new yazl.ZipFile();
  for (const [part, xml] of Object.entries(parts)) zip.addBuffer(Buffer.from(xml), part);
  zip.end();
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-workbook-"));
  tempDirs.push(directory);
  const path = NodePath.join(directory, name);
  NodeFS.writeFileSync(path, await NodeStreamConsumers.buffer(zip.outputStream));
  return path;
}

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

function xlsx(sheetViews: ReadonlyArray<string>) {
  return writeArchive("book.xlsx", {
    "xl/workbook.xml": `<workbook xmlns="${MAIN}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetViews
      .map(
        (_, index) => `<sheet name="S${index + 1}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
      )
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetViews
      .map(
        (_, index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
      )
      .join("")}</Relationships>`,
    ...Object.fromEntries(
      sheetViews.map((view, index) => [
        `xl/worksheets/sheet${index + 1}.xml`,
        `<worksheet xmlns="${MAIN}"><sheetViews>${view}</sheetViews><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row></sheetData></worksheet>`,
      ]),
    ),
  });
}

describe("readWorkbookSheet", () => {
  it("reads each xlsx sheet's direction from its sheet view", async () => {
    const path = await xlsx([
      '<sheetView rightToLeft="1" workbookViewId="0"/>',
      '<sheetView workbookViewId="0"/>',
      '<sheetView rightToLeft="true" workbookViewId="0"/>',
      '<sheetView workbookViewId="0"/><sheetView rightToLeft="1" workbookViewId="1"/>',
    ]);
    const directions = await Promise.all(
      [0, 1, 2, 3].map(async (sheet) => (await readWorkbookSheet(path, "xlsx", sheet)).rightToLeft),
    );
    expect(directions).toEqual([true, false, true, false]);
  });

  it("reads an ods table's direction from its table style", async () => {
    const path = await writeArchive("book.ods", {
      mimetype: "application/vnd.oasis.opendocument.spreadsheet",
      "content.xml": `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:automatic-styles><style:style style:name="ta1" style:family="table"><style:table-properties style:writing-mode="rl-tb"/></style:style><style:style style:name="ta2" style:family="table"><style:table-properties style:writing-mode="lr-tb"/></style:style></office:automatic-styles><office:body><office:spreadsheet><table:table table:name="R" table:style-name="ta1"><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell></table:table-row></table:table><table:table table:name="L" table:style-name="ta2"><table:table-row><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`,
    });
    expect((await readWorkbookSheet(path, "ods", 0)).rightToLeft).toBe(true);
    expect((await readWorkbookSheet(path, "ods", 1)).rightToLeft).toBe(false);
  });
});
