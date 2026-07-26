// FILE: HtmlArtifactPreview.test.ts
// Purpose: Rendering, navigation, and lifecycle coverage for full local HTML sites.

import fs from "node:fs/promises";
import { createHmac } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { serializeLocalHtmlCapabilityAuthority } from "@synara/shared/liveHtmlPreviewTransport";

import {
  HtmlArtifactPreview,
  type HtmlArtifactPreviewShape,
} from "../Services/HtmlArtifactPreview";
import { inspectHtmlArtifact } from "../Inspector";
import { HtmlArtifactPreviewLive, makeHtmlArtifactPreviewLayer } from "./HtmlArtifactPreview";

const temporaryDirectories: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "scient-html-preview-"));
  temporaryDirectories.push(workspace);
  return workspace;
}

async function replaceFileAtomically(filePath: string, contents: string): Promise<void> {
  const replacementPath = `${filePath}.replacement`;
  await fs.writeFile(replacementPath, contents);
  await fs.rename(replacementPath, filePath);
}

function sameLengthHtml(left: string, right: string): readonly [string, string] {
  const length = Math.max(left.length, right.length);
  return [left.padEnd(length, " "), right.padEnd(length, " ")];
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

function withPreviewService<A>(
  use: (service: HtmlArtifactPreviewShape) => Promise<A>,
  layer = HtmlArtifactPreviewLive,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* HtmlArtifactPreview;
        return yield* Effect.promise(() => use(service));
      }).pipe(Effect.provide(layer)),
    ),
  );
}

