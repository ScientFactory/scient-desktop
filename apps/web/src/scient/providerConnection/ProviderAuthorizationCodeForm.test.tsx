import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ProviderAuthorizationCodeDisclosure } from "./ProviderAuthorizationCodeForm";

describe("ProviderAuthorizationCodeDisclosure", () => {
  it("keeps manual code entry collapsed until requested", () => {
    const markup = renderToStaticMarkup(
      <ProviderAuthorizationCodeDisclosure
        authorizationCode=""
        expanded={false}
        onAuthorizationCodeChange={vi.fn()}
        onExpandedChange={vi.fn()}
        onSubmit={vi.fn()}
        providerName="Grok"
      />,
    );

    expect(markup).toContain("Have a sign-in code?");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("in-[[data-model-picker-content=true]]:max-w-64");
    expect(markup).not.toContain("Paste sign-in code");
  });

  it("reveals a concise provider-specific code form", () => {
    const markup = renderToStaticMarkup(
      <ProviderAuthorizationCodeDisclosure
        authorizationCode="one-time-code"
        expanded
        onAuthorizationCodeChange={vi.fn()}
        onExpandedChange={vi.fn()}
        onSubmit={vi.fn()}
        providerName="Claude"
      />,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Paste sign-in code");
    expect(markup).toContain("Claude one-time authorization code");
    expect(markup).toContain("Submit");
  });
});
