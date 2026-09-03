import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  resources: [] as Array<unknown>,
  assetState: "success" as "success" | "loading" | "failure",
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlRefresh: () => vi.fn(),
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    testState.resources.push(resource);
    if (testState.assetState === "loading") return { _tag: "Loading" };
    if (testState.assetState === "failure") return { _tag: "Failure" };
    return { _tag: "Success", url: "https://signed.test/workspace-image.svg" };
  },
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";
import { FileMarkdownPreview } from "./files/FileMarkdownPreview";

const threadRef = {
  environmentId: EnvironmentId.make("env-windows"),
  threadId: ThreadId.make("thread-windows"),
};

function render(markdown: string, parseRawHtml = true): string {
  return renderToStaticMarkup(
    <ChatMarkdown
      cwd={"C:\\Users\\shawn\\project"}
      threadRef={threadRef}
      text={markdown}
      parseRawHtml={parseRawHtml}
    />,
  );
}

function renderWithoutThread(markdown: string): string {
  return renderToStaticMarkup(<ChatMarkdown cwd={"C:\\Users\\shawn\\project"} text={markdown} />);
}

function renderFilePreview(cwd: string, relativePath: string, text: string): string {
  return renderToStaticMarkup(
    <FileMarkdownPreview cwd={cwd} relativePath={relativePath} text={text} threadRef={threadRef} />,
  );
}

function copiedMarkdownFrom(html: string): string {
  const copy = /data-markdown-copy="([^"]*)"/.exec(html)?.[1]?.replaceAll("&quot;", '"');
  expect(copy).toBeDefined();
  return copy ?? "";
}

function firstInlineStyle(html: string): Record<string, string> {
  const style = /style="([^"]+)"/.exec(html)?.[1];
  expect(style).toBeDefined();
  return Object.fromEntries(
    (style ?? "").split(";").map((declaration) => {
      const separator = declaration.indexOf(":");
      return [declaration.slice(0, separator), declaration.slice(separator + 1)];
    }),
  );
}

