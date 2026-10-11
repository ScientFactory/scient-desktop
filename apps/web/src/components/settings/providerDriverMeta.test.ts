import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DRIVER_OPTIONS,
  driverOptionMatchesQuery,
  getDriverOption,
  providerClients,
} from "./providerDriverMeta";

function matchingLabels(query: string): ReadonlyArray<string> {
  return DRIVER_OPTIONS.filter((definition) => driverOptionMatchesQuery(definition, query)).map(
    (definition) => definition.label,
  );
}

describe("driverOptionMatchesQuery", () => {
  it("finds providers by the company or account people know", () => {
    expect(matchingLabels("ChatGPT")).toEqual(["Codex"]);
    expect(matchingLabels("openai")).toEqual(["Codex"]);
    expect(matchingLabels("gemini")).toEqual(["Antigravity"]);
    expect(matchingLabels("Google")).toEqual(["Antigravity"]);
    expect(matchingLabels("anthropic")).toEqual(["Claude"]);
  });

  it("still matches product names and treats an empty query as everything", () => {
    expect(matchingLabels(" codex ")).toEqual(["Codex"]);
    expect(matchingLabels("")).toHaveLength(DRIVER_OPTIONS.length);
  });
});

describe("provider company labels", () => {
  it("names the company behind providers whose product name hides it", () => {
    expect(getDriverOption(ProviderDriverKind.make("codex"))?.vendorLabel).toBe("OpenAI");
    expect(getDriverOption(ProviderDriverKind.make("antigravity"))?.vendorLabel).toBe("Google");
    expect(getDriverOption(ProviderDriverKind.make("claudeAgent"))?.vendorLabel).toBe("Anthropic");
  });
});

describe("provider client catalog presentation", () => {
  it("keeps every loaded provider schema available through the settings presentation", () => {
    for (const clientDefinition of providerClients.definitions) {
      const option = getDriverOption(clientDefinition.driverKind);

      expect(option?.value).toBe(clientDefinition.driverKind);
      expect(option?.clientDefinition).toBe(clientDefinition);
      expect(option?.settingsSchema).toBe(clientDefinition.settingsSchema);
    }
  });

  it("keeps Scient-owned providers in the shared presentation catalog", () => {
    expect(getDriverOption(ProviderDriverKind.make("droid"))?.label).toBe("Droid");
    expect(getDriverOption(ProviderDriverKind.make("omp"))?.label).toBe("Oh My Pi");
    expect(getDriverOption(ProviderDriverKind.make("scient"))?.label).toBe("Scient");
  });
});
