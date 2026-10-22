import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { parseScientPluginManifest } from "./ScientPluginManifest.ts";

const valid = {
  apiVersion: "scient.plugins/v1alpha1",
  id: "acme.lab",
  version: "1.2.0-beta.1+build.7",
  displayName: "Acme Lab",
  description: "Lab notebook guidance and the Acme MCP server.",
  publisher: "Acme",
  contributes: {
    skills: ["skills/lab-notes"],
    connectors: [{ url: "https://mcp.acme.example/mcp", displayName: "Acme" }],
  },
};

const parse = (value: unknown) =>
  parseScientPluginManifest(new TextEncoder().encode(JSON.stringify(value)));

const rejection = (value: unknown) =>
  Effect.flip(parse(value)).pipe(Effect.map((error) => [error.reason, error.message] as const));

describe("scient.plugin.json", () => {
  it.effect("accepts a declarative manifest", () =>
    Effect.gen(function* () {
      const manifest = yield* parse(valid);
      expect(manifest.id).toBe("acme.lab");
      expect(manifest.contributes.skills).toEqual(["skills/lab-notes"]);
      expect(yield* parse({ ...valid, contributes: {} })).toMatchObject({ contributes: {} });
    }),
  );

  it.effect("rejects capabilities, settings and code with a named reason", () =>
    Effect.gen(function* () {
      const [reason, capabilities] = yield* rejection({
        ...valid,
        contributes: { ...valid.contributes, capabilities: ["sources:write"] },
      });
      expect(reason).toBe("invalid-input");
      expect(capabilities).toContain("'capabilities'");
      expect(capabilities).toContain("reserved for built-in plugins");
      expect((yield* rejection({ ...valid, capabilities: ["preview"] }))[1]).toContain(
        "'capabilities'",
      );
      expect(
        (yield* rejection({ ...valid, contributes: { settingsPage: "/settings/acme" } }))[1],
      ).toContain("'settingsPage'");
      for (const codeKey of ["main", "scripts", "bin", "hooks", "mcpServers"]) {
        expect((yield* rejection({ ...valid, [codeKey]: "index.js" }))[1]).toContain(
          "plugins cannot run code",
        );
      }
      expect(
        (yield* rejection({
          ...valid,
          contributes: { mcpServers: { local: { command: "node" } } },
        }))[1],
      ).toContain("plugins cannot run code");
    }),
  );

  it.effect("rejects unknown keys instead of ignoring them", () =>
    Effect.gen(function* () {
      expect((yield* rejection({ ...valid, permissions: ["all"] }))[1]).toContain("permissions");
      expect(
        (yield* rejection({ ...valid, contributes: { ...valid.contributes, panels2: [] } }))[1],
      ).toContain("panels2");
    }),
  );

  it.effect("requires an exact SemVer version", () =>
    Effect.gen(function* () {
      for (const version of ["1.0", "v1.0.0", "^1.0.0", "01.0.0", "1.0.0-", "latest"]) {
        expect((yield* rejection({ ...valid, version }))[0]).toBe("invalid-input");
      }
    }),
  );

  it.effect("rejects unsafe paths, connector URLs, ids and versions of the format", () =>
    Effect.gen(function* () {
      for (const skills of [
        ["../outside"],
        ["/abs"],
        ["a/./b"],
        ["a\\b"],
        ["a", "a/b"],
        ["a", "a"],
      ]) {
        expect((yield* rejection({ ...valid, contributes: { skills } }))[0]).toBe("invalid-input");
      }
      for (const url of [
        "http://mcp.acme.example/mcp",
        "https://user:pass@mcp.acme.example/mcp",
        "not a url",
      ]) {
        expect(
          (yield* rejection({
            ...valid,
            contributes: { connectors: [{ url, displayName: "Acme" }] },
          }))[0],
        ).toBe("invalid-input");
      }
      expect(
        (yield* rejection({
          ...valid,
          contributes: {
            connectors: [
              { url: "https://mcp.acme.example/mcp", displayName: "One" },
              { url: "https://MCP.acme.example/mcp", displayName: "Two" },
            ],
          },
        }))[1],
      ).toContain("more than once");
      expect((yield* rejection({ ...valid, id: "Acme Lab" }))[0]).toBe("invalid-input");
      expect((yield* rejection({ ...valid, apiVersion: "scient.plugins/v2" }))[1]).toContain(
        "apiVersion",
      );
      expect(
        (yield* Effect.flip(parseScientPluginManifest(new TextEncoder().encode("{")))).message,
      ).toContain("not valid");
    }),
  );
});
