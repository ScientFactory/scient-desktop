import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatImageAttachmentGallery } from "./ChatImageAttachmentGallery";

describe("ChatImageAttachmentGallery", () => {
  it("keeps duplicate URLs as distinct attachment-ID keyed items", () => {
    const markup = renderToStaticMarkup(
      <ChatImageAttachmentGallery
        images={[
          { id: "one", name: "first.png", previewUrl: "/attachments/shared" },
          { id: "two", name: "second.png", previewUrl: "/attachments/shared" },
        ]}
        onImageExpand={() => {}}
      />,
    );
    expect(markup.match(/src="\/attachments\/shared"/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Preview first.png"');
    expect(markup).toContain('aria-label="Preview second.png"');
  });

  it("renders all eight supported images for an image-only turn", () => {
    const markup = renderToStaticMarkup(
      <ChatImageAttachmentGallery
        images={Array.from({ length: 8 }, (_, index) => ({
          id: `image-${index}`,
          name: `image-${index}.png`,
          previewUrl: `/attachments/image-${index}`,
        }))}
        onImageExpand={() => {}}
      />,
    );
    expect(markup.match(/aria-label="Preview image-/g)).toHaveLength(8);
    expect(markup).toContain("size-15");
  });
});
