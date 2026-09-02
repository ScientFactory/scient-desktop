import { describe, expect, it } from "vite-plus/test";

import {
  findRtlFlowArrowSpans,
  normalizeRtlFlowArrows,
  resolveAggregateDirection,
  resolveDominantDirection,
  resolveFenceDirection,
  resolveMarkdownDirectionHint,
  resolveMarkdownDirection,
  resolvePlainTextBoxDirection,
  resolveProseBlockDirection,
  resolveStreamingMarkdownDirection,
  resolveTableCellDirection,
} from "./contentDirection";

describe("message and block direction", () => {
  it("keeps a Hebrew message RTL when list items begin with English terms", () => {
    const markdown = [
      "### מעבדה וסרולוגיה",
      "",
      "- **RF** — רגיש, פחות ספציפי",
      "- **Anti-CCP** — ספציפי מאוד",
      "- CRP/ESR — מוגברים",
    ].join("\n");

    expect(resolveMarkdownDirection(markdown, "auto")).toBe("rtl");
  });

  it("ignores fenced source code while resolving message direction", () => {
    const markdown = ["```ts", "const result = await fetch(url);", "```", "", "שלום עולם"].join(
      "\n",
    );

    expect(resolveMarkdownDirection(markdown, "auto")).toBe("rtl");
  });

  it("keeps an English-only message LTR", () => {
    expect(
      resolveMarkdownDirection("## Methods and Results\n\n- Mean\n- Standard deviation", "auto"),
    ).toBe("ltr");
  });

  it("allows only unambiguous blocks to override the message base", () => {
    expect(resolveProseBlockDirection("Methods and Results", "rtl")).toBe("ltr");
    expect(resolveProseBlockDirection("RF — רגיש מאוד", "rtl")).toBe("rtl");
    expect(resolveProseBlockDirection("Methods — שיטות", "rtl")).toBe("rtl");
  });

  it("keeps a mixed list RTL when any list item contains RTL prose", () => {
    expect(resolveAggregateDirection("Standard deviation\nCRP/ESR — מוגברים", "ltr")).toBe("rtl");
  });

  it("makes English-only groups LTR and leaves empty groups at their fallback", () => {
    expect(resolveAggregateDirection("Standard deviation\nConfidence interval", "rtl")).toBe("ltr");
    expect(resolveAggregateDirection("123 — —", "rtl")).toBe("rtl");
  });

  it("uses the dominant language for tables and the surrounding direction only for ties", () => {
    expect(resolveDominantDirection("English details שלום", "rtl")).toBe("ltr");
    expect(resolveDominantDirection("English שלום עולם נוסף", "ltr")).toBe("rtl");
    expect(resolveDominantDirection("ab אב", "ltr")).toBe("ltr");
    expect(resolveDominantDirection("ab אב", "rtl")).toBe("rtl");
  });

  it("resolves each table cell independently and uses automatic table flow only for ties", () => {
    expect(resolveTableCellDirection("English בתוך עברית נוספת", "ltr")).toBe("rtl");
    expect(resolveTableCellDirection("English sentence with עברית", "rtl")).toBe("ltr");
    expect(resolveTableCellDirection("العربية فقط", "ltr")).toBe("rtl");
    expect(resolveTableCellDirection("123 — —", "ltr")).toBe("ltr");
    expect(resolveTableCellDirection("123 — —", "rtl")).toBe("rtl");
  });

  it("honors an explicit direction instead of inferring it", () => {
    expect(resolveMarkdownDirection("שלום עולם", "ltr")).toBe("ltr");
    expect(resolveMarkdownDirection("Hello world", "rtl")).toBe("rtl");
  });

  it("uses a user-message hint to stabilize an automatic streaming response", () => {
    expect(resolveMarkdownDirectionHint("Scient GPT")).toBe("ltr");
    expect(resolveMarkdownDirectionHint("... — 123")).toBeNull();
    expect(
      resolveStreamingMarkdownDirection({
        markdown: "Scient",
        requestedDirection: "auto",
        messageDirectionHint: "rtl",
        isStreaming: true,
      }),
    ).toBe("rtl");
    expect(
      resolveStreamingMarkdownDirection({
        markdown: "Scient שלום עולם",
        requestedDirection: "auto",
        messageDirectionHint: "rtl",
        frozenDirection: "rtl",
        isStreaming: true,
      }),
    ).toBe("rtl");
  });

  it("re-resolves the complete message after streaming finishes", () => {
    expect(
      resolveStreamingMarkdownDirection({
        markdown: "Scient שלום עולם מחקר",
        requestedDirection: "auto",
        frozenDirection: "ltr",
        isStreaming: false,
      }),
    ).toBe("rtl");
    expect(
      resolveStreamingMarkdownDirection({
        markdown: "שלום עולם",
        requestedDirection: "ltr",
        messageDirectionHint: "rtl",
        isStreaming: true,
      }),
    ).toBe("ltr");
  });

  it("normalizes only standalone flow arrows in RTL prose", () => {
    expect(normalizeRtlFlowArrows("שלב ראשון → שלב שני ⇒ שלב שלישי")).toBe(
      "שלב ראשון ← שלב שני ⇐ שלב שלישי",
    );
    expect(normalizeRtlFlowArrows("x→y and x=>y")).toBe("x→y and x=>y");
    expect(normalizeRtlFlowArrows("שלב ראשון → x→y")).toBe("שלב ראשון ← x→y");
    expect(normalizeRtlFlowArrows("עברית: H2O → CO2")).toBe("עברית: H2O → CO2");
    expect(normalizeRtlFlowArrows("עברית: $A → B$")).toBe("עברית: $A → B$");
    expect(findRtlFlowArrowSpans("שלב ראשון → שלב שני ⟶ שלב שלישי")).toEqual([
      { end: 11, replacement: "←", start: 10 },
      { end: 21, replacement: "⟵", start: 20 },
    ]);
  });
});

