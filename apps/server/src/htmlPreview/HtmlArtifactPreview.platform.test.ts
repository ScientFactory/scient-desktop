// FILE: HtmlArtifactPreview.platform.test.ts
// Purpose: Verifies capability hostnames through the current OS localhost resolver.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { expect, it } from "vitest";

import { HtmlArtifactPreview } from "./Services/HtmlArtifactPreview";
import { HtmlArtifactPreviewLive } from "./Layers/HtmlArtifactPreview";

it(
  "loads the generated capability hostname through the platform localhost resolver",
  { timeout: 10_000 },
  async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "scient-html-preview-platform-"));
    try {
      await fs.writeFile(path.join(workspace, "index.html"), "<h1>Resolver smoke</h1>");
      await fs.writeFile(path.join(workspace, "second.html"), "<h1>Second origin</h1>");
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* HtmlArtifactPreview;
            const prepared = yield* service.prepare({ cwd: workspace, path: "index.html" });
            const second = yield* service.prepare({ cwd: workspace, path: "second.html" });
            const previewUrl = new URL(prepared.previewUrl!);
            const secondUrl = new URL(second.previewUrl!);
            expect(secondUrl.origin).not.toBe(previewUrl.origin);
            expect(
              process.platform === "win32"
                ? previewUrl.hostname === "127.0.0.1"
                : previewUrl.hostname.endsWith(".preview.localhost"),
            ).toBe(true);
            const response = yield* Effect.promise(() =>
              fetch(prepared.previewUrl!, {
                signal: AbortSignal.timeout(5_000),
              }),
            );
            expect(response.status).toBe(200);
            expect(yield* Effect.promise(() => response.text())).toContain("Resolver smoke");
          }).pipe(Effect.provide(HtmlArtifactPreviewLive)),
        ),
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  },
);
