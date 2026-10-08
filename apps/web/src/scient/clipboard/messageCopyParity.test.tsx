// @vitest-environment happy-dom
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { chatMarkdownClipboardPayload } from "~/markdown-clipboard";
import { messageCopyHtml } from "./messageCopyHtml";

vi.mock("~/state/server", async (original) => {
  const actual = await original<typeof import("~/state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: () => "render-server-config",
    },
  };
});
vi.mock("@effect/atom-react", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    useAtomValue: (atom: unknown) =>
      atom === "render-server-config" ? null : AsyncResult.initial(),
    useAtomRefresh: () => vi.fn(),
  };
});
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
  usePreparedConnection: () => ({ _tag: "None" }),
  useEnvironmentScope: () => false,
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

const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol, li, table, th, td, pre";

afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

interface Profile {
  readonly lineBreaks: boolean;
  readonly parseRawHtml: boolean;
}

const ASSISTANT: Profile = { lineBreaks: false, parseRawHtml: true };
const USER: Profile = { lineBreaks: true, parseRawHtml: false };

/**
 * Block tags with their resolved direction, then the left-to-right islands
 * (code, math, links, paths) in order. Heading levels follow chat's display
 * offset, so only "heading" is compared.
 */
function signature(html: string): string[] {
  const container = document.createElement("div");
  container.innerHTML = html;
  const blocks = [...container.querySelectorAll(BLOCK_SELECTOR)].map((block) => {
    const tag = /^H[1-6]$/u.test(block.tagName) ? "heading" : block.tagName.toLowerCase();
    const code = block.tagName === "PRE" ? `:${block.textContent ?? ""}` : "";
    return `${tag}:${block.getAttribute("dir") ?? "-"}${code}`;
  });
  const islands = [...container.querySelectorAll('span[dir="ltr"][style*="unicode-bidi"]')].map(
    (island) => `island:${island.textContent ?? ""}`,
  );
  return [...blocks, ...islands];
}

/** What chat displays, copied whole through the selection route. */
function chatRender(markdown: string, profile: Profile): string {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <ChatMarkdown
      cwd="/workspace"
      text={markdown}
      lineBreaks={profile.lineBreaks}
      parseRawHtml={profile.parseRawHtml}
    />,
  );
  document.body.append(host);
  const range = document.createRange();
  range.selectNodeContents(host.querySelector(".chat-markdown")!);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const html = chatMarkdownClipboardPayload(selection)!.html;
  host.remove();
  return html;
}

/** The Copy message button's rendering of the same Markdown, with no row mounted. */
function clipboardRender(markdown: string, profile: Profile): string {
  const anchor = document.body.appendChild(document.createElement("button"));
  const html = messageCopyHtml({ anchor, messageId: "unmounted", markdown, ...profile })!;
  anchor.remove();
  return html;
}

const CASES: ReadonlyArray<readonly [string, string, Profile]> = [
  [
    "backslash math",
    "המשוואה \\(E = mc^2\\) נכונה.\n\n\\[\n\\int_0^1 x\\,dx\n\\]\n\nוזהו.",
    ASSISTANT,
  ],
  [
    "text fences with metadata",
    [
      "קובץ טקסט:",
      "",
      "```text dir=ltr",
      "שלום עולם",
      "```",
      "",
      '```text title="notes.txt"',
      "שלום עולם",
      "```",
      "",
      "```text",
      "שלום עולם",
      "```",
    ].join("\n"),
    ASSISTANT,
  ],
  [
    "over-indented list prose",
    "- פריט ראשון\n\n      המשך הפריט בעברית עם הזחה גדולה.\n\n- פריט שני",
    ASSISTANT,
  ],
  ["alerts", "> [!NOTE]\n> הערה חשובה בעברית.\n\n> [!WARNING]\n> A warning in English.", ASSISTANT],
  [
    "tables",
    "| שם | תיאור |\n| --- | --- |\n| טיפול | תרופה |\n\nטקסט.\n\n| Term | Value |\n| --- | ---: |\n| Dose | 5 mg |",
    ASSISTANT,
  ],
  ["dollar math", "המשוואה $E = mc^2$ נכונה, וגם $$a+b$$ בשורה.", ASSISTANT],
  ["display math", "לפני:\n\n$$\nx^2 + y^2 = z^2\n$$\n\nאחרי.", ASSISTANT],
  [
    "nested lists",
    "- פריט עליון\n  - פריט מקונן\n    - עמוק יותר with English\n- פריט אחרון\n\n1. first\n2. second\n   - nested",
    ASSISTANT,
  ],
  [
    "headings and quotes",
    "## כותרת\n\nפסקה בעברית.\n\n### English heading\n\nEnglish paragraph.\n\n> ציטוט",
    ASSISTANT,
  ],
  ["user line breaks", "שורה ראשונה\nשורה שנייה עם `code`\n\n- פריט\n- item", USER],
  ["user raw html stays text", "שלום <b>לא מודגש</b> וסוף.", USER],
  [
    "raw-html math with nested elements",
    'שלום <code class="language-math"><span>x</span> + y</code> סוף.\n\n<pre><code class="language-math"><span>a</span> = b</code></pre>',
    ASSISTANT,
  ],
];

describe("Copy message rendering parity with chat", () => {
  it.each(CASES)(
    "matches chat's blocks, directions, and islands: %s",
    (_name, markdown, profile) => {
      expect(signature(clipboardRender(markdown, profile))).toEqual(
        signature(chatRender(markdown, profile)),
      );
    },
  );
});
