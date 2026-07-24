// FILE: HtmlArtifactPreview.test.ts
// Purpose: Rendering, navigation, and lifecycle coverage for full local HTML sites.

import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  HtmlArtifactPreview,
  type HtmlArtifactPreviewShape,
} from "../Services/HtmlArtifactPreview";
import { HtmlArtifactPreviewLive } from "./HtmlArtifactPreview";

const temporaryDirectories: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "scient-html-preview-"));
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

interface PreviewResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

async function requestPreview(
  previewUrl: string,
  pathname?: string,
  input: { method?: string; host?: string; headers?: http.OutgoingHttpHeaders } = {},
): Promise<PreviewResponse> {
  const url = new URL(previewUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: Number(url.port),
        path: pathname ?? url.pathname,
        method: input.method ?? "GET",
        headers: { Host: input.host ?? url.host, ...input.headers },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function withPreviewService<A>(use: (service: HtmlArtifactPreviewShape) => Promise<A>): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* HtmlArtifactPreview;
        return yield* Effect.promise(() => use(service));
      }).pipe(Effect.provide(HtmlArtifactPreviewLive)),
    ),
  );
}

describe("HtmlArtifactPreviewLive", () => {
  it("serves static HTML and ordinary sibling assets without an injected CSP", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(
      path.join(workspace, "report.css"),
      "body { color: green; background-image: url('./paper.png'); }",
    );
    await fs.writeFile(path.join(workspace, "paper.png"), "image-bytes");
    await fs.writeFile(path.join(workspace, "unreferenced.css"), "body { color: red; }");
    await fs.writeFile(path.join(workspace, "ignored.js"), "window.pwned = true;");
    await fs.writeFile(
      path.join(workspace, "report.html"),
      '<link rel="stylesheet" href="report.css"><h1>Report</h1>',
    );

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "report.html" }),
      );
      expect(prepared.mode).toBe("static-document");
      expect(prepared.previewUrl).toBeDefined();

      const document = await requestPreview(prepared.previewUrl!);
      expect(document.status).toBe(200);
      expect(document.body).toContain("<h1>Report</h1>");
      expect(document.headers["content-security-policy"]).toBeUndefined();

      const stylesheet = await requestPreview(prepared.previewUrl!, "/report.css");
      expect(stylesheet.status).toBe(200);
      expect(stylesheet.body).toContain("color: green");
      await expect(requestPreview(prepared.previewUrl!, "/paper.png")).resolves.toMatchObject({
        status: 200,
      });
      await expect(
        requestPreview(prepared.previewUrl!, "/unreferenced.css"),
      ).resolves.toMatchObject({ status: 200 });

      await expect(requestPreview(prepared.previewUrl!, "/ignored.js")).resolves.toMatchObject({
        status: 200,
      });
    });
  });

  it("preserves the entry path when local resources live in a parent directory", async () => {
    const workspace = await makeWorkspace();
    await fs.mkdir(path.join(workspace, "reports"));
    await fs.mkdir(path.join(workspace, "assets"));
    await fs.writeFile(path.join(workspace, "assets", "theme.css"), "body { color: green; }");
    await fs.writeFile(
      path.join(workspace, "reports", "report.html"),
      '<link rel="stylesheet" href="../assets/theme.css"><h1>Parent asset</h1>',
    );

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "reports/report.html" }),
      );
      expect(new URL(prepared.previewUrl!).pathname).toBe("/reports/report.html");
      await expect(requestPreview(prepared.previewUrl!)).resolves.toMatchObject({
        status: 200,
        body: expect.stringContaining("Parent asset"),
      });
      await expect(
        requestPreview(prepared.previewUrl!, "/assets/theme.css"),
      ).resolves.toMatchObject({
        status: 200,
        body: expect.stringContaining("color: green"),
      });
    });
  });

  it("serves browser-ready JavaScript and dynamic resources without a rollout switch", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(
      path.join(workspace, "app.js"),
      "import './chunk.js'; document.body.dataset.ready = 'yes';",
    );
    await fs.writeFile(path.join(workspace, "chunk.js"), "export const ready = true;");
    await fs.writeFile(path.join(workspace, "secret.js"), "export const secret = 'no';");
    await fs.writeFile(
      path.join(workspace, "index.html"),
      '<script type="module" src="app.js"></script>',
    );

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "index.html" }),
      );
      expect(prepared.mode).toBe("interactive-bundle");
      const document = await requestPreview(prepared.previewUrl!);
      expect(document.headers["content-security-policy"]).toBeUndefined();
      await expect(requestPreview(prepared.previewUrl!, "/app.js")).resolves.toMatchObject({
        status: 200,
      });
      await expect(requestPreview(prepared.previewUrl!, "/chunk.js")).resolves.toMatchObject({
        status: 200,
      });
      await expect(requestPreview(prepared.previewUrl!, "/secret.js")).resolves.toMatchObject({
        status: 200,
      });
    });
  });

  it("supports byte ranges for local media and other large site assets", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "index.html"), '<video src="clip.mp4"></video>');
    await fs.writeFile(path.join(workspace, "clip.mp4"), "0123456789");

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "index.html" }),
      );
      const response = await requestPreview(prepared.previewUrl!, "/clip.mp4", {
        headers: { Range: "bytes=2-5" },
      });
      expect(response).toMatchObject({ status: 206, body: "2345" });
      expect(response.headers["accept-ranges"]).toBe("bytes");
      expect(response.headers["content-range"]).toBe("bytes 2-5/10");
    });
  });

  it("keeps the local-site origin separate from app routes and rejects invalid hosts, methods, and traversal", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, ".env"), "SECRET=value");
    await fs.writeFile(path.join(workspace, "index.html"), "<p>Safe</p>");

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "index.html" }),
      );
      const url = prepared.previewUrl!;

      for (const pathname of [
        "/api/auth/session",
        "/ws",
        "/.env",
        "/../outside",
        "/%2e%2e/outside",
      ]) {
        await expect(requestPreview(url, pathname)).resolves.toMatchObject({ status: 404 });
      }
      await expect(requestPreview(url, "/", { method: "POST" })).resolves.toMatchObject({
        status: 404,
      });
      await expect(
        requestPreview(url, "/", { host: `invalid.preview.localhost:${new URL(url).port}` }),
      ).resolves.toMatchObject({ status: 404 });
    });
  });

  it("rejects sibling symlinks that escape the granted directory", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    await fs.writeFile(path.join(outside, "secret.css"), "body::before { content: 'secret'; }");
    await fs.symlink(path.join(outside, "secret.css"), path.join(workspace, "secret.css"));
    await fs.writeFile(
      path.join(workspace, "index.html"),
      '<link rel="stylesheet" href="secret.css">',
    );

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "index.html" }),
      );
      await expect(requestPreview(prepared.previewUrl!, "/secret.css")).resolves.toMatchObject({
        status: 404,
      });
    });
  });

  it("revalidates the root file after it is replaced by an escaping symlink", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    const entryPath = path.join(workspace, "index.html");
    await fs.writeFile(entryPath, "<p>Original</p>");
    await fs.writeFile(path.join(outside, "secret.html"), "<p>Secret</p>");

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "index.html" }),
      );
      await fs.rm(entryPath);
      await fs.symlink(path.join(outside, "secret.html"), entryPath);

      const response = await requestPreview(prepared.previewUrl!);
      expect(response.status).toBe(404);
      expect(response.body).not.toContain("Secret");
    });
  });

  it("revokes a capability explicitly and refuses every later request", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "index.html"), "<p>Short lived</p>");

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "index.html" }),
      );
      expect((await requestPreview(prepared.previewUrl!)).status).toBe(200);
      await expect(
        Effect.runPromise(service.revoke({ previewUrl: prepared.previewUrl! })),
      ).resolves.toEqual({ revoked: true });
      await expect(requestPreview(prepared.previewUrl!)).resolves.toMatchObject({ status: 404 });
    });
  });

  it("bounds abandoned grants and evicts the oldest capability", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "index.html"), "<p>Bounded</p>");

    await withPreviewService(async (service) => {
      const urls: string[] = [];
      for (let index = 0; index < 513; index += 1) {
        const prepared = await Effect.runPromise(
          service.prepare({ cwd: workspace, path: "index.html" }),
        );
        urls.push(prepared.previewUrl!);
      }
      await expect(requestPreview(urls[0]!)).resolves.toMatchObject({ status: 404 });
      await expect(requestPreview(urls.at(-1)!)).resolves.toMatchObject({ status: 200 });
    });
  });

  it("opens executable HTML by default", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "app.js"), "document.body.dataset.ready = 'yes';");
    await fs.writeFile(
      path.join(workspace, "index.html"),
      '<script type="module" src="app.js"></script>',
    );
    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "index.html" }),
      );
      expect(prepared.mode).toBe("interactive-bundle");
      expect(prepared.previewUrl).toBeDefined();
      await expect(requestPreview(prepared.previewUrl!, "/app.js")).resolves.toMatchObject({
        status: 200,
      });
    });
  });

  it("opens an absolute HTML file outside the active workspace", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    const outsideFile = path.join(outside, "report.html");
    await fs.writeFile(outsideFile, "<h1>External report</h1>");
    await fs.writeFile(path.join(outside, "theme.css"), "body { color: rebeccapurple; }");

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: outsideFile }),
      );
      expect(prepared.previewUrl).toBeDefined();
      await expect(requestPreview(prepared.previewUrl!)).resolves.toMatchObject({
        status: 200,
        body: expect.stringContaining("External report"),
      });
      await expect(requestPreview(prepared.previewUrl!, "/theme.css")).resolves.toMatchObject({
        status: 200,
      });
    });
  });

  it("loads parent-directory assets for an absolute HTML file", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    await fs.mkdir(path.join(outside, "reports"));
    await fs.mkdir(path.join(outside, "assets"));
    await fs.writeFile(path.join(outside, "assets", "theme.css"), "body { color: teal; }");
    const outsideFile = path.join(outside, "reports", "report.html");
    await fs.writeFile(
      outsideFile,
      '<link rel="stylesheet" href="../assets/theme.css"><h1>External report</h1>',
    );

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: outsideFile }),
      );
      expect(new URL(prepared.previewUrl!).pathname).toBe("/reports/report.html");
      await expect(
        requestPreview(prepared.previewUrl!, "/assets/theme.css"),
      ).resolves.toMatchObject({
        status: 200,
        body: expect.stringContaining("color: teal"),
      });
    });
  });
});
