import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ModelPickerProviderLockNotice } from "./ModelPickerContent";

describe("ModelPickerProviderLockNotice", () => {
  it("offers one compact, accessible fork action", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerProviderLockNotice disabled={false} onFork={() => {}} />,
    );

    expect(markup).toContain("Continue this conversation with another provider.");
    expect(markup).toContain('aria-label="Fork conversation to switch providers"');
    expect(markup.match(/<button/g)).toHaveLength(1);
  });

  it("disables the fork action while the thread is busy", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerProviderLockNotice disabled onFork={() => {}} />,
    );

    expect(markup).toContain('disabled=""');
  });
});
