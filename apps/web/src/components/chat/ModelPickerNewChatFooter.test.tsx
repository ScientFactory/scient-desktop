import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ModelPickerNewChatFooter } from "./ModelPickerNewChatFooter";

vi.mock("gt-react", async (importOriginal) =>
  (await import("~/scient/testing/englishGTReact")).englishGTReact(await importOriginal()),
);

describe("ModelPickerNewChatFooter", () => {
  it("disables the fork action while the thread is busy", () => {
    const markup = renderToStaticMarkup(<ModelPickerNewChatFooter disabled onFork={() => {}} />);

    expect(markup).toContain('disabled=""');
  });
});
