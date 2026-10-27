import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { providerClients } from "@t3tools/client-runtime/provider-clients";

import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { PiIcon } from "../ScientProviderIcons";

describe("ProviderInstanceIcon", () => {
  // regression: 63d6b96358 fix: preserve shared provider presentation and safe Markdown images
  it("keeps Scient's shared Pi mark without changing package metadata", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderInstanceIcon, {
        driverKind: ProviderDriverKind.make("pi"),
        displayName: "Personal Pi",
      }),
    );
    const expected = renderToStaticMarkup(createElement(PiIcon));
    expect(markup).toContain('viewBox="-40 -40 640 640"');
    expect(markup).toContain(
      expected.slice(expected.indexOf("<path"), expected.lastIndexOf("</svg>")),
    );
    expect(providerClients.get(ProviderDriverKind.make("pi"))?.icon?.viewBox).toBe(
      "165.29 165.29 469.43 469.43",
    );
  });

  it("uses package-owned glyphs and both theme colors for other extracted providers", () => {
    const grokIcon = providerClients.get(ProviderDriverKind.make("grok"))?.icon;
    if (!grokIcon) throw new Error("Grok client has no icon");
    const markup = renderToStaticMarkup(
      createElement(ProviderInstanceIcon, {
        driverKind: ProviderDriverKind.make("grok"),
        displayName: "Personal Grok",
      }),
    );
    expect(markup).toContain(`viewBox="${grokIcon.viewBox}"`);
    expect(markup).toContain(`--icon-light:${grokIcon.fill.light}`);
    expect(markup).toContain(`--icon-dark:${grokIcon.fill.dark}`);
    expect(markup).toContain("dark:fill-(--icon-dark)");
    for (const path of grokIcon.paths) expect(markup).toContain(path.d);
  });
});
