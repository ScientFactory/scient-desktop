import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MetadataReviewIndicator } from "./ScientSourcesPanel";

describe("MetadataReviewIndicator", () => {
  it("is an accessible source-details trigger", () => {
    const markup = renderToStaticMarkup(
      <MetadataReviewIndicator
        diagnostics={[
          {
            field: "identifiers",
            severity: "warning",
            message: "Persistent identifier wasn't found.",
          },
        ]}
        onOpen={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Metadata needs review"');
    expect(markup).toContain("Metadata needs review");
  });
});
