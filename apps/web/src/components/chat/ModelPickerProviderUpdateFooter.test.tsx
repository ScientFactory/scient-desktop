import { ProviderDriverKind } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ModelPickerProviderUpdateFooter } from "./ModelPickerContent";

describe("ModelPickerProviderUpdateFooter", () => {
  it("offers one quiet, accessible update action", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerProviderUpdateFooter
        displayName="Claude"
        driverKind={ProviderDriverKind.make("claudeAgent")}
        disabled={false}
        isStarting={false}
        isUpdating={false}
        onUpdate={() => {}}
      />,
    );

    expect(markup).toContain("Claude update available");
    expect(markup).toContain('aria-label="Update Claude"');
    expect(markup.match(/<button/g)).toHaveLength(1);
  });

  it("keeps the update visible but unavailable while the provider is busy", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerProviderUpdateFooter
        displayName="Codex"
        driverKind={ProviderDriverKind.make("codex")}
        disabled
        disabledReason="Available when the provider is idle."
        isStarting={false}
        isUpdating={false}
        onUpdate={() => {}}
      />,
    );

    expect(markup).toContain("Codex update available");
    expect(markup).toContain('disabled=""');
    expect(markup).toContain(
      'aria-label="Codex update unavailable. Available when the provider is idle."',
    );
  });

  it("offers a compact retry without exposing a long failure in the row", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerProviderUpdateFooter
        displayName="Claude"
        driverKind={ProviderDriverKind.make("claudeAgent")}
        disabled={false}
        isStarting={false}
        isUpdating={false}
        hasError
        onUpdate={() => {}}
      />,
    );

    expect(markup).toContain("Couldn’t start update");
    expect(markup).toContain("Retry");
  });

  it("shows compact progress without a second update action", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerProviderUpdateFooter
        displayName="Claude"
        driverKind={ProviderDriverKind.make("claudeAgent")}
        disabled={false}
        isStarting={false}
        isUpdating
        onUpdate={() => {}}
      />,
    );

    expect(markup).toContain("Updating Claude…");
    expect(markup).toContain("animate-spin");
    expect(markup).toContain("motion-reduce:animate-none");
    expect(markup.match(/<svg/g)).toHaveLength(2);
    expect(markup).not.toContain("<button");
  });
});
