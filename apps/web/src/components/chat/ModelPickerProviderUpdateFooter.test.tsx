import { ProviderDriverKind } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ModelPickerProviderUpdateFooter } from "~/scient/providerConnection/ModelPickerProviderUpdateFooter";

describe("ModelPickerProviderUpdateFooter", () => {
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
    expect(markup).not.toContain("<button");
  });
});
