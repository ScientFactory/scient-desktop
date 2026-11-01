import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ModelPickerNewChatFooter } from "./ModelPickerNewChatFooter";

describe("ModelPickerNewChatFooter", () => {
  it("disables the fork action while the thread is busy", () => {
    const markup = renderToStaticMarkup(<ModelPickerNewChatFooter disabled onFork={() => {}} />);

    expect(markup).toContain('disabled=""');
  });
});