describe("ChatMarkdown workspace images", () => {
  beforeEach(() => {
    testState.resources = [];
    testState.assetState = "success";
  });

  it.each([
    [
      "/workspace/project",
      "docs/README.md",
      "/workspace/project/docs/images/diagram.png",
      "docs/images/diagram.png",
    ],
    [
      "C:\\Users\\shawn\\project",
      "docs\\README.md",
      "C:\\Users\\shawn\\project\\docs\\images\\diagram.png",
      "docs/images/diagram.png",
    ],
    [
      "/workspace/project",
      "README.md",
      "/workspace/project/images/diagram.png",
      "images/diagram.png",
    ],
  ])(
    "uses rooted asset access for standalone, inline, and centered images beside a file in %s",
    (cwd, relativePath, expectedPath, expectedRelativePath) => {
      for (const markdown of [
        "![diagram](images/diagram.png)",
        'Inline <img src="images/diagram.png" width="36" height="24"> badge.',
        '<p align="center"><img src="images/diagram.png" width="240"></p>',
      ]) {
        testState.resources = [];
        renderFilePreview(cwd, relativePath, markdown);

        expect(testState.resources).toEqual([
          {
            _tag: "workspace-file",
            cwd,
            relativePath: expectedRelativePath,
            threadId: threadRef.threadId,
            path: expectedPath,
          },
        ]);
      }
    },
  );

  it("loads every Windows workspace path form through a signed asset URL", () => {
    const imagePath = "C:/Users/shawn/project/.t3/workspace-image.svg";
    const html = render(
      [
        "![relative](.t3/workspace-image.svg)",
        `![absolute](${imagePath})`,
        `![file URL](file:///${imagePath})`,
        "![UNC file URL](file://server/share/workspace-image.svg)",
      ].join("\n\n"),
    );

    expect(testState.resources).toEqual([
      {
        _tag: "workspace-file",
        cwd: "C:\\Users\\shawn\\project",
        relativePath: ".t3/workspace-image.svg",
        threadId: threadRef.threadId,
        path: "C:\\Users\\shawn\\project\\.t3\\workspace-image.svg",
      },
      {
        _tag: "workspace-file",
        cwd: "C:\\Users\\shawn\\project",
        relativePath: ".t3/workspace-image.svg",
        threadId: threadRef.threadId,
        path: "C:\\Users\\shawn\\project\\.t3\\workspace-image.svg",
      },
      {
        _tag: "workspace-file",
        cwd: "C:\\Users\\shawn\\project",
        relativePath: ".t3/workspace-image.svg",
        threadId: threadRef.threadId,
        path: "C:\\Users\\shawn\\project\\.t3\\workspace-image.svg",
      },
      {
        _tag: "media-file",
        threadId: threadRef.threadId,
        path: "\\\\server\\share\\workspace-image.svg",
      },
    ]);
    expect(html.match(/https:\/\/signed\.test\/workspace-image\.svg/g)).toHaveLength(4);
    expect(html.match(/data-scient-inline-workspace-image="true"/g)).toHaveLength(3);
    expect(html).toContain("max-w-[min(100%,30rem)]");
    expect(html).toContain("max-h-[30rem]");
    expect(html).not.toContain("Image unavailable");
  });

  it("normalizes a drive-absolute src in raw image HTML", () => {
    const html = render(String.raw`<img src="D:\screens\workspace-image.svg" alt="raw">`);

    expect(testState.resources).toEqual([
      {
        _tag: "media-file",
        threadId: threadRef.threadId,
        path: "D:/screens/workspace-image.svg",
      },
    ]);
    expect(html).toContain("https://signed.test/workspace-image.svg");
  });

  it("keeps a tall image placeholder and loaded image at the same proportional bounds", () => {
    const markdown = '<img src=".t3/workspace-image.svg" alt="sized" width="96" height="128">';
    const loadedStyle = firstInlineStyle(render(markdown));
    testState.assetState = "loading";
    const loadingStyle = firstInlineStyle(render(markdown));

    expect(loadedStyle).toMatchObject({
      width: "96px",
      height: "auto",
      "aspect-ratio": "96 / 128",
      "max-width": "min(100%, 30rem, 22.5rem)",
    });
    expect(loadingStyle).toEqual(loadedStyle);
  });

  it.each([
    ["width", "max-width", "min(100%, 30rem, 300px)"],
    ["height", "max-height", "min(30rem, 300px)"],
  ])("treats a lone authored %s as a cap", (axis, constraint, expectedValue) => {
    const markdown = `<img src=".t3/workspace-image.svg" alt="sized" ${axis}="300">`;
    const loadedStyle = firstInlineStyle(render(markdown));

    expect(loadedStyle).not.toHaveProperty(axis);
    expect(loadedStyle).toHaveProperty(constraint, expectedValue);
  });

  it("keeps all images baseline-aligned and workspace images inline", () => {
    const html = render(
      "![remote](https://example.com/badge.svg) ![workspace](.t3/workspace-image.svg)",
    );
    const classNames = Array.from(html.matchAll(/<img[^>]*class="([^"]*)"/g), (match) =>
      match[1]?.split(" "),
    );

    expect(classNames).toHaveLength(2);
    expect(classNames[1]).toContain("inline-block!");

    const centeredHtml = render(
      '<p align="center"><img src=".t3/workspace-image.svg" alt="logo"></p>',
    );
    const centeredClassName = /<img[^>]*class="([^"]*)"/.exec(centeredHtml)?.[1];

    expect(centeredClassName?.split(" ")).toContain("inline-block!");
  });

  it("retains an authored SVG fragment on the signed URL", () => {
    const html = render("![logo](icons.svg#logo)");

    expect(html).toContain('src="https://signed.test/workspace-image.svg#logo"');
  });

  it.each(["success", "loading", "failure", "no-thread"] as const)(
    "copies the authored workspace source (%s)",
    (scenario) => {
      if (scenario === "no-thread") {
        const html = renderWithoutThread("![diagram](images/diagram.png)");
        expect(copiedMarkdownFrom(html)).toBe("![diagram](images/diagram.png)");
        return;
      }

      testState.assetState = scenario;
      const html = render("![diagram](images/diagram.png#preview)");

      expect(copiedMarkdownFrom(html)).toBe("![diagram](images/diagram.png#preview)");
    },
  );

  it("copies an authored title with a workspace image", () => {
    const html = render('![logo](images/logo.svg "My Title")');

    expect(copiedMarkdownFrom(html)).toBe('![logo](images/logo.svg "My Title")');
  });

  it("projects standalone image titles as captions in files while preserving ordinary chat", () => {
    const markdown = '![logo](images/logo.svg "Visible caption")';
    const file = renderFilePreview("C:\\Users\\shawn\\project", "notes.md", markdown);
    expect(file).toContain(">Visible caption</span>");
    expect(copiedMarkdownFrom(file)).toBe(markdown);
    expect(render(markdown)).not.toContain(">Visible caption</span>");
    const remote = renderFilePreview(
      "C:\\Users\\shawn\\project",
      "notes.md",
      '![logo](https://images.test/logo.svg "Remote caption")',
    );
    expect(remote).toContain(">Remote caption</span>");
  });

  it("keeps titles on inline, linked, and table file images out of the figure caption flow", () => {
    for (const markdown of [
      'Before ![logo](images/logo.svg "Compact title") after.',
      '[![logo](images/logo.svg "Compact title")](https://example.test)',
      '| Image |\n| --- |\n| ![logo](images/logo.svg "Compact title") |',
      '<table><tr><td><p><img src="images/logo.svg" alt="logo" title="Compact title"></p></td></tr></table>',
    ]) {
      expect(renderFilePreview("C:\\Users\\shawn\\project", "notes.md", markdown)).not.toContain(
        ">Compact title</span>",
      );
    }
  });

  it("escapes double quotes in an authored image title", () => {
    const html = render(`![logo](images/logo.svg 'My "Title"')`);

    expect(copiedMarkdownFrom(html)).toBe('![logo](images/logo.svg "My \\"Title\\"")');
  });

  it("escapes a closing bracket in authored image alt text", () => {
    const markdown = String.raw`![build\] badge](badge.svg)`;

    expect(copiedMarkdownFrom(render(markdown))).toBe(markdown);
  });

  it("escapes a literal backslash in authored image alt text", () => {
    const markdown = String.raw`![folder\\name](badge.svg)`;

    expect(copiedMarkdownFrom(render(markdown))).toBe(markdown);
  });

  it("escapes a literal backslash before a quote in an authored image title", () => {
    const html = render(
      String.raw`<img src="images/logo.svg" alt="logo" title="Path \&quot;Title\&quot;">`,
    );

    expect(copiedMarkdownFrom(html)).toBe(
      String.raw`![logo](images/logo.svg "Path \\\"Title\\\"")`,
    );
  });

  it.each([true, false])(
    "keeps the standalone Scient figure while a signed asset URL loads (raw HTML: %s)",
    (parseRawHtml) => {
      testState.assetState = "loading";

      const html = render("![loading](.t3/workspace-image.svg)", parseRawHtml);

      expect(html).toContain("Loading image…");
      expect(html).toContain('data-scient-inline-workspace-image="true"');
      expect(html).not.toContain("animate-pulse");
    },
  );

  it("uses a bounded inline placeholder without inserting figure chrome into a sentence", () => {
    testState.assetState = "loading";
    const html = render("Status ![badge](.t3/workspace-image.svg) continues.");
    const className = /<span[^>]*aria-label="Loading image"[^>]*class="([^"]*)"/.exec(html)?.[1];
    expect(className?.split(" ")).toContain("w-64");
    expect(html).not.toContain("data-scient-inline-workspace-image");
  });

  it("never passes a workspace source to a raw image when thread context is unavailable", () => {
    const html = renderWithoutThread(
      "![file URL](file:///C:/Users/shawn/project/workspace-image.svg)",
    );

    expect(testState.resources).toEqual([]);
    expect(html).toContain("Image preview is unavailable without an active workspace.");
    expect(html).toContain('data-scient-inline-workspace-image-pending="unavailable"');
    expect(html).not.toContain("file://");
  });

  it("blocks unsupported image schemes instead of passing them to a raw image", () => {
    const html = render("![unsupported](content://media/image/1)");

    expect(testState.resources).toEqual([]);
    expect(html).toContain("Image unavailable");
    expect(html).not.toContain("content://");
  });

  it("keeps remote images directly loadable", () => {
    const html = render("![remote](https://example.com/image.png)");

    expect(testState.resources).toEqual([]);
    expect(html).toContain('src="https://example.com/image.png"');
    expect(html).toContain("max-w-[min(100%,30rem)]");
    expect(html).toContain("max-h-[30rem]");
    expect(html).not.toContain("Image unavailable");
  });
});
