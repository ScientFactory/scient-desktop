import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  resources: [] as Array<unknown>,
  assetState: "success" as "success" | "loading" | "failure",
}));

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
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlRefresh: () => vi.fn(),
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    testState.resources.push(resource);
    if (testState.assetState === "loading") return { _tag: "Loading" };
    if (testState.assetState === "failure") return { _tag: "Failure" };
    return {
      _tag: "Success",
      url: "https://signed.test/workspace-image.svg",
    };
  },
}));
vi.mock("../hooks/useTheme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useTheme")>()),
  useTheme: () => ({ resolvedTheme: "dark" }),
  useRenderedAppearance: () => "dark",
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "None" }),
  useEnvironmentScope: () => false,
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";
import { FileMarkdownPreview } from "./files/FileMarkdownPreview";

const threadRef = {
  environmentId: EnvironmentId.make("env-windows"),
  threadId: ThreadId.make("thread-windows"),
};

function render(
  markdown: string,
  parseRawHtml = true,
  contentDirection?: "auto" | "ltr" | "rtl",
): string {
  return renderToStaticMarkup(
    <ChatMarkdown
      cwd={"C:\\Users\\shawn\\project"}
      threadRef={threadRef}
      text={markdown}
      parseRawHtml={parseRawHtml}
      {...(contentDirection === undefined ? {} : { contentDirection })}
    />,
  );
}

function renderWithoutThread(markdown: string): string {
  return renderToStaticMarkup(<ChatMarkdown cwd={"C:\\Users\\shawn\\project"} text={markdown} />);
}

function renderFilePreview(cwd: string, relativePath: string, text: string): string {
  return renderToStaticMarkup(
    <FileMarkdownPreview
      cwd={cwd}
      relativePath={relativePath}
      text={text}
      threadRef={threadRef}
      workspaceMutationId={null}
    />,
  );
}

function copiedMarkdownFrom(html: string): string {
  const copy = /data-markdown-copy="([^"]*)"/.exec(html)?.[1]?.replaceAll("&quot;", '"');
  expect(copy).toBeDefined();
  return copy ?? "";
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
    ]);
    expect(html.match(/<img[^>]+src="https:\/\/signed\.test\/workspace-image\.svg"/g)).toHaveLength(
      3,
    );
    expect(html.match(/data-scient-inline-workspace-image="true"/g)).toHaveLength(3);
    expect(
      html.match(/<img[^>]+class="[^"]*max-h-\[32rem\] max-w-full object-contain/g),
    ).toHaveLength(3);
    expect(html.match(/data-scient-visual-card[^>]+class="[^"]*max-w-full/g)).toHaveLength(3);
    expect(html).not.toContain("Image unavailable");
  });

  it("signs images on the workspace UNC share without contacting another share", () => {
    const cwd = "\\\\server\\share";
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd={cwd}
        threadRef={threadRef}
        text={[
          "![authorized](file://server/share/workspace-image.svg)",
          "![different host](file://another-server/share/workspace-image.svg)",
          "![different share](file://server/another-share/workspace-image.svg)",
        ].join("\n\n")}
      />,
    );
    expect(testState.resources).toEqual([
      {
        _tag: "workspace-file",
        cwd,
        relativePath: "workspace-image.svg",
        threadId: threadRef.threadId,
        path: "\\\\server\\share\\workspace-image.svg",
      },
    ]);
    expect(html.match(/<img[^>]+src="https:\/\/signed\.test\/workspace-image\.svg"/g)).toHaveLength(
      1,
    );
  });

  it("loads a POSIX absolute path and file URI through a signed asset URL", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/workspace/project"
        threadRef={threadRef}
        text={[
          "![absolute](/tmp/embed-test/2.png)",
          "![file URL](file:///tmp/embed-test/5.png)",
        ].join("\n\n")}
      />,
    );

    expect(testState.resources).toEqual([
      { _tag: "media-file", threadId: threadRef.threadId, path: "/tmp/embed-test/2.png" },
      { _tag: "media-file", threadId: threadRef.threadId, path: "/tmp/embed-test/5.png" },
    ]);
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

  it("keeps an authored id on a remote image so fragment links resolve", () => {
    const html = render('<img id="diagram" src="https://example.com/diagram.png" alt="diagram">');

    // The sanitizer prefixes authored ids; the link card carries it until the image loads.
    expect(html).toContain('<span id="user-content-diagram" role="group"');
  });

  it("retains an authored SVG fragment on the signed URL", () => {
    const html = render("![logo](icons.svg#logo)");

    expect(html).toContain('src="https://signed.test/workspace-image.svg#logo"');
  });

  it.each(["loading", "failure", "no-thread"] as const)(
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
    // A web figure in a file preview is a referenced link until loaded, like chat.
    expect(remote).not.toContain('src="https://images.test/logo.svg"');
    expect(remote).toContain('aria-label="Web image: logo"');
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

  it("escapes a closing bracket in authored image alt text", () => {
    const markdown = String.raw`![build\] badge](badge.svg)`;

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

  it("keeps standalone workspace images and BiDi in literal-HTML mode", () => {
    testState.assetState = "loading";

    const html = render(
      [
        "שלב ראשון → שלב שני",
        "![loading](.t3/workspace-image.svg)",
        "<script>globalThis.__scientXss = 1</script>",
      ].join("\n\n"),
      false,
      "rtl",
    );

    expect(html).toContain("שלב ראשון ← שלב שני");
    expect(html).toContain("Loading image…");
    expect(html).toContain('data-scient-inline-workspace-image="true"');
    expect(html).toContain("&lt;script&gt;globalThis.__scientXss = 1&lt;/script&gt;");
    expect(html).not.toMatch(/<script(?:\s|>)/iu);
  });

  it("uses a bounded inline placeholder without inserting figure chrome into a sentence", () => {
    testState.assetState = "loading";
    const html = render("Status ![badge](.t3/workspace-image.svg) continues.");
    const className = /<span[^>]*aria-label="Loading image"[^>]*class="([^"]*)"/.exec(html)?.[1];
    expect(className?.split(" ")).not.toContain("aspect-video");
    expect(html).not.toContain("data-scient-inline-workspace-image");
  });

  it("gives a standalone remote image a link card instead of a loading frame", () => {
    const html = render("![remote](https://example.com/shot.png)");

    expect(html).toContain('aria-label="Web image: remote"');
    expect(html).not.toContain('aria-label="Loading image"');
    expect(html).not.toContain("aspect-video");
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

  it("shows remote images as a referenced link without requesting them", () => {
    const html = render("![remote](https://example.com/image.png)");

    expect(testState.resources).toEqual([]);
    expect(html).not.toMatch(/<img[^>]*src="https:\/\/example\.com/);
    expect(html).toContain('href="https://example.com/image.png"');
    expect(html).toContain(">Load image</button>");
    expect(html).not.toContain("Image unavailable");
  });

  it("leaves data and blob sources to the existing image path", () => {
    const html = render("![inline](data:image/png;base64,iVBORw0KGgo=) ![b](blob:https://x/1)");

    expect(testState.resources).toEqual([]);
    expect(html).not.toContain("Load image");
    expect(html).not.toContain('role="group"');
  });
});
