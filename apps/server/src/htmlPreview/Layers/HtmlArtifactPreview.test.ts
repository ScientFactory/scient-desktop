// FILE: HtmlArtifactPreview.test.ts
// Purpose: Security and rendering coverage for the isolated HTML preview listener.

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
  pathname = "/",
  input: { method?: string; host?: string } = {},
): Promise<PreviewResponse> {
  const url = new URL(previewUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: Number(url.port),
        path: pathname,
        method: input.method ?? "GET",
        headers: { Host: input.host ?? url.host },
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
  it("serves static HTML and presentation assets while refusing JavaScript", async () => {
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
      expect(document.headers["content-security-policy"]).toContain("script-src 'none'");
      expect(document.headers["permissions-policy"]).toContain("camera=()");

      const stylesheet = await requestPreview(prepared.previewUrl!, "/report.css");
      expect(stylesheet.status).toBe(200);
      expect(stylesheet.body).toContain("color: green");
      await expect(requestPreview(prepared.previewUrl!, "/paper.png")).resolves.toMatchObject({
        status: 200,
      });
      await expect(
        requestPreview(prepared.previewUrl!, "/unreferenced.css"),
      ).resolves.toMatchObject({ status: 404 });

      await expect(requestPreview(prepared.previewUrl!, "/ignored.js")).resolves.toMatchObject({
        status: 404,
      });
    });
  });

  it("serves browser-ready JavaScript only under the interactive policy", async () => {
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

    const previous = process.env.SCIENT_EXECUTABLE_HTML_PREVIEW;
    process.env.SCIENT_EXECUTABLE_HTML_PREVIEW = "1";
    try {
      await withPreviewService(async (service) => {
        const prepared = await Effect.runPromise(
          service.prepare({ cwd: workspace, path: "index.html" }),
        );
        const document = await requestPreview(prepared.previewUrl!);
        expect(document.headers["content-security-policy"]).toContain(
          "script-src 'self' 'unsafe-inline'",
        );
        expect(document.headers["content-security-policy"]).not.toContain("unsafe-eval");
        await expect(requestPreview(prepared.previewUrl!, "/app.js")).resolves.toMatchObject({
          status: 200,
        });
        await expect(requestPreview(prepared.previewUrl!, "/chunk.js")).resolves.toMatchObject({
          status: 200,
        });
        await expect(requestPreview(prepared.previewUrl!, "/secret.js")).resolves.toMatchObject({
          status: 404,
        });
      });
    } finally {
      if (previous === undefined) delete process.env.SCIENT_EXECUTABLE_HTML_PREVIEW;
      else process.env.SCIENT_EXECUTABLE_HTML_PREVIEW = previous;
    }
  });

  it("exposes no application routes and rejects invalid hosts, methods, dotfiles, and traversal", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, ".env"), "SECRET=value");
    await fs.writeFile(path.join(workspace, "index.html"), "<p>Safe</p>");

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "index.html" }),
      );
      const url = prepared.previewUrl!;

      for (const pathname of ["/api/auth/session", "/ws", "/.env", "/../.env", "/%2e%2e/.env"]) {
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
      for (let index = 0; index < 129; index += 1) {
        const prepared = await Effect.runPromise(
          service.prepare({ cwd: workspace, path: "index.html" }),
        );
        urls.push(prepared.previewUrl!);
      }
      await expect(requestPreview(urls[0]!)).resolves.toMatchObject({ status: 404 });
      await expect(requestPreview(urls.at(-1)!)).resolves.toMatchObject({ status: 200 });
    });
  });

  it("keeps executable previews fail-closed behind an operational rollout switch", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "app.js"), "document.body.dataset.ready = 'yes';");
    await fs.writeFile(
      path.join(workspace, "index.html"),
      '<script type="module" src="app.js"></script>',
    );
    const previous = process.env.SCIENT_EXECUTABLE_HTML_PREVIEW;
    delete process.env.SCIENT_EXECUTABLE_HTML_PREVIEW;
    try {
      await withPreviewService(async (service) => {
        const prepared = await Effect.runPromise(
          service.prepare({ cwd: workspace, path: "index.html" }),
        );
        expect(prepared.mode).toBe("unsupported");
        expect(prepared.previewUrl).toBeUndefined();
        expect(prepared.reason).toContain("rollout switch");
      });
    } finally {
      if (previous === undefined) delete process.env.SCIENT_EXECUTABLE_HTML_PREVIEW;
      else process.env.SCIENT_EXECUTABLE_HTML_PREVIEW = previous;
    }
  });
});