describe("HtmlArtifactPreviewLive", () => {
  it("reinspects an entry document atomically replaced before route pinning", async () => {
    const workspace = await makeWorkspace();
    const sourcePath = path.join(workspace, "report.html");
    const externalScript = "https://cdn.example/report.js";
    await fs.writeFile(sourcePath, `<link rel="preload" href="${externalScript}" as="image">`);
    let inspectionCount = 0;

    await withPreviewService(
      async (service) => {
        const prepared = await Effect.runPromise(
          service.prepare({ cwd: workspace, path: sourcePath }),
        );

        expect(inspectionCount).toBe(2);
        expect(prepared.mode).toBe("interactive-bundle");
        expect(prepared.localHtmlNetworkPolicy).toBe("sealed-interactive");
        expect(prepared.allowedExternalUrls).toEqual([]);
        await expect(requestPreview(prepared.previewUrl!)).resolves.toMatchObject({
          status: 200,
          body: `<script src="${externalScript}"></script>`,
        });
      },
      makeHtmlArtifactPreviewLayer({
        inspectArtifact: async (input) => {
          const inspected = await inspectHtmlArtifact(input);
          inspectionCount += 1;
          if (inspectionCount === 1) {
            await replaceFileAtomically(sourcePath, `<script src="${externalScript}"></script>`);
          }
          return inspected;
        },
      }),
    );
  });

  it("reinspects a linked active document atomically replaced before route pinning", async () => {
    const workspace = await makeWorkspace();
    const sourcePath = path.join(workspace, "report.html");
    const childPath = path.join(workspace, "child.html");
    await fs.writeFile(sourcePath, '<iframe src="child.html"></iframe>');
    await fs.writeFile(childPath, "<p>Inert child</p>");
    let inspectionCount = 0;

    await withPreviewService(
      async (service) => {
        const prepared = await Effect.runPromise(
          service.prepare({ cwd: workspace, path: sourcePath }),
        );

        expect(inspectionCount).toBe(2);
        expect(prepared.mode).toBe("interactive-bundle");
        expect(prepared.localHtmlNetworkPolicy).toBe("sealed-interactive");
        await expect(requestPreview(prepared.previewUrl!, "/child.html")).resolves.toMatchObject({
          status: 200,
          body: "<script>window.changed = true</script>",
        });
      },
      makeHtmlArtifactPreviewLayer({
        inspectArtifact: async (input) => {
          const inspected = await inspectHtmlArtifact(input);
          inspectionCount += 1;
          if (inspectionCount === 1) {
            await replaceFileAtomically(childPath, "<script>window.changed = true</script>");
          }
          return inspected;
        },
      }),
    );
  });

  it("reinspects a same-length entry rewrite before route pinning", async () => {
    const workspace = await makeWorkspace();
    const sourcePath = path.join(workspace, "report.html");
    const [inertSource, activeSource] = sameLengthHtml(
      "<p>Inert entry</p>",
      "<script>window.changed = true</script>",
    );
    await fs.writeFile(sourcePath, inertSource);
    let inspectionCount = 0;

    await withPreviewService(
      async (service) => {
        const prepared = await Effect.runPromise(
          service.prepare({ cwd: workspace, path: sourcePath }),
        );

        expect(inspectionCount).toBe(2);
        expect(prepared.mode).toBe("interactive-bundle");
        expect(prepared.localHtmlNetworkPolicy).toBe("sealed-interactive");
        await expect(requestPreview(prepared.previewUrl!)).resolves.toMatchObject({
          status: 200,
          body: activeSource,
        });
      },
      makeHtmlArtifactPreviewLayer({
        inspectArtifact: async (input) => {
          const inspected = await inspectHtmlArtifact(input);
          inspectionCount += 1;
          if (inspectionCount === 1) await fs.writeFile(sourcePath, activeSource);
          return inspected;
        },
      }),
    );
  });

  it("reinspects a same-length linked-document rewrite before route pinning", async () => {
    const workspace = await makeWorkspace();
    const sourcePath = path.join(workspace, "report.html");
    const childPath = path.join(workspace, "child.html");
    const [inertChild, activeChild] = sameLengthHtml(
      "<p>Inert child</p>",
      "<script>window.changed = true</script>",
    );
    await fs.writeFile(sourcePath, '<iframe src="child.html"></iframe>');
    await fs.writeFile(childPath, inertChild);
    let inspectionCount = 0;

    await withPreviewService(
      async (service) => {
        const prepared = await Effect.runPromise(
          service.prepare({ cwd: workspace, path: sourcePath }),
        );

        expect(inspectionCount).toBe(2);
        expect(prepared.mode).toBe("interactive-bundle");
        expect(prepared.localHtmlNetworkPolicy).toBe("sealed-interactive");
        await expect(requestPreview(prepared.previewUrl!, "/child.html")).resolves.toMatchObject({
          status: 200,
          body: activeChild,
        });
      },
      makeHtmlArtifactPreviewLayer({
        inspectArtifact: async (input) => {
          const inspected = await inspectHtmlArtifact(input);
          inspectionCount += 1;
          if (inspectionCount === 1) await fs.writeFile(childPath, activeChild);
          return inspected;
        },
      }),
    );
  });

  it("fails after one retry when preparation keeps changing without leaking capacity", async () => {
    const workspace = await makeWorkspace();
    const sourcePath = path.join(workspace, "report.html");
    await fs.writeFile(sourcePath, "<p>Revision zero</p>");
    let mutateAfterInspection = true;
    let inspectionCount = 0;

    await withPreviewService(
      async (service) => {
        await expect(
          Effect.runPromise(service.prepare({ cwd: workspace, path: sourcePath })),
        ).rejects.toThrow("kept changing while its preview was being prepared");
        expect(inspectionCount).toBe(2);

        mutateAfterInspection = false;
        const prepared = await Effect.runPromise(
          service.prepare({ cwd: workspace, path: sourcePath }),
        );
        expect(prepared.previewUrl).toBeDefined();
        await expect(requestPreview(prepared.previewUrl!)).resolves.toMatchObject({ status: 200 });
      },
      makeHtmlArtifactPreviewLayer({
        maxActiveGrants: 1,
        inspectArtifact: async (input) => {
          const inspected = await inspectHtmlArtifact(input);
          inspectionCount += 1;
          if (mutateAfterInspection) {
            await replaceFileAtomically(
              sourcePath,
              `<p>Revision ${inspectionCount % 2 === 0 ? "even" : "odd"}</p>`,
            );
          }
          return inspected;
        },
      }),
    );
  });

  it("attests the exact server-issued local HTML capability authority", async () => {
    const workspace = await makeWorkspace();
    const sourcePath = path.join(workspace, "report.html");
    await fs.writeFile(sourcePath, "<h1>Report</h1>");
    const capabilitySigningKey = "scient-preview-server-test-key";

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: sourcePath }),
      );
      expect(prepared.previewUrl).toBeDefined();
      expect(prepared.sourceIdentity).toBeDefined();
      expect(prepared.sourceRoot).toBeDefined();
      expect(prepared.localHtmlCapabilityProof).toBe(
        createHmac("sha256", capabilitySigningKey)
          .update(
            serializeLocalHtmlCapabilityAuthority({
              previewUrl: prepared.previewUrl!,
              sourceIdentity: prepared.sourceIdentity!,
              sourceRoot: prepared.sourceRoot!,
              watchedPaths: prepared.watchedPaths ?? [],
              allowedExternalUrls: prepared.allowedExternalUrls ?? [],
              networkPolicy: prepared.localHtmlNetworkPolicy!,
            }),
          )
          .digest("base64url"),
      );
    }, makeHtmlArtifactPreviewLayer({ capabilitySigningKey }));
  });

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
      expect(prepared.localHtmlNetworkPolicy).toBe("reviewed-static");
      expect(prepared.previewUrl).toBeDefined();
      const canonicalWorkspace = await fs.realpath(workspace);
      expect(prepared.sourceIdentity).toBe(path.join(canonicalWorkspace, "report.html"));
      expect(prepared.sourceRoot).toBe(canonicalWorkspace);
      expect(new Set(prepared.watchedPaths)).toEqual(
        new Set([
          path.join(canonicalWorkspace, "report.html"),
          path.join(canonicalWorkspace, "report.css"),
          path.join(canonicalWorkspace, "paper.png"),
        ]),
      );

      const document = await requestPreview(prepared.previewUrl!);
      expect(document.status).toBe(200);
      expect(document.body).toContain("<h1>Report</h1>");
      expect(document.headers["content-security-policy"]).toBeUndefined();
      expect(document.headers["x-dns-prefetch-control"]).toBe("off");

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

  it("re-prepares and serves an asset created under a previously absent directory", async () => {
    const workspace = await makeWorkspace();
    const sourcePath = path.join(workspace, "report.html");
    const assetsDirectory = path.join(workspace, "assets");
    const assetPath = path.join(assetsDirectory, "theme.css");
    await fs.writeFile(
      sourcePath,
      '<link rel="stylesheet" href="assets/theme.css"><h1>Report</h1>',
    );

    await withPreviewService(async (service) => {
      const before = await Effect.runPromise(service.prepare({ cwd: workspace, path: sourcePath }));
      expect(before.watchedPaths).toContain(path.join(await fs.realpath(workspace), "assets"));
      await expect(requestPreview(before.previewUrl!, "/assets/theme.css")).resolves.toMatchObject({
        status: 404,
      });

      await fs.mkdir(assetsDirectory);
      await fs.writeFile(assetPath, "body { color: navy; }");
      const after = await Effect.runPromise(service.prepare({ cwd: workspace, path: sourcePath }));
      expect(after.watchedPaths).toContain(await fs.realpath(assetPath));
      await expect(requestPreview(after.previewUrl!, "/assets/theme.css")).resolves.toMatchObject({
        status: 200,
        body: expect.stringContaining("color: navy"),
      });
    });
  });

  it("reports when dependency discovery exceeds its bounded graph", async () => {
    const workspace = await makeWorkspace();
    const references: string[] = [];
    for (let index = 0; index < 251; index += 1) {
      const name = `asset-${index}.png`;
      references.push(`<img src="${name}">`);
      await fs.writeFile(path.join(workspace, name), `asset-${index}`);
    }
    const sourcePath = path.join(workspace, "report.html");
    await fs.writeFile(sourcePath, references.join(""));

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: sourcePath }),
      );
      expect(prepared.watchDiscoveryLimited).toBe(true);
      expect(prepared.watchedPaths).toHaveLength(251);
    });
  });

  it("gives inert thumbnails a no-network, no-script content policy", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "index.html"), "<h1>Thumbnail</h1>");

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "index.html", thumbnail: true }),
      );
      const document = await requestPreview(prepared.previewUrl!);
      expect(document.status).toBe(200);
      expect(document.headers["content-security-policy"]).toContain("script-src 'none'");
      expect(document.headers["content-security-policy"]).toContain("connect-src 'none'");
      expect(document.headers["content-security-policy"]).toContain("form-action 'none'");
    });
  });

  it("does not widen a document capability to parent-directory resources", async () => {
    const workspace = await makeWorkspace();
    await fs.mkdir(path.join(workspace, "reports"));
    await fs.mkdir(path.join(workspace, "assets"));
    await fs.writeFile(path.join(workspace, "assets", "theme.css"), "body { color: green; }");
    await fs.writeFile(path.join(workspace, "private.txt"), "must not be served");
    await fs.writeFile(
      path.join(workspace, "reports", "report.html"),
      '<link rel="stylesheet" href="../assets/theme.css"><h1>Parent asset</h1>',
    );

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "reports/report.html" }),
      );
      expect(new URL(prepared.previewUrl!).pathname).toBe("/");
      expect(prepared.warnings).toContainEqual({
        code: "local-resource-denied",
        message:
          "Local preview resource is outside the opened file's authority: ../assets/theme.css",
      });
      await expect(requestPreview(prepared.previewUrl!)).resolves.toMatchObject({
        status: 200,
        body: expect.stringContaining("Parent asset"),
      });
      await expect(
        requestPreview(prepared.previewUrl!, "/assets/theme.css"),
      ).resolves.toMatchObject({
        status: 404,
      });
      await expect(requestPreview(prepared.previewUrl!, "/private.txt")).resolves.toMatchObject({
        status: 404,
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
      expect(prepared.localHtmlNetworkPolicy).toBe("sealed-interactive");
      const document = await requestPreview(prepared.previewUrl!);
      expect(document.headers["content-security-policy"]).toBeUndefined();
      expect(document.headers["x-dns-prefetch-control"]).toBe("off");
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
  });

  it("serves exact granted filenames containing percent signs", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "100%.css"), "body { color: purple; }");
    await fs.writeFile(
      path.join(workspace, "index.html"),
      '<link rel="stylesheet" href="100%25.css"><p>Percent</p>',
    );

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "index.html" }),
      );
      await expect(requestPreview(prepared.previewUrl!, "/100%25.css")).resolves.toMatchObject({
        status: 200,
        body: expect.stringContaining("purple"),
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

  it("isolates exact dependency capabilities between previews in the same directory", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "one.css"), "body { color: red; }");
    await fs.writeFile(path.join(workspace, "two.css"), "body { color: blue; }");
    await fs.writeFile(
      path.join(workspace, "one.html"),
      '<link rel="stylesheet" href="one.css"><p>One</p>',
    );
    await fs.writeFile(
      path.join(workspace, "two.html"),
      '<link rel="stylesheet" href="two.css"><p>Two</p>',
    );

    await withPreviewService(async (service) => {
      const one = await Effect.runPromise(service.prepare({ cwd: workspace, path: "one.html" }));
      const two = await Effect.runPromise(service.prepare({ cwd: workspace, path: "two.html" }));

      await expect(requestPreview(one.previewUrl!, "/one.css")).resolves.toMatchObject({
        status: 200,
      });
      await expect(requestPreview(one.previewUrl!, "/two.css")).resolves.toMatchObject({
        status: 404,
      });
      await expect(requestPreview(two.previewUrl!, "/two.css")).resolves.toMatchObject({
        status: 200,
      });
      await expect(requestPreview(two.previewUrl!, "/one.css")).resolves.toMatchObject({
        status: 404,
      });
    });
  });

  it("allows declared local navigation but denies undeclared neighboring documents", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "index.html"), '<a href="linked.html">Linked</a>');
    await fs.writeFile(
      path.join(workspace, "linked.html"),
      '<a href="index.html">Back</a><p>Linked page</p>',
    );
    await fs.writeFile(path.join(workspace, "private.html"), "<p>Private neighbor</p>");

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "index.html" }),
      );
      await expect(requestPreview(prepared.previewUrl!, "/linked.html")).resolves.toMatchObject({
        status: 200,
        body: expect.stringContaining("Linked page"),
      });
      await expect(requestPreview(prepared.previewUrl!, "/private.html")).resolves.toMatchObject({
        status: 404,
      });
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

  it("prepares a fresh capability after an atomic save replaces the source inode", async () => {
    const workspace = await makeWorkspace();
    const sourcePath = path.join(workspace, "index.html");
    const replacementPath = path.join(workspace, "index.next.html");
    await fs.writeFile(sourcePath, "<p>Before</p>");

    await withPreviewService(async (service) => {
      const previous = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "index.html" }),
      );
      await expect(requestPreview(previous.previewUrl!)).resolves.toMatchObject({
        status: 200,
        body: expect.stringContaining("Before"),
      });

      await fs.writeFile(replacementPath, "<p>After</p>");
      await fs.rename(replacementPath, sourcePath);
      await expect(requestPreview(previous.previewUrl!)).resolves.toMatchObject({ status: 404 });

      const refreshed = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: "index.html" }),
      );
      expect(refreshed.previewUrl).not.toBe(previous.previewUrl);
      await expect(requestPreview(refreshed.previewUrl!)).resolves.toMatchObject({
        status: 200,
        body: expect.stringContaining("After"),
      });
    });
  });

  it("invalidates entry and linked routes after same-inode same-length rewrites", async () => {
    const workspace = await makeWorkspace();
    const sourcePath = path.join(workspace, "index.html");
    const childPath = path.join(workspace, "child.html");
    const [entryBefore, entryAfter] = sameLengthHtml(
      '<iframe src="child.html"></iframe><p>Before</p>',
      '<iframe src="child.html"></iframe><p>After</p>',
    );
    const [childBefore, childAfter] = sameLengthHtml("<p>Child before</p>", "<p>Child after</p>");
    await fs.writeFile(sourcePath, entryBefore);
    await fs.writeFile(childPath, childBefore);

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: sourcePath }),
      );
      await expect(requestPreview(prepared.previewUrl!)).resolves.toMatchObject({ status: 200 });
      await expect(requestPreview(prepared.previewUrl!, "/child.html")).resolves.toMatchObject({
        status: 200,
      });

      await fs.writeFile(childPath, childAfter);
      await expect(requestPreview(prepared.previewUrl!, "/child.html")).resolves.toMatchObject({
        status: 404,
      });
      await expect(requestPreview(prepared.previewUrl!)).resolves.toMatchObject({ status: 200 });

      await fs.writeFile(sourcePath, entryAfter);
      await expect(requestPreview(prepared.previewUrl!)).resolves.toMatchObject({ status: 404 });
    });
  });

  it("never streams classified bytes mutated after the request fingerprint check", async () => {
    const workspace = await makeWorkspace();
    const sourcePath = path.join(workspace, "index.html");
    const [inertSource, activeSource] = sameLengthHtml(
      "<p>Inspected static document</p>",
      "<script>window.uninspected = true</script>",
    );
    await fs.writeFile(sourcePath, inertSource);
    const canonicalSourcePath = await fs.realpath(sourcePath);
    let mutateOnRequest = false;

    await withPreviewService(
      async (service) => {
        const prepared = await Effect.runPromise(
          service.prepare({ cwd: workspace, path: sourcePath }),
        );
        expect(prepared.mode).toBe("static-document");
        expect(prepared.localHtmlNetworkPolicy).toBe("reviewed-static");

        mutateOnRequest = true;
        const response = await requestPreview(prepared.previewUrl!);
        expect(response.status).toBe(404);
        expect(response.body).not.toContain("uninspected");
      },
      makeHtmlArtifactPreviewLayer({
        afterGrantedFileFingerprint: async (filePath) => {
          if (!mutateOnRequest || filePath !== canonicalSourcePath) return;
          mutateOnRequest = false;
          await fs.writeFile(sourcePath, activeSource);
        },
      }),
    );
  });

  it("buffers linked classified documents for full and ranged responses", async () => {
    const workspace = await makeWorkspace();
    const sourcePath = path.join(workspace, "index.html");
    const childPath = path.join(workspace, "child.html");
    const [inertChild, activeChild] = sameLengthHtml(
      "<p>Inspected linked document</p>",
      "<script>window.uninspected = true</script>",
    );
    await fs.writeFile(sourcePath, '<iframe src="child.html"></iframe>');
    await fs.writeFile(childPath, inertChild);
    const canonicalChildPath = await fs.realpath(childPath);
    let mutateOnRequest = false;

    await withPreviewService(
      async (service) => {
        const prepared = await Effect.runPromise(
          service.prepare({ cwd: workspace, path: sourcePath }),
        );
        expect(prepared.mode).toBe("static-document");

        await expect(requestPreview(prepared.previewUrl!, "/child.html")).resolves.toMatchObject({
          status: 200,
          body: inertChild,
        });
        await expect(
          requestPreview(prepared.previewUrl!, "/child.html", {
            headers: { Range: "bytes=0-9" },
          }),
        ).resolves.toMatchObject({
          status: 206,
          body: Buffer.from(inertChild).subarray(0, 10).toString("utf8"),
        });

        mutateOnRequest = true;
        const ranged = await requestPreview(prepared.previewUrl!, "/child.html", {
          headers: { Range: "bytes=0-9" },
        });
        expect(ranged.status).toBe(404);
        expect(ranged.body).not.toContain("uninspect");
      },
      makeHtmlArtifactPreviewLayer({
        afterGrantedFileFingerprint: async (filePath) => {
          if (!mutateOnRequest || filePath !== canonicalChildPath) return;
          mutateOnRequest = false;
          await fs.writeFile(childPath, activeChild);
        },
      }),
    );
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

  it("refuses excess grants without evicting an active capability", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "index.html"), "<p>Bounded</p>");

    await withPreviewService(async (service) => {
      const urls: string[] = [];
      for (let index = 0; index < 512; index += 1) {
        const prepared = await Effect.runPromise(
          service.prepare({ cwd: workspace, path: "index.html" }),
        );
        urls.push(prepared.previewUrl!);
      }
      await expect(
        Effect.runPromise(service.prepare({ cwd: workspace, path: "index.html" })),
      ).rejects.toThrow("Failed to prepare the HTML artifact preview");
      await expect(requestPreview(urls[0]!)).resolves.toMatchObject({ status: 200 });
      await expect(requestPreview(urls.at(-1)!)).resolves.toMatchObject({ status: 200 });
    });
  });

  it("reserves dedicated-listener capacity before asynchronous startup", async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, "index.html"), "<p>Concurrent</p>");
    const oneGrantLayer = makeHtmlArtifactPreviewLayer({
      maxActiveGrants: 1,
      useDedicatedServers: true,
    });

    await withPreviewService(async (service) => {
      const results = await Promise.allSettled([
        Effect.runPromise(service.prepare({ cwd: workspace, path: "index.html" })),
        Effect.runPromise(service.prepare({ cwd: workspace, path: "index.html" })),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    }, oneGrantLayer);
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
    await fs.writeFile(
      outsideFile,
      '<link rel="stylesheet" href="theme.css"><h1>External report</h1>',
    );
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

  it("denies parent-directory assets for an absolute HTML file", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    await fs.mkdir(path.join(outside, "reports"));
    await fs.mkdir(path.join(outside, "assets"));
    await fs.writeFile(path.join(outside, "assets", "theme.css"), "body { color: teal; }");
    await fs.writeFile(path.join(outside, "unrelated.txt"), "must remain private");
    const outsideFile = path.join(outside, "reports", "report.html");
    await fs.writeFile(
      outsideFile,
      '<link rel="stylesheet" href="../assets/theme.css"><h1>External report</h1>',
    );

    await withPreviewService(async (service) => {
      const prepared = await Effect.runPromise(
        service.prepare({ cwd: workspace, path: outsideFile }),
      );
      expect(new URL(prepared.previewUrl!).pathname).toBe("/");
      expect(prepared.warnings).toContainEqual({
        code: "local-resource-denied",
        message:
          "Local preview resource is outside the opened file's authority: ../assets/theme.css",
      });
      await expect(
        requestPreview(prepared.previewUrl!, "/assets/theme.css"),
      ).resolves.toMatchObject({
        status: 404,
      });
      await expect(requestPreview(prepared.previewUrl!, "/unrelated.txt")).resolves.toMatchObject({
        status: 404,
      });
    });
  });
});
