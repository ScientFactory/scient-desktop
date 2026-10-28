import { expect, it } from "@effect/vitest";
import { declaredPluginKeys, requiredServerKeys } from "./PluginRequiredKeys.ts";

it("finds names across supported MCP fields without projecting literal values or agent variables", () => {
  expect(
    requiredServerKeys({
      env: {
        TOKEN: "${TOKEN}",
        EMPTY: "",
        TEMPLATE: "<your-token>",
        SAMPLE: "YOUR_API_KEY",
        FIXED: "synthetic-private-value",
        ROOT: "${CLAUDE_PLUGIN_ROOT}",
        HOME: "",
      },
      args: ["--token=${ARG_TOKEN}", "${HOME}", 12],
      headers: { Authorization: "Bearer ${TOKEN}", "x-key": "${HEADER_KEY}" },
      url: "https://example.com/${URL_KEY}",
      description: "${NOT_CONFIG}",
    }),
  ).toEqual(["ARG_TOKEN", "EMPTY", "HEADER_KEY", "SAMPLE", "TEMPLATE", "TOKEN", "URL_KEY"]);
});

it("requires declared sensitive settings, ignoring defaults and non-secret settings", () => {
  expect(
    declaredPluginKeys({
      userConfig: {
        api_token: { sensitive: true, default: "synthetic-private-value" },
        endpoint: { sensitive: false },
        "invalid.name": { sensitive: true },
        wrongType: { sensitive: "true" },
      },
    }),
  ).toEqual(["api_token"]);
  expect(requiredServerKeys(null)).toEqual([]);
  expect(requiredServerKeys({ env: ["${NOT_A_MAP}"], args: "${NOT_AN_ARRAY}" })).toEqual([]);
});
