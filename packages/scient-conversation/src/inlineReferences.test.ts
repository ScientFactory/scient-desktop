import type { ComposerContextId, ComposerContextRecord } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectInlineReferences } from "./inlineReferences.ts";
import { SCIENT_ASSET_URL_PLACEHOLDER } from "./storagePaths.ts";

const ctx = (value: string) => value as ComposerContextId;

describe("protected browser references", () => {
  it("does not carry a signed asset URL into a projected element or annotation", () => {
    const token = "eyJwYXRoIjoiL3NlY3JldC9wYXRoIn0.signature";
    const pageUrl = `http://127.0.0.1:3773/api/assets/${token}/report.html`;
    const records: ReadonlyArray<ComposerContextRecord> = [
      {
        version: 1,
        contextId: ctx("ctx_e"),
        kind: "element",
        label: "Button",
        pageUrl,
        pageTitle: pageUrl,
        tagName: "button",
        selector: "#run",
        htmlPreview: "<button id=run>Run</button>",
        componentName: null,
        source: null,
        styles: "",
      },
      {
        version: 1,
        contextId: ctx("ctx_a"),
        kind: "preview-annotation",
        label: "Preview",
        annotationId: "a1",
        pageUrl,
        pageTitle: pageUrl,
        comment: "Check this",
        targetSummary: "button",
        styleChanges: [],
        elements: [],
      },
    ];
    const result = projectInlineReferences({
      text: "[Button](t3-context://v1/element/ctx_e) [Preview](t3-context://v1/preview-annotation/ctx_a)",
      records,
      attachments: [],
      roots: [],
    });
    expect(result.references).toHaveLength(2);
    for (const reference of result.references) {
      expect(reference).toMatchObject({
        pageUrl: SCIENT_ASSET_URL_PLACEHOLDER,
        pageTitle: SCIENT_ASSET_URL_PLACEHOLDER,
      });
      expect(JSON.stringify(reference)).not.toContain(token);
    }
  });
});
