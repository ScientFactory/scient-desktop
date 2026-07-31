import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatImageFrame, reduceChatImageLoadState } from "./ChatImageFrame";

describe("ChatImageFrame", () => {
  it("ignores stale load events after the keyed source changes", () => {
    expect(
      reduceChatImageLoadState(
        { key: "remote:new", status: "loading" },
        { key: "remote:old", status: "ready" },
      ),
    ).toEqual({ key: "remote:new", status: "loading" });
  });

  it("records a current keyed load error", () => {
    expect(
      reduceChatImageLoadState(
        { key: "attachment:current", status: "loading" },
        { key: "attachment:current", status: "error" },
      ),
    ).toEqual({ key: "attachment:current", status: "error" });
  });

  it("renders a keyboard action and privacy-safe remote source action as siblings", () => {
    const markup = renderToStaticMarkup(
      <ChatImageFrame
        source={{
          kind: "remote",
          previewUrl: "https://images.example/capture.png",
          openUrl: "https://images.example/capture.png",
          name: "Capture",
        }}
        accessibleName="Capture"
        linkedHref="https://example.com/details"
      />,
    );
    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).toContain('aria-label="Open source for Capture"');
    expect(markup).toContain('aria-label="Open link for Capture"');
    const buttonMarkup = markup.match(/<button[\s\S]*?<\/button>/)?.[0];
    expect(buttonMarkup).toBeDefined();
    expect(buttonMarkup).not.toContain("<a");
  });

  it("does not expose a rejected raw source", () => {
    const markup = renderToStaticMarkup(
      <ChatImageFrame source={{ kind: "unsupported", name: "Unsafe" }} accessibleName="Unsafe" />,
    );
    expect(markup).toContain("This image source is not supported.");
    expect(markup).not.toContain("src=");
    expect(markup).not.toContain("href=");
  });

  it("drops an unsafe linked-image action at the frame boundary", () => {
    const markup = renderToStaticMarkup(
      <ChatImageFrame
        source={{
          kind: "attachment",
          previewUrl: "/attachments/capture",
          downloadUrl: "/attachments/capture",
          name: "Capture",
        }}
        accessibleName="Capture"
        linkedHref="javascript:alert(1)"
      />,
    );
    expect(markup).not.toContain("Open link");
    expect(markup).not.toContain("javascript:");
  });
});
