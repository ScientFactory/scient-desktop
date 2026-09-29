// @vitest-environment happy-dom
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  chatMarkdownClipboardPayload,
  serializeRenderedMarkdownFragment,
} from "~/markdown-clipboard";

const directionMarking = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./clipboardDirection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clipboardDirection")>();
  return {
    ...actual,
    markClipboardDirection: (...args: Parameters<typeof actual.markClipboardDirection>) => {
      directionMarking.calls += 1;
      actual.markClipboardDirection(...args);
    },
  };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  Link: ({ children, className, "aria-label": label }: ComponentProps<"a">) => (
    <a href="#source" className={className} aria-label={label}>
      {children}
    </a>
  ),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("~/components/ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("~/components/ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("~/state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("~/remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("~/editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "~/components/ChatMarkdown";

const BIDI_CONTROL_CHARACTERS = /[؜‎‏‪-‮⁦-⁩]/u;

afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
  directionMarking.calls = 0;
});

/** Renders a message with the real chat renderer and returns its Markdown root. */
function mount(markdown: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<ChatMarkdown cwd="/workspace" text={markdown} />);
  document.body.append(host);
  return host.querySelector<HTMLElement>(".chat-markdown")!;
}

function copy(range: Range) {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const payload = chatMarkdownClipboardPayload(selection)!;
  const html = document.createElement("div");
  html.innerHTML = payload.html;
  return { payload, html };
}

function copyAll(root: Element) {
  const range = document.createRange();
  range.selectNodeContents(root);
  return copy(range);
}

/** The `text/plain` flavour computed straight from the rendered fragment. */
function plainTextOf(range: Range): string {
  const container = document.createElement("div");
  container.append(range.cloneContents());
  return serializeRenderedMarkdownFragment(container);
}

function block(html: Element, selector: string, index = 0): Element {
  const element = html.querySelectorAll(selector)[index];
  if (!element) throw new Error(`Missing ${selector} #${index}`);
  return element;
}

function ltrIslands(html: Element): string[] {
  return [...html.querySelectorAll('span[dir="ltr"][style*="unicode-bidi:embed"]')].map(
    (island) => island.textContent ?? "",
  );
}

