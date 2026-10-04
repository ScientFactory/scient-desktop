import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ModelPickerNewChatFooter } from "./ModelPickerNewChatFooter";

describe("ModelPickerNewChatFooter", () => {
  it("offers one compact, accessible fork action", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerNewChatFooter disabled={false} onFork={() => {}} />,
    );

    expect(markup).toContain("Continue in a new chat");
    expect(markup).toContain('aria-label="Continue in a new chat"');
    expect(markup.match(/<button/g)).toHaveLength(1);
  });

  it("disables the fork action while the thread is busy", () => {
    const markup = renderToStaticMarkup(<ModelPickerNewChatFooter disabled onFork={() => {}} />);

    expect(markup).toContain('disabled=""');
  });
});
