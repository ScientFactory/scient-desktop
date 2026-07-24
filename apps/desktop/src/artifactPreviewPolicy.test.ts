import { describe, expect, it } from "vitest";

import {
  artifactPreviewNavigationAllowed,
  artifactPreviewRequestAllowed,
} from "./artifactPreviewPolicy";

const ORIGIN = "http://g-123.preview.localhost:5000";

describe("artifactPreviewPolicy", () => {
  it("allows only same-capability resources and inert embedded data", () => {
    expect(
      artifactPreviewRequestAllowed({
        url: `${ORIGIN}/assets/app.js`,
        allowedOrigin: ORIGIN,
        resourceType: "script",
      }),
    ).toBe(true);
    expect(
      artifactPreviewRequestAllowed({
        url: "https://example.com/tracker.js",
        allowedOrigin: ORIGIN,
        resourceType: "script",
      }),
    ).toBe(false);
    expect(
      artifactPreviewRequestAllowed({
        url: `${ORIGIN}/socket`,
        allowedOrigin: ORIGIN,
        resourceType: "webSocket",
      }),
    ).toBe(false);
    for (const resourceType of ["worker", "sharedWorker", "serviceWorker"]) {
      expect(
        artifactPreviewRequestAllowed({
          url: `${ORIGIN}/worker.js`,
          allowedOrigin: ORIGIN,
          resourceType,
        }),
      ).toBe(false);
    }
  });

  it("denies subframes and cross-origin top-level navigation", () => {
    expect(
      artifactPreviewNavigationAllowed({
        url: `${ORIGIN}/`,
        allowedOrigin: ORIGIN,
        isMainFrame: true,
      }),
    ).toBe(true);
    expect(
      artifactPreviewNavigationAllowed({
        url: "https://example.com/",
        allowedOrigin: ORIGIN,
        isMainFrame: true,
      }),
    ).toBe(false);
    expect(
      artifactPreviewNavigationAllowed({
        url: `${ORIGIN}/frame.html`,
        allowedOrigin: ORIGIN,
        isMainFrame: false,
      }),
    ).toBe(false);
  });
});
