import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { piClient } from "@t3tools/provider-pi/client";
import { grokClient } from "@t3tools/provider-grok/client";

import {
  ProviderInstanceIcon,
  resolveProviderInstanceAcpRegistryIconUrl,
} from "./ProviderInstanceIcon";
import { PiIcon } from "../ScientProviderIcons";

describe("ProviderInstanceIcon", () => {
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
    expect(piClient.icon.viewBox).toBe("165.29 165.29 469.43 469.43");
  });

  it("uses package-owned glyphs and both theme colors for other extracted providers", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderInstanceIcon, {
        driverKind: ProviderDriverKind.make("grok"),
        displayName: "Personal Grok",
      }),
    );
    expect(markup).toContain(`viewBox="${grokClient.icon.viewBox}"`);
    expect(markup).toContain(`--icon-light:${grokClient.icon.fill.light}`);
    expect(markup).toContain(`--icon-dark:${grokClient.icon.fill.dark}`);
    expect(markup).toContain("dark:fill-(--icon-dark)");
    for (const path of grokClient.icon.paths) expect(markup).toContain(path.d);
  });
});

describe("resolveProviderInstanceAcpRegistryIconUrl", () => {
  it("uses allowlisted catalog metadata and rejects untrusted overrides", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "kilo",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/icons/kilo.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/kilo.svg");
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "generic-agent",
        iconUrl: "https://example.com/not-official.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/generic-agent.svg");
  });

  it("does not resolve registry icons for other provider drivers", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("codex"),
        agentId: "kilo",
      }),
    ).toBeNull();
  });
});
