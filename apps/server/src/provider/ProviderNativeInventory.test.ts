import { assert, describe, it } from "@effect/vitest";

import {
  claudeNativeInventoryFromInit,
  claudeNativeMcpServers,
} from "./ProviderNativeInventory.ts";

describe("claudeNativeInventoryFromInit", () => {
  it("lists only provider-native servers, never the ones Scient delivered to the session", () => {
    const inventory = claudeNativeInventoryFromInit(
      {
        plugins: [
          { name: "review-tools", path: "/home/u/.claude/plugins/review-tools", version: "2.0.1" },
          { name: "review-tools", path: "/elsewhere" },
          { name: " ", path: "/blank" },
        ],
        mcp_servers: [
          { name: "scient", status: "connected", source: "dynamic" },
          { name: "t3-code", status: "connected" },
          { name: "linear", status: "connected", source: "dynamic" },
          { name: "github", status: "needs-auth", source: "user" },
          { name: "sentry", status: "starting" },
        ],
      },
      new Set(["linear"]),
    );

    assert.deepStrictEqual(inventory, {
      plugins: [
        {
          id: "review-tools",
          name: "review-tools",
          source: "local",
          enabled: true,
          version: "2.0.1",
        },
      ],
      mcpServers: [
        { name: "github", status: "needs-auth", scope: "user" },
        { name: "sentry", status: "unknown" },
      ],
    });
  });

  it("keeps a configured server that shares a delivered connector's name", () => {
    assert.deepStrictEqual(
      claudeNativeMcpServers(
        [
          { name: "github", status: "connected", source: "project" },
          { name: "github", status: "connected", source: "dynamic" },
          { name: "scient", status: "connected", source: "user" },
        ],
        new Set(["github"]),
      ),
      [
        { name: "github", status: "connected", scope: "project" },
        { name: "scient", status: "connected", scope: "user" },
      ],
    );
  });

  it("leaves out fields an older CLI does not report", () => {
    assert.deepStrictEqual(claudeNativeInventoryFromInit({}, new Set()), {});
  });
});
