import { describe, expect, it } from "vite-plus/test";
import { conversationFileReviewHtml } from "./conversationFileReviewHtml.ts";

describe("local conversation preview document", () => {
  it("keeps reading optional for an OS open and expanded for a read-only preview", () => {
    const content = {
      title: "Example",
      messageCount: 1,
      attachmentCount: 0,
      truncated: false,
      messages: [{ role: "user", text: "Hello" }],
    };
    const opening = conversationFileReviewHtml(content);
    expect(opening).toContain('<details id="read"><summary>Read conversation</summary>');
    expect(opening).toContain("1 message · 0 attachments");
    expect(opening).not.toContain("Continue to choose where to import");
    expect(opening).not.toContain("<details open");
    expect(opening).toContain('id="continue"');
    const preview = conversationFileReviewHtml(content, undefined, true);
    expect(preview).not.toContain("<details");
    expect(preview).toContain("Hello");
    expect(preview).not.toContain('id="continue"');
  });
  it("never treats conversation contents or failures as HTML", () => {
    const html = conversationFileReviewHtml({
      title: "<script>bad()</script>",
      messageCount: 1,
      attachmentCount: 0,
      truncated: false,
      messages: [{ role: "<img src=x>", text: '<iframe src="https://remote"></iframe> שלום' }],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("שלום");
    expect(conversationFileReviewHtml(null, "<img>")).toContain("&lt;img&gt;");
  });
  it("offers import only after a successful read and reports shortened previews", () => {
    expect(conversationFileReviewHtml(null)).not.toContain('id="continue"');
    expect(conversationFileReviewHtml(null, "Invalid archive")).not.toContain('id="continue"');
    expect(
      conversationFileReviewHtml({
        title: "Example",
        messageCount: 12,
        attachmentCount: 2,
        truncated: true,
        messages: [],
      }),
    ).toContain("Preview shortened");
  });
});