const baseInput = {
  language: "text",
  fenceTitle: null,
  conversationDirection: "auto" as const,
  isStreaming: false,
};

describe("plain-text copy-box direction", () => {
  it("uses the strong script when a plain-text box is unambiguous", () => {
    expect(resolvePlainTextBoxDirection({ ...baseInput, code: "שלום עולם" })).toBe("rtl");
    expect(resolvePlainTextBoxDirection({ ...baseInput, code: "Hello world" })).toBe("ltr");
  });

  it("keeps source and titled fences left-to-right", () => {
    expect(
      resolvePlainTextBoxDirection({
        ...baseInput,
        code: "שלום",
        language: "typescript",
      }),
    ).toBe("ltr");
    expect(
      resolvePlainTextBoxDirection({
        ...baseInput,
        code: "שלום",
        fenceTitle: "notes.txt",
      }),
    ).toBe("ltr");
  });

  it("allows an explicit fence marker to override inference", () => {
    expect(resolveFenceDirection("dir=rtl")).toBe("rtl");
    expect(
      resolvePlainTextBoxDirection({
        ...baseInput,
        code: "Hello",
        fenceDirection: "rtl",
      }),
    ).toBe("rtl");
    expect(resolveFenceDirection("title=notes.txt")).toBeNull();
  });

  it("uses the fixed conversation mode while mixed content streams", () => {
    expect(
      resolvePlainTextBoxDirection({
        ...baseInput,
        code: "שלום Hello",
        conversationDirection: "rtl",
        isStreaming: true,
      }),
    ).toBe("rtl");
  });

  it("leaves mixed completed content automatic unless the user fixed a mode", () => {
    expect(resolvePlainTextBoxDirection({ ...baseInput, code: "שלום Hello" })).toBe("auto");
    expect(resolvePlainTextBoxDirection({ ...baseInput, code: "שלום Ωμέγα" })).toBe("auto");
    expect(
      resolvePlainTextBoxDirection({
        ...baseInput,
        code: "שלום Hello",
        conversationDirection: "ltr",
      }),
    ).toBe("ltr");
  });
});
