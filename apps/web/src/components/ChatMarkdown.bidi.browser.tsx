import "../index.css";

import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown bidirectional rendering", () => {
  it("uses dominant block language when an English product name comes first", async () => {
    const screen = await render(<ChatMarkdown text="Scient הוא כלי למחקר מדעי." cwd={undefined} />);

    try {
      const root = document.querySelector<HTMLElement>(".chat-markdown");
      const paragraph = root?.querySelector<HTMLParagraphElement>("p");

      expect(root?.dir).toBe("auto");
      expect(paragraph?.dir).toBe("rtl");
      expect(getComputedStyle(paragraph!).direction).toBe("rtl");
      expect(getComputedStyle(paragraph!).textAlign).toBe("start");
      expect(document.documentElement.dir).not.toBe("rtl");
    } finally {
      await screen.unmount();
    }
  });

  it("resolves prose blocks independently and isolates machine fragments", async () => {
    const screen = await render(
      <ChatMarkdown
        text={[
          "`evidence-to-note` הופך ראיה להערה שימושית.",
          "",
          "This paragraph is intentionally written in English with עברית once.",
        ].join("\n")}
        cwd={undefined}
      />,
    );

    try {
      const paragraphs = Array.from(document.querySelectorAll<HTMLElement>(".chat-markdown p"));
      const code = document.querySelector<HTMLElement>(".chat-markdown code");

      expect(paragraphs).toHaveLength(2);
      expect(getComputedStyle(paragraphs[0]!).direction).toBe("rtl");
      expect(getComputedStyle(paragraphs[1]!).direction).toBe("ltr");
      expect(code?.dir).toBe("ltr");
      expect(getComputedStyle(code!).direction).toBe("ltr");
      expect(getComputedStyle(code!).unicodeBidi).toBe("isolate");
    } finally {
      await screen.unmount();
    }
  });

  it("puts list markers and quotation chrome on each block's logical start", async () => {
    const screen = await render(
      <ChatMarkdown
        text={[
          "- פריט ראשון",
          "- Second item",
          "",
          "> ציטוט בעברית",
          "",
          "| Name | Value |",
          "| --- | --- |",
          "| שם | ערך |",
        ].join("\n")}
        cwd={undefined}
      />,
    );

    try {
      const listItems = Array.from(document.querySelectorAll<HTMLElement>(".chat-markdown li"));
      const quote = document.querySelector<HTMLElement>(".chat-markdown blockquote");
      const table = document.querySelector<HTMLTableElement>(".chat-markdown table");
      const hebrewCell = Array.from(
        document.querySelectorAll<HTMLTableCellElement>(".chat-markdown td"),
      ).find((cell) => cell.textContent === "שם");

      expect(getComputedStyle(listItems[0]!).direction).toBe("rtl");
      expect(parseFloat(getComputedStyle(listItems[0]!).marginRight)).toBeGreaterThan(0);
      expect(getComputedStyle(listItems[1]!).direction).toBe("ltr");
      expect(parseFloat(getComputedStyle(listItems[1]!).marginLeft)).toBeGreaterThan(0);
      expect(getComputedStyle(quote!).direction).toBe("rtl");
      expect(getComputedStyle(quote!).borderRightWidth).toBe("2px");
      expect(getComputedStyle(table!).direction).toBe("ltr");
      expect(getComputedStyle(hebrewCell!).direction).toBe("rtl");
      expect(getComputedStyle(hebrewCell!).textAlign).toBe("start");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a parent list item's direction independent from its nested list", async () => {
    const screen = await render(
      <ChatMarkdown
        text={["- English parent", "  - פריט עברי ראשון", "  - פריט עברי שני"].join("\n")}
        cwd={undefined}
      />,
    );

    try {
      const items = Array.from(document.querySelectorAll<HTMLElement>(".chat-markdown li"));
      expect(items).toHaveLength(3);
      expect(getComputedStyle(items[0]!).direction).toBe("ltr");
      expect(getComputedStyle(items[1]!).direction).toBe("rtl");
      expect(getComputedStyle(items[2]!).direction).toBe("rtl");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps outer and nested quotations independently directed", async () => {
    const screen = await render(
      <ChatMarkdown
        text={["> English outer quote", ">", "> > ציטוט עברי פנימי ארוך וברור מאוד"].join("\n")}
        cwd={undefined}
      />,
    );

    try {
      const quotes = Array.from(
        document.querySelectorAll<HTMLElement>(".chat-markdown blockquote"),
      );
      expect(quotes).toHaveLength(2);
      expect(getComputedStyle(quotes[0]!).direction).toBe("ltr");
      expect(getComputedStyle(quotes[1]!).direction).toBe("rtl");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a natural-language file label in its paragraph direction", async () => {
    const screen = await render(
      <ChatMarkdown text="[קובץ ההגדרות](./config.ts) מכיל את ההגדרה החשובה." cwd="/tmp/project" />,
    );

    try {
      const paragraph = document.querySelector<HTMLElement>(".chat-markdown p");
      const link = paragraph?.querySelector<HTMLAnchorElement>('a[href="./config.ts"]');
      expect(getComputedStyle(paragraph!).direction).toBe("rtl");
      expect(link?.dir).toBe("rtl");
      expect(getComputedStyle(link!).direction).toBe("rtl");
    } finally {
      await screen.unmount();
    }
  });

  it("lets Hebrew user prose control a paragraph after a leading LTR file chip", async () => {
    const screen = await render(
      <ChatMarkdown text="@src/App.tsx שלום, בדוק את הקובץ" cwd="/tmp/project" variant="user" />,
    );

    try {
      const paragraph = document.querySelector<HTMLElement>(".chat-markdown p");
      const chip = paragraph?.querySelector<HTMLElement>('[dir="ltr"]');

      expect(paragraph?.dir).toBe("rtl");
      expect(getComputedStyle(paragraph!).direction).toBe("rtl");
      expect(chip).not.toBeNull();
      expect(getComputedStyle(chip!).direction).toBe("ltr");
    } finally {
      await screen.unmount();
    }
  });
});
