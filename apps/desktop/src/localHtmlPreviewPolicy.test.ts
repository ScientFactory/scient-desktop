import { describe, expect, it } from "vitest";

import {
  isPrivateOrNonPublicIpAddress,
  isLocalOrPrivateNetworkUrl,
  localHtmlPreviewNavigationDisposition,
  localHtmlPreviewRequestAllowed,
} from "./localHtmlPreviewPolicy";

const ORIGIN = "http://g-123.preview.localhost:5000";

describe("localHtmlPreviewPolicy", () => {
  it("allows the exact preview origin and exact declared public assets", () => {
    expect(localHtmlPreviewRequestAllowed({ url: `${ORIGIN}/app.js`, allowedOrigin: ORIGIN })).toBe(
      true,
    );
    expect(
      localHtmlPreviewRequestAllowed({
        url: "https://cdn.example/app.js",
        allowedOrigin: ORIGIN,
        allowedExternalUrls: ["https://cdn.example/app.js"],
        resourceType: "script",
      }),
    ).toBe(true);
    expect(
      localHtmlPreviewRequestAllowed({
        url: "data:text/plain,ok",
        allowedOrigin: ORIGIN,
      }),
    ).toBe(true);
    expect(
      localHtmlPreviewRequestAllowed({
        url: "blob:http://g-123.preview.localhost:5000/id",
        allowedOrigin: ORIGIN,
      }),
    ).toBe(true);
  });

  it("denies undeclared or data-bearing public egress", () => {
    expect(
      localHtmlPreviewRequestAllowed({
        url: "https://cdn.example/bit-one.png",
        allowedOrigin: ORIGIN,
        resourceType: "image",
      }),
    ).toBe(false);
    expect(
      localHtmlPreviewRequestAllowed({
        url: "https://cdn.example/app.js?secret=1",
        allowedOrigin: ORIGIN,
        allowedExternalUrls: ["https://cdn.example/app.js"],
        resourceType: "image",
      }),
    ).toBe(false);
    expect(
      localHtmlPreviewRequestAllowed({
        url: "https://api.example/data",
        allowedOrigin: ORIGIN,
        allowedExternalUrls: ["https://api.example/data"],
        resourceType: "xhr",
      }),
    ).toBe(false);
    expect(
      localHtmlPreviewRequestAllowed({
        url: "https://frames.example/embed",
        allowedOrigin: ORIGIN,
        allowedExternalUrls: ["https://frames.example/embed"],
        resourceType: "subFrame",
      }),
    ).toBe(false);
    expect(
      localHtmlPreviewRequestAllowed({
        url: `${ORIGIN}/local-child.html`,
        allowedOrigin: ORIGIN,
        resourceType: "subFrame",
      }),
    ).toBe(true);
    expect(
      localHtmlPreviewRequestAllowed({
        url: "data:text/html,<script>top.postMessage('active','*')</script>",
        allowedOrigin: ORIGIN,
        resourceType: "subFrame",
      }),
    ).toBe(false);
    expect(
      localHtmlPreviewRequestAllowed({
        url: "https://frames.example/object",
        allowedOrigin: ORIGIN,
        allowedExternalUrls: ["https://frames.example/object"],
        resourceType: "object",
      }),
    ).toBe(false);
  });

  it("denies local services, private networks, privileged schemes, and malformed URLs", () => {
    for (const url of [
      "http://localhost:3000/private",
      "http://other.preview.localhost:5000/private",
      "http://127.0.0.1:3000/private",
      "http://10.0.0.2/private",
      "http://172.16.0.2/private",
      "http://192.168.1.2/private",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/private",
      "http://[::ffff:7f00:1]/private",
      "http://localhost.localdomain/private",
      "file:///Users/example/.ssh/id_rsa",
      "scient://settings",
      "not a url",
    ]) {
      expect(localHtmlPreviewRequestAllowed({ url, allowedOrigin: ORIGIN })).toBe(false);
    }
  });

  it("keeps preview navigation local and denies cross-origin egress", () => {
    expect(
      localHtmlPreviewNavigationDisposition({
        url: `${ORIGIN}/linked.html`,
        allowedOrigin: ORIGIN,
        isMainFrame: true,
      }),
    ).toBe("allow");
    expect(
      localHtmlPreviewNavigationDisposition({
        url: "https://example.com/",
        allowedOrigin: ORIGIN,
        isMainFrame: true,
      }),
    ).toBe("deny");
    expect(
      localHtmlPreviewNavigationDisposition({
        url: "http://127.0.0.1:3000/",
        allowedOrigin: ORIGIN,
        isMainFrame: true,
      }),
    ).toBe("deny");
    expect(
      localHtmlPreviewNavigationDisposition({
        url: "https://frames.example/",
        allowedOrigin: ORIGIN,
        isMainFrame: false,
      }),
    ).toBe("deny");
    expect(
      localHtmlPreviewNavigationDisposition({
        url: `${ORIGIN}/local-child.html`,
        allowedOrigin: ORIGIN,
        isMainFrame: false,
      }),
    ).toBe("allow");
  });

  it("recognizes representative private-network address forms", () => {
    expect(isLocalOrPrivateNetworkUrl("http://127.1/")).toBe(true);
    expect(isLocalOrPrivateNetworkUrl("http://[fd00::1]/")).toBe(true);
    expect(isLocalOrPrivateNetworkUrl("https://example.com/")).toBe(false);
    expect(isLocalOrPrivateNetworkUrl("https://fda.gov/")).toBe(false);
    expect(isLocalOrPrivateNetworkUrl("https://fcc.gov/")).toBe(false);
    expect(isPrivateOrNonPublicIpAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateOrNonPublicIpAddress("2001:4860:4860::8888")).toBe(false);
  });
});
