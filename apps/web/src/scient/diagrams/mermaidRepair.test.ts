import { describe, expect, it, vi } from "vite-plus/test";

import { addMermaidRepairToComposer, buildMermaidRepairRequest } from "./mermaidRepair";
import { MERMAID_VERSION, MermaidRenderError } from "./mermaidRuntime";

describe("Mermaid repair requests", () => {
  it("preserves the exact source and diagnostic, including nested fences", () => {
    const source = 'flowchart LR\n A["```quoted```"] --> B\n';
    const diagnostic = "Parse error on line 2:\n```quoted```\n      ^\nExpected closing bracket";
    const request = buildMermaidRepairRequest(source, diagnostic);
    expect(request).toContain(`Mermaid ${MERMAID_VERSION}`);
    expect(request).toContain(`\`\`\`\`mermaid\n${source}\`\`\`\``);
    expect(request).toContain(`\`\`\`\`text\n${diagnostic}\n\`\`\`\``);
    expect(request).toContain("Preserve its intended meaning");
  });

  it("appends once, without replacing the draft or sending a message", () => {
    let value = "Please keep my existing question.";
    const composer = {
      readSnapshot: () => ({ value }),
      insertTextAtEnd: vi.fn((text: string) => {
        value += text;
        return true;
      }),
      focusAtEnd: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof addMermaidRepairToComposer>[0]>;
    const request = buildMermaidRepairRequest("flowchart LR\nA[", "Parse error");
    expect(addMermaidRepairToComposer(composer, request)).toBe(true);
    expect(addMermaidRepairToComposer(composer, request)).toBe(true);
    expect(value).toBe(`Please keep my existing question.\n\n${request}`);
    expect(composer.insertTextAtEnd).toHaveBeenCalledTimes(1);
    expect(composer.focusAtEnd).toHaveBeenCalledTimes(2);
  });

  it("fails safely when the composer is absent or refuses an insertion", () => {
    expect(addMermaidRepairToComposer(null, "request")).toBe(false);
    const composer = {
      readSnapshot: () => ({ value: "" }),
      insertTextAtEnd: vi.fn(() => false),
      focusAtEnd: vi.fn(),
    } as unknown as NonNullable<Parameters<typeof addMermaidRepairToComposer>[0]>;
    expect(addMermaidRepairToComposer(composer, "request")).toBe(false);
    expect(composer.focusAtEnd).not.toHaveBeenCalled();
  });
});

describe("Mermaid renderer diagnostics", () => {
  it("separates a short UI summary from useful parser details, without a stack", () => {
    const error = new MermaidRenderError(new Error("Parse error on line 2:\nA[\n ^\nExpecting ]"));
    expect(error.message).toBe("Parse error on line 2:");
    expect(error.details).toBe("Parse error on line 2:\nA[\n ^\nExpecting ]");
    expect(error.details).not.toContain("at ");
  });

  it("bounds unexpectedly long diagnostics and handles unknown failures", () => {
    expect(new MermaidRenderError(new Error("x".repeat(10_000))).message).toHaveLength(240);
    expect(new MermaidRenderError(new Error("x".repeat(10_000))).details).toBe(
      `${"x".repeat(8_000)}\n[Error truncated]`,
    );
    expect(new MermaidRenderError(null).details).toBe("Mermaid could not render this diagram.");
  });
});
