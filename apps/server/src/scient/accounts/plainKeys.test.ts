import { expect, it } from "vite-plus/test";
import { secretsInText } from "./plainKeys.ts";

it("finds real-looking secrets and skips the rest", () => {
  const text = [
    'OPENAI_API_KEY="sk-synthetic-1234567890abcdef"',
    "export GITHUB_TOKEN=ghp_synthetic1234567890",
    "API_KEY=your-api-key-goes-here-please",
    "DATABASE_PASSWORD=short",
    "PORT=8080800808080808",
    "NEXT_PUBLIC_URL=https://example.com/a/long/path",
    "# COMMENTED_TOKEN=abcdefghijklmnopqrstuvwxyz",
    "TOKEN=${OTHER_TOKEN_FROM_SOMEWHERE}",
  ].join("\n");
  expect(secretsInText(text).map(({ name }) => name)).toEqual(["OPENAI_API_KEY", "GITHUB_TOKEN"]);
});

it("reads PowerShell's way of setting a variable", () => {
  expect(secretsInText('$env:OPENAI_API_KEY = "sk-synthetic-value-12345"')).toEqual([
    { name: "OPENAI_API_KEY", value: "sk-synthetic-value-12345" },
  ]);
});