describe("clipboard HTML direction for right-to-left copies", () => {
  it("keeps a copy without right-to-left text byte-identical", () => {
    const root = mount("Hello **world**.\n\n- one\n- two");
    const { payload } = copyAll(root);
    expect(payload.html).toBe(
      '<meta charset="utf-8"><p dir="ltr">Hello <strong>world</strong>.</p>\n<ul dir="ltr">\n<li>one</li>\n<li>two</li>\n</ul>',
    );
    expect(payload.text).toBe("Hello **world**.\n\n- one\n- two");
    expect(directionMarking.calls).toBe(0);
  });

  it("marks a Hebrew-only paragraph right-to-left in dir and inline style", () => {
    const root = mount("שלום עולם, זה ניסוי.");
    const { payload, html } = copyAll(root);
    const paragraph = block(html, "p");
    expect(paragraph.getAttribute("dir")).toBe("rtl");
    expect(paragraph.getAttribute("style")).toBe("direction:rtl;text-align:right");
    expect(paragraph.textContent).toBe("שלום עולם, זה ניסוי.");
    expect(payload.text).toBe("שלום עולם, זה ניסוי.");
  });

  it("gives mixed paragraphs their own directions", () => {
    const root = mount("פסקה ראשונה בעברית.\n\nA second paragraph in English.\n\nפסקה שלישית.");
    const { html } = copyAll(root);
    expect([...html.querySelectorAll("p")].map((p) => p.getAttribute("style"))).toEqual([
      "direction:rtl;text-align:right",
      "direction:ltr;text-align:left",
      "direction:rtl;text-align:right",
    ]);
    expect([...html.querySelectorAll("p")].map((p) => p.getAttribute("dir"))).toEqual([
      "rtl",
      "ltr",
      "rtl",
    ]);
  });

  it("leaves a Hebrew sentence ending with an English word and a period as prose", () => {
    const source = "הרצנו את הניתוח עם Python.";
    const root = mount(source);
    const range = document.createRange();
    range.selectNodeContents(root);
    const expectedText = plainTextOf(range);
    const { payload, html } = copy(range);
    const paragraph = block(html, "p");
    expect(paragraph.getAttribute("dir")).toBe("rtl");
    // The period must stay in the right-to-left paragraph, not inside an LTR island.
    expect(ltrIslands(html)).toEqual([]);
    expect(paragraph.textContent).toBe(source);
    expect(payload.text).toBe(expectedText);
    expect(payload.text).toBe(source);
  });

  it("keeps parentheses, quotes, numbers, percentages, and dates as ordinary text", () => {
    const source =
      'המשתתפים (כ-3,400) אמרו "מצוין" ו-"good" (English); עלייה של 12.5% בין 01/09/2026 ל-2026-09-29.';
    const root = mount(source);
    const { payload, html } = copyAll(root);
    expect(block(html, "p").getAttribute("dir")).toBe("rtl");
    expect(ltrIslands(html)).toEqual([]);
    expect(block(html, "p").textContent).toBe(source);
    expect(payload.text).toBe(source);
  });

  it("isolates inline code, file paths, URLs, and left-to-right links inside Hebrew", () => {
    const source =
      "כדי לבדוק את השינוי יש להריץ את הפקודה `npm test` מתוך התיקייה הראשית /Users/me/project/ ולאחר מכן לפתוח את הקובץ ./src/app.ts, ואז לקרוא את ההסבר המלא בכתובת https://example.com/docs/ או במדריך [the guide](https://example.com/guide) וגם ב-[המדריך העברי](https://example.com/he).";
    const root = mount(source);
    const range = document.createRange();
    range.selectNodeContents(root);
    const expectedText = plainTextOf(range);
    const { payload, html } = copy(range);
    expect(ltrIslands(html)).toEqual([
      "npm test",
      "/Users/me/project/",
      "./src/app.ts",
      "https://example.com/docs/",
      "the guide",
    ]);
    // Code keeps its own element; the island wraps it.
    expect(html.querySelector('span[dir="ltr"] > code')?.textContent).toBe("npm test");
    // Sentence punctuation after a path or URL belongs to the Hebrew sentence.
    expect(block(html, "p").getAttribute("dir")).toBe("rtl");
    expect(block(html, "p").textContent).toContain("./src/app.ts, ואז");
    expect(block(html, "p").textContent?.endsWith("העברי.")).toBe(true);
    expect(payload.text).toBe(expectedText);
    expect(payload.text).toBe(source);
  });

  it("isolates math sources inside Hebrew", () => {
    const root = mount("המשוואה $E = mc^2$ חשובה.");
    const { payload, html } = copyAll(root);
    expect(ltrIslands(html)).toEqual(["$$E = mc^2$$"]);
    expect(payload.text).toBe("המשוואה $$E = mc^2$$ חשובה.");
  });

  it("isolates a file chip inside Hebrew", () => {
    const root = mount("הקובץ `src/app.ts` השתנה.");
    const { html } = copyAll(root);
    const chip = html.querySelector(".chat-markdown-file-link");
    expect(chip?.parentElement?.getAttribute("dir")).toBe("ltr");
    expect(ltrIslands(html)).toEqual(["app.ts"]);
  });

  it("does not isolate technical text inside a left-to-right paragraph", () => {
    const root = mount(
      "שלום.\n\nRun `npm test` in /Users/me/project/ and see https://example.com/.",
    );
    const { html } = copyAll(root);
    expect(block(html, "p", 1).getAttribute("dir")).toBe("ltr");
    expect(ltrIslands(html)).toEqual([]);
  });

  it("marks lists of both directions and their items", () => {
    const root = mount("- פריט ראשון\n- פריט שני\n\nבין הרשימות.\n\n- first item\n- second item");
    const { html } = copyAll(root);
    const [hebrew, english] = [...html.querySelectorAll("ul")];
    expect(hebrew?.getAttribute("dir")).toBe("rtl");
    expect(hebrew?.getAttribute("style")).toBe("direction:rtl");
    expect(english?.getAttribute("dir")).toBe("ltr");
    expect(
      [...html.querySelectorAll("li")].map((item) => [
        item.getAttribute("dir"),
        item.getAttribute("style"),
      ]),
    ).toEqual([
      ["rtl", "direction:rtl;text-align:right"],
      ["rtl", "direction:rtl;text-align:right"],
      ["ltr", "direction:ltr;text-align:left"],
      ["ltr", "direction:ltr;text-align:left"],
    ]);
  });

  it("marks tables of both directions, keeping each column's alignment", () => {
    const root = mount(
      [
        "| שם | תיאור |",
        "| --- | --- |",
        "| טיפול | תרופה ומעקב |",
        "",
        "טקסט בין הטבלאות.",
        "",
        "| Term | Value |",
        "| --- | ---: |",
        "| Dose | 5 mg |",
      ].join("\n"),
    );
    const { html } = copyAll(root);
    const [hebrew, english] = [...html.querySelectorAll("table")];
    expect(hebrew?.getAttribute("dir")).toBe("rtl");
    expect(hebrew?.getAttribute("style")).toBe("direction:rtl");
    expect(english?.getAttribute("dir")).toBe("ltr");
    expect(hebrew?.querySelector("th")?.getAttribute("style")).toBe(
      "direction:rtl;text-align:right",
    );
    // An authored alignment stays authoritative.
    const aligned = english?.querySelectorAll("td")[1];
    expect(aligned?.getAttribute("style")).toMatch(/text-align:\s*right/u);
    expect(aligned?.getAttribute("style")).toMatch(/direction:ltr$/u);
    expect(aligned?.getAttribute("style")).not.toContain("text-align:left");
  });

  it("keeps a code block inside a Hebrew message left-to-right and untouched", () => {
    const code = "const path = '/tmp/x'; // הערה";
    const root = mount(`הנה הקוד:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nוזהו.`);
    const range = document.createRange();
    range.selectNodeContents(root);
    const expectedText = plainTextOf(range);
    const { payload, html } = copy(range);
    const pre = block(html, "pre");
    expect(pre.getAttribute("dir")).toBe("ltr");
    expect(pre.getAttribute("style")).toBe("direction:ltr;text-align:left");
    expect(pre.textContent).toBe(`${code}\n`);
    expect(pre.querySelector('span[style*="unicode-bidi"]')).toBeNull();
    expect(payload.text).toBe(expectedText);
  });

  it("wraps a selection inside one Hebrew paragraph in its paragraph's direction", () => {
    const root = mount("זהו משפט ארוך בעברית עם Python.");
    const text = root.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 5);
    range.setEnd(text, text.textContent!.length);
    const { payload, html } = copy(range);
    expect(html.querySelector("p")).toBeNull();
    const wrapper = html.querySelector('span[dir="rtl"]');
    expect(wrapper?.getAttribute("style")).toBe("direction:rtl;unicode-bidi:embed");
    expect(wrapper?.textContent).toBe(payload.text);
  });

  it("marks only the clipboard copy, never the displayed message", () => {
    const root = mount(
      [
        "## סיכום",
        "",
        "הרצנו `npm test` ב-/Users/me/project/ עם Python, ראו https://example.com/.",
        "",
        "- פריט עם $x^2$",
        "- item",
        "",
        "| עמודה | Column |",
        "| --- | --- |",
        "| ערך | value |",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n"),
    );
    const before = document.body.outerHTML;
    copyAll(root);
    const paragraph = root.querySelector("p")!;
    const partial = document.createRange();
    partial.setStart(paragraph.firstChild!, 2);
    partial.setEnd(paragraph, paragraph.childNodes.length - 1);
    copy(partial);
    expect(document.body.outerHTML).toBe(before);
  });

  it("keeps chip, details, and diagram content that the sanitizer would drop", () => {
    const root = mount(
      [
        "ראו את הקובץ כאן.",
        "",
        "<details open>",
        "<summary>פרטים פתוחים</summary>",
        "",
        "גוף הפרטים.",
        "",
        "</details>",
        "",
        "<details>",
        "<summary>פרטים סגורים</summary>",
        "",
        "גוף סגור.",
        "",
        "</details>",
        "",
        "```mermaid",
        "graph TD; A-->B",
        "```",
      ].join("\n"),
    );
    // A user-message mention chip: a button whose Markdown copy is a context link.
    const paragraph = root.querySelector("p")!;
    const chip = document.createElement("button");
    chip.setAttribute("data-markdown-copy", "[app.ts](t3-context://mention-1)");
    chip.innerHTML = '<svg aria-hidden="true"></svg><span>app.ts</span>';
    paragraph.firstChild!.after(chip);
    const range = document.createRange();
    range.selectNodeContents(root);
    const expectedText = plainTextOf(range);
    const { payload, html } = copy(range);
    expect(payload.text).toBe(expectedText);
    expect(payload.text).toContain("[app.ts](t3-context://mention-1)");
    expect(block(html, "p").textContent).toContain("app.ts");
    expect([...html.querySelectorAll("strong")].map((strong) => strong.textContent)).toEqual([
      "פרטים פתוחים",
      "פרטים סגורים",
    ]);
    expect(html.textContent).toContain("גוף הפרטים.");
    // A collapsed body is not in the page, and the plain copy omits it too.
    expect(payload.text).not.toContain("גוף סגור.");
    const pre = block(html, "pre");
    expect(pre.textContent).toBe("graph TD; A-->B\n");
    expect(pre.getAttribute("dir")).toBe("ltr");
    expect(html.querySelector("button, svg, [hidden]")).toBeNull();
  });

  it("leaves an English selection copy with a chip exactly as before", () => {
    const root = mount("See the file now.");
    const paragraph = root.querySelector("p")!;
    const chip = document.createElement("button");
    chip.setAttribute("data-markdown-copy", "[app.ts](t3-context://mention-1)");
    chip.textContent = "app.ts";
    paragraph.firstChild!.after(chip);
    const { payload } = copyAll(root);
    expect(payload.html).toBe('<meta charset="utf-8"><p dir="ltr">See the file now.</p>');
    expect(directionMarking.calls).toBe(0);
  });

  it("adds no invisible bidi control characters", () => {
    const root = mount("שלום `code` /tmp/file.txt https://example.com/ (בדיקה) 50%.");
    const { payload } = copyAll(root);
    expect(payload.html).not.toMatch(BIDI_CONTROL_CHARACTERS);
    expect(payload.text).not.toMatch(BIDI_CONTROL_CHARACTERS);
  });
});
