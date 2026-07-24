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

  it("reports blocked external resources without granting them network access", async () => {
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
        message: "External script blocked in preview: https://cdn.example/app.js",
      },
    ]);
  });

  it("fails closed for files outside the workspace", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    const outsideFile = path.join(outside, "outside.html");
    await fs.writeFile(outsideFile, "<p>private</p>");

    const inspected = await inspectHtmlArtifact({ cwd: workspace, path: outsideFile });

    expect(inspected.result.mode).toBe("unsupported");
    expect(inspected.absolutePath).toBeNull();
  });
});
