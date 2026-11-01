import { expect, it } from "@effect/vitest";
import { pluginKeyHttpServer } from "./PluginKeyHttpServers.ts";
const remote = {
  type: "http",
  url: "https://api.example.com/mcp",
  headers: { Authorization: "Bearer ${TOKEN}", "x-api-key": "${user_config.api_token}" },
};
it("accepts header-only key templates including declared Claude settings", () => {
  expect(pluginKeyHttpServer("api", remote)?.envNames).toEqual(["TOKEN", "api_token"]);
});
it.each([
  { ...remote, command: "never-run" },
  { ...remote, env: { EXTRA_KEY: "" } },
  { ...remote, url: "https://api.example.com/${TOKEN}" },
  { ...remote, url: "https://synthetic:private@example.com/mcp" },
  { ...remote, headers: { Host: "${TOKEN}" } },
  { ...remote, headers: { Authorization: "${TOKEN:-default}" } },
])("withholds unsupported or ambiguous secret delivery", (input) => {
  expect(pluginKeyHttpServer("api", input)).toBeUndefined();
});
