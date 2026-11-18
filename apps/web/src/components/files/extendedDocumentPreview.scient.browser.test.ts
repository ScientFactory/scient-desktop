import JSZip from "jszip";
import { expect, it } from "vite-plus/test";

import { sanitizeDocumentHtml } from "./DocumentPages";
import { openDocument } from "./extendedDocumentPreview";

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';

it("keeps the writing mode of ODF paragraph styles, set or inherited", async () => {
  const archive = new JSZip()
    .file(
      "styles.xml",
      `<office:document-styles ${NS}><office:styles><style:style style:name="Body" style:family="paragraph"><style:paragraph-properties style:writing-mode="rl-tb"/></style:style></office:styles></office:document-styles>`,
    )
    .file(
      "content.xml",
      `<office:document-content ${NS}><office:automatic-styles><style:style style:name="Body" style:family="text"><style:text-properties/></style:style><style:style style:name="P1" style:family="paragraph" style:parent-style-name="Body"/><style:style style:name="P2" style:family="paragraph"><style:paragraph-properties style:writing-mode="lr-tb"/></style:style></office:automatic-styles><office:body><office:text><text:p text:style-name="P1">שלום</text:p><text:p text:style-name="P2">Hello</text:p><text:p>plain</text:p></office:text></office:body></office:document-content>`,
    );
  const result = await openDocument(archive, "odt");
  if (result.type !== "document") throw new Error("Expected document");
  const doc = new DOMParser().parseFromString(
    sanitizeDocumentHtml(result.pages[0]!.html),
    "text/html",
  );
  expect([...doc.querySelectorAll("p")].map((p) => p.getAttribute("dir"))).toEqual([
    "rtl",
    "ltr",
    null,
  ]);
});

it("previews an ODF document whose styles part cannot be read", async () => {
  const archive = new JSZip()
    .file("styles.xml", "<office:document-styles")
    .file(
      "content.xml",
      `<office:document-content ${NS}><office:body><office:text><text:p>Hello</text:p></office:text></office:body></office:document-content>`,
    );
  const result = await openDocument(archive, "odt");
  if (result.type !== "document") throw new Error("Expected document");
  expect(result.pages[0]!.html).toContain("Hello");
});
