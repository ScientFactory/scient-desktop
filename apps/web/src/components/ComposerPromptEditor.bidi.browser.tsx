import "../index.css";

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerPromptEditor } from "./ComposerPromptEditor";

function ComposerDirectionFixture(props: { initialValue: string }) {
  const [value, setValue] = useState(props.initialValue);

  return (
    <div>
      <button type="button" onClick={() => setValue("Please review the change")}>
        Use English
      </button>
      <ComposerPromptEditor
        value={value}
        cursor={value.length}
        terminalContexts={[]}
        disabled={false}
        placeholder="Ask for follow-up changes"
        onRemoveTerminalContext={() => {}}
        onChange={(nextValue) => setValue(nextValue)}
        onPaste={() => {}}
      />
    </div>
  );
}

describe("ComposerPromptEditor bidirectional rendering", () => {
  it("follows the draft's dominant natural direction without mirroring the app", async () => {
    const screen = await render(<ComposerDirectionFixture initialValue="שלום, בדוק את השינוי" />);

    try {
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      expect(editor).not.toBeNull();

      await vi.waitFor(() => {
        const paragraph = editor?.querySelector<HTMLParagraphElement>("p");
        expect(paragraph?.dir).toBe("rtl");
        expect(getComputedStyle(paragraph!).direction).toBe("rtl");
      });

      await screen.getByRole("button", { name: "Use English" }).click();
      await vi.waitFor(() => {
        const paragraph = editor?.querySelector<HTMLParagraphElement>("p");
        expect(editor?.textContent).toContain("Please review the change");
        expect(getComputedStyle(paragraph!).direction).toBe("ltr");
      });

      expect(document.documentElement.dir).not.toBe("rtl");
    } finally {
      await screen.unmount();
    }
  });

  it("does not let a leading English product name control a Hebrew draft", async () => {
    const screen = await render(
      <ComposerDirectionFixture initialValue="Scient הוא כלי למחקר מדעי" />,
    );

    try {
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      await vi.waitFor(() => {
        const paragraph = editor?.querySelector<HTMLParagraphElement>("p");
        expect(paragraph?.dir).toBe("rtl");
        expect(getComputedStyle(paragraph!).direction).toBe("rtl");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("isolates a leading file chip so following Hebrew controls the paragraph", async () => {
    const screen = await render(
      <ComposerDirectionFixture initialValue="@src/App.tsx שלום, בדוק את הקובץ" />,
    );

    try {
      const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
      await vi.waitFor(() => {
        const paragraph = editor?.querySelector<HTMLParagraphElement>("p");
        const chip = editor?.querySelector<HTMLElement>('[contenteditable="false"]');
        expect(paragraph).not.toBeNull();
        expect(chip?.dir).toBe("ltr");
        expect(getComputedStyle(paragraph!).direction).toBe("rtl");
      });
    } finally {
      await screen.unmount();
    }
  });
});
