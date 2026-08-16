import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SourceErrorBanner } from "./ScientSourcesPanel";

describe("SourceErrorBanner", () => {
  it("exposes a dismiss action", () => {
    const markup = renderToStaticMarkup(
      <SourceErrorBanner message="The PDF could not be read." onDismiss={() => undefined} />,
    );

    expect(markup).toContain("The PDF could not be read.");
    expect(markup).toContain('aria-label="Dismiss source notification"');
  });
});
