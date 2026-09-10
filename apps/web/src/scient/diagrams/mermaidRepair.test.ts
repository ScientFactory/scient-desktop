import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";

import { addMermaidRepairToComposer, buildMermaidRepairRequest } from "./mermaidRepair";
import { MERMAID_VERSION, MermaidRenderError } from "./mermaidRuntime";

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  text: "flowchart LR\nA[",
  start: 0,
  end: 15,
  prefix: "",
  suffix: "",
  comment: "Please fix this diagram. Parse error.",
};

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
    const focusAtEnd = vi.fn();
    const composer = {
      readSnapshot: () => ({ value }),
      citeAssistantText: vi.fn((quote: AssistantCitation) => {
        value += ` ${serializeAssistantCitation(quote)} `;
        return true;
      }),
      focusAtEnd,
    } as unknown as NonNullable<Parameters<typeof addMermaidRepairToComposer>[0]>;
    expect(addMermaidRepairToComposer(composer, citation)).toBe(true);
    expect(addMermaidRepairToComposer(composer, citation)).toBe(true);
    expect(value).toBe(
      `Please keep my existing question. ${serializeAssistantCitation(citation)} `,
    );
    expect(composer.citeAssistantText).toHaveBeenCalledTimes(1);
    expect(focusAtEnd).not.toHaveBeenCalled();
  });

  it("fails safely when the composer is absent or refuses an insertion", () => {
    expect(addMermaidRepairToComposer(null, citation)).toBe(false);
    const focusAtEnd = vi.fn();
    const composer = {
      readSnapshot: () => ({ value: "" }),
      citeAssistantText: vi.fn(() => false),
      focusAtEnd,
    } as unknown as NonNullable<Parameters<typeof addMermaidRepairToComposer>[0]>;
    expect(addMermaidRepairToComposer(composer, citation)).toBe(false);
    expect(focusAtEnd).not.toHaveBeenCalled();
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
