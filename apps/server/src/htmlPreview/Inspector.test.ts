// FILE: Inspector.test.ts
// Purpose: Regression coverage for fail-safe HTML artifact classification.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectHtmlArtifact } from "./Inspector";

const temporaryDirectories: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "scient-html-inspector-"));
  temporaryDirectories.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("inspectHtmlArtifact", () => {
  it("classifies a standalone document with local presentation assets", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "lesson.css"), "body { color: green; }");
    await fs.writeFile(
      path.join(workspace, "lesson.html"),
      '<!doctype html><title>Lesson</title><link rel="stylesheet" href="lesson.css"><h1>Study</h1>',
    );

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: "lesson.html" });

    expect(inspected.result).toEqual({
      mode: "static-document",
      title: "Lesson",
      warnings: [],
    });
    expect(inspected.absolutePath).toBe(await fs.realpath(path.join(workspace, "lesson.html")));
    expect(inspected.allowedResourcePaths).toEqual([
      await fs.realpath(path.join(workspace, "lesson.css")),
    ]);
  });

  it("classifies inline and browser-ready JavaScript as an interactive bundle", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "app.js"), "document.body.dataset.ready = 'yes';");
    await fs.writeFile(
      path.join(workspace, "index.html"),
      '<script>window.inline = true</script><script type="module" src="app.js"></script>',
    );

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: "index.html" });

    expect(inspected.result.mode).toBe("interactive-bundle");
    expect(inspected.result.warnings).toEqual([]);
  });

  it("collects literal fetch/worker assets, inline CSS, and linked HTML transitively", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "data.json"), '{"ok":true}');
    await fs.writeFile(path.join(workspace, "worker.js"), "postMessage('ready');");
    await fs.writeFile(path.join(workspace, "dynamic.png"), "png");
    await fs.writeFile(path.join(workspace, "dynamic.html"), "<p>Dynamic</p>");
    await fs.writeFile(path.join(workspace, "background.svg"), "<svg></svg>");
    await fs.writeFile(
      path.join(workspace, "app.js"),
      'fetch("data.json"); new Worker("worker.js", { type: "module" });',
    );
    await fs.writeFile(path.join(workspace, "linked.css"), "body { color: navy; }");
    await fs.writeFile(
      path.join(workspace, "linked.html"),
      '<link rel="stylesheet" href="linked.css"><p>Linked</p>',
    );
    await fs.writeFile(
      path.join(workspace, "index.html"),
      [
        '<style>body { background-image: url("background.svg") }</style>',
        '<a href="linked.html">Linked</a>',
        '<script type="module" src="app.js"></script>',
        '<script>image.src = "dynamic.png"; location.assign("dynamic.html")</script>',
      ].join(""),
    );

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: "index.html" });

    expect(new Set(inspected.allowedResourcePaths)).toEqual(
      new Set(
        await Promise.all(
          [
            "app.js",
            "data.json",
            "worker.js",
            "background.svg",
            "linked.html",
            "linked.css",
            "dynamic.png",
            "dynamic.html",
          ].map((file) => fs.realpath(path.join(workspace, file))),
        ),
      ),
    );
  });

  it("elevates a static entry when a granted child document is executable", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(
      path.join(workspace, "runner.html"),
      '<script>document.body.dataset.ready = "yes"</script><img src="https://cdn.example/bit-one.png">',
    );
    await fs.writeFile(
      path.join(workspace, "index.html"),
      '<iframe src="runner.html"></iframe><img src="https://cdn.example/bit-zero.png">',
    );

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: "index.html" });

    expect(inspected.result.mode).toBe("interactive-bundle");
    expect(inspected.allowedResourcePaths).toContain(
      await fs.realpath(path.join(workspace, "runner.html")),
    );
    expect(new Set(inspected.allowedExternalUrls)).toEqual(
      new Set(["https://cdn.example/bit-zero.png", "https://cdn.example/bit-one.png"]),
    );
    expect(inspected.result.warnings).toContainEqual({
      code: "external-resource-blocked",
      message:
        "External network resources are blocked for interactive local HTML; bundle them into the same site directory instead.",
    });
  });

  it("treats an active SVG subdocument as executable content", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(
      path.join(workspace, "active.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>document.documentElement.dataset.ready = "yes"</script></svg>',
    );
    await fs.writeFile(
      path.join(workspace, "index.html"),
      '<object data="active.svg" type="image/svg+xml"></object>',
    );

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: "index.html" });

    expect(inspected.result.mode).toBe("interactive-bundle");
    expect(inspected.allowedResourcePaths).toContain(
      await fs.realpath(path.join(workspace, "active.svg")),
    );
  });

  it("fails closed when executable entry content may be beyond the inspection prefix", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "local.png"), "png");
    const inspectedPrefix = '<img src="local.png"><img src="https://cdn.example/bit-zero.png">';
    await fs.writeFile(
      path.join(workspace, "large.html"),
      `${inspectedPrefix.padEnd(1_000_001, " ")}<script>window.afterPrefix = true</script>`,
    );

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: "large.html" });

    expect(inspected.result.mode).toBe("interactive-bundle");
    expect(inspected.allowedResourcePaths).toContain(
      await fs.realpath(path.join(workspace, "local.png")),
    );
    expect(inspected.result.warnings).toContainEqual({
      code: "inspection-truncated",
      message:
        "Only the beginning of this large HTML file was inspected; the full file will still open.",
    });
  });

  it("fails closed but preserves prefix assets for a truncated active child", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "child.css"), "body { color: teal; }");
    const inspectedPrefix =
      '<link rel="stylesheet" href="child.css"><img src="https://cdn.example/bit-one.png">';
    await fs.writeFile(
      path.join(workspace, "child.html"),
      `${inspectedPrefix.padEnd(1_000_001, " ")}<script>window.afterPrefix = true</script>`,
    );
    await fs.writeFile(path.join(workspace, "index.html"), '<iframe src="child.html"></iframe>');

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: "index.html" });

    expect(inspected.result.mode).toBe("interactive-bundle");
    expect(new Set(inspected.allowedResourcePaths)).toEqual(
      new Set(
        await Promise.all(
          ["child.html", "child.css"].map((file) => fs.realpath(path.join(workspace, file))),
        ),
      ),
    );
    expect(inspected.result.warnings).toContainEqual({
      code: "inspection-truncated",
      message:
        "Only the beginning of a linked active document was inspected; it will open in interactive mode and its discovered assets remain available.",
    });
  });

  it("recognizes entity-decoded whitespace inside an entry javascript URL", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(
      path.join(workspace, "index.html"),
      '<a href="java&#x09;script:document.body.dataset.ready=true">Run</a><img src="https://cdn.example/declared.png">',
    );

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: "index.html" });

    expect(inspected.result.mode).toBe("interactive-bundle");
    expect(inspected.result.warnings).toContainEqual({
      code: "external-resource-blocked",
      message:
        "External network resources are blocked for interactive local HTML; bundle them into the same site directory instead.",
    });
  });

  it("recognizes entity-decoded whitespace inside a child javascript URL", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(
      path.join(workspace, "child.html"),
      '<form><button formaction="java&#x0a;script:document.body.dataset.ready=true">Run</button></form>',
    );
    await fs.writeFile(path.join(workspace, "index.html"), '<object data="child.html"></object>');

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: "index.html" });

    expect(inspected.result.mode).toBe("interactive-bundle");
  });

  it("recursively classifies executable srcdoc markup", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(
      path.join(workspace, "index.html"),
      '<iframe srcdoc="&lt;a href=&quot;java&amp;#x0d;script:document.body.dataset.ready=true&quot;&gt;Run&lt;/a&gt;"></iframe>',
    );

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: "index.html" });

    expect(inspected.result.mode).toBe("interactive-bundle");
  });

  it("honors document base URLs, root-relative assets, inline modules, and quoted CSS spaces", async () => {
    const workspace = await makeWorkspace();
    await fs.mkdir(path.join(workspace, "assets"));
    await fs.writeFile(path.join(workspace, "logo.svg"), "<svg></svg>");
    await fs.writeFile(path.join(workspace, "assets", "hero image.png"), "png");
    await fs.writeFile(
      path.join(workspace, "assets", "theme.css"),
      'body { background-image: url("hero image.png") }',
    );
    await fs.writeFile(path.join(workspace, "assets", "chunk.js"), "export const ready = true;");
    await fs.writeFile(
      path.join(workspace, "index.html"),
      [
        '<base href="assets/">',
        '<link rel="stylesheet" href="theme.css">',
        '<img src="/logo.svg">',
        '<img src="https://cdn.example/declared.png">',
        '<script type="module">import "./chunk.js";</script>',
      ].join(""),
    );

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: "index.html" });

    expect(new Set(inspected.allowedResourcePaths)).toEqual(
      new Set(
        await Promise.all(
          ["assets/theme.css", "assets/hero image.png", "assets/chunk.js", "logo.svg"].map((file) =>
            fs.realpath(path.join(workspace, file)),
          ),
        ),
      ),
    );
    expect(inspected.allowedExternalUrls).toEqual(["https://cdn.example/declared.png"]);
    expect(inspected.result.warnings).toContainEqual({
      code: "external-resource-blocked",
      message:
        "External network resources are blocked for interactive local HTML; bundle them into the same site directory instead.",
    });
  });

  it("does not allow a nested workspace document to nominate a parent secret", async () => {
    const workspace = await makeWorkspace();
    await fs.mkdir(path.join(workspace, "site"));
    await fs.writeFile(path.join(workspace, "credentials.json"), '{"secret":true}');
    await fs.writeFile(
      path.join(workspace, "site", "index.html"),
      '<script>fetch("../credentials.json")</script>',
    );

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: "site/index.html" });

    expect(inspected.allowedResourcePaths).toEqual([]);
    expect(inspected.result.warnings).toContainEqual({
      code: "local-resource-denied",
      message: "Local preview resource is outside the opened file's authority: ../credentials.json",
    });
  });

  it("routes Vite TSX source entrypoints to the nearest package run target", async () => {
    const workspace = await makeWorkspace();
    const appDirectory = path.join(workspace, "packages", "app");
    await fs.mkdir(path.join(appDirectory, "src"), { recursive: true });
    await fs.writeFile(path.join(appDirectory, "bun.lock"), "");
    await fs.writeFile(
      path.join(appDirectory, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } }),
    );
    await fs.writeFile(path.join(appDirectory, "src", "main.tsx"), "export {};\n");
    await fs.writeFile(
      path.join(appDirectory, "index.html"),
      '<main id="root"></main><script type="module" src="/src/main.tsx"></script>',
    );

    const inspected = await inspectHtmlArtifact({
      cwd: workspace,
      path: "packages/app/index.html",
    });

    expect(inspected.result).toMatchObject({
      mode: "dev-server-entrypoint",
      runTarget: {
        cwd: await fs.realpath(appDirectory),
        command: "bun run dev",
        scriptName: "dev",
      },
    });
  });

  it("still opens source-module HTML when no development command can be found", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "main.tsx"), "export {};");
    await fs.writeFile(
      path.join(workspace, "index.html"),
      '<main id="root"></main><script type="module" src="main.tsx"></script>',
    );

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: "index.html" });

    expect(inspected.result.mode).toBe("interactive-bundle");
    expect(inspected.result.runTarget).toBeUndefined();
  });

  it("reports external resources that safe interactive mode will block", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(
      path.join(workspace, "index.html"),
      '<script src="https://cdn.example/app.js"></script>',
    );

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: "index.html" });

    expect(inspected.result.mode).toBe("interactive-bundle");
    expect(inspected.result.warnings).toEqual([
      {
        code: "external-resource-blocked",
        message:
          "External network resources are blocked for interactive local HTML; bundle them into the same site directory instead.",
      },
    ]);
    expect(inspected.allowedExternalUrls).toEqual(["https://cdn.example/app.js"]);
  });

  it("inspects absolute files outside the workspace", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    const outsideFile = path.join(outside, "outside.html");
    await fs.writeFile(outsideFile, "<p>private</p>");

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: outsideFile });

    expect(inspected.result.mode).toBe("static-document");
    expect(inspected.absolutePath).toBe(await fs.realpath(outsideFile));
  });

  it("does not let an absolute file enlarge its authority with parent references", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    const documentDirectory = path.join(outside, "document");
    const privateFile = path.join(outside, "private.txt");
    await fs.mkdir(documentDirectory);
    await fs.writeFile(privateFile, "not preview content");
    await fs.writeFile(
      path.join(documentDirectory, "outside.html"),
      '<link rel="preload" href="../private.txt" as="fetch"><p>Document</p>',
    );

    const inspected = await inspectHtmlArtifact({
      cwd: workspace,
      path: path.join(documentDirectory, "outside.html"),
    });

    expect(inspected.allowedResourcePaths).not.toContain(await fs.realpath(privateFile));
    expect(inspected.result.warnings).toEqual([
      {
        code: "local-resource-denied",
        message: "Local preview resource is outside the opened file's authority: ../private.txt",
      },
    ]);
  });
});
