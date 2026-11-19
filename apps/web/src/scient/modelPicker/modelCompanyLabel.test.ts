import { ProviderDriverKind } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { modelCompanyLabel } from "./modelCompanyLabel";

it.each([
  ["openai-codex", "OpenAI"],
  ["anthropic", "Anthropic"],
  ["google-antigravity", "Google"],
  ["google-gemini-cli", "Google"],
  ["openrouter", "OpenRouter"],
  ["__proto__", "__proto__"],
  [" My custom endpoint ", "My custom endpoint"],
])("presents %s without changing unknown source labels", (subProvider, label) => {
  expect(
    modelCompanyLabel({
      subProvider,
      driverKind: ProviderDriverKind.make("scient"),
      providerDisplayName: "Scient Agent",
    }),
  ).toBe(label);
});
it("uses the company for native agents and retains custom instance names", () => {
  expect(
    modelCompanyLabel({
      driverKind: ProviderDriverKind.make("codex"),
      providerDisplayName: "Codex Personal",
    }),
  ).toBe("OpenAI");
  expect(
    modelCompanyLabel({
      driverKind: ProviderDriverKind.make("acpRegistry"),
      providerDisplayName: "My agent",
    }),
  ).toBe("My agent");
});
