import type { ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildModelOptions, groupByProvider } from "./modelOptions";

const provider = (driver: string, instanceId = driver) => ({
  instanceId,
  driver,
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  models: [{ slug: `${instanceId}-model`, name: "Model", isCustom: false, capabilities: null }],
});

describe("mobile model options for Scient providers", () => {
  it("groups Scient first and names Scient's drivers instead of showing their ids", () => {
    const config = {
      providers: [
        provider("codex"),
        provider("omp"),
        provider("droid"),
        provider("scient", "scient_lab"),
        provider("scient"),
      ],
    } as unknown as ServerConfig;

    expect(
      groupByProvider(buildModelOptions(config, null, undefined, null)).map((group) => [
        group.providerKey,
        group.providerLabel,
      ]),
    ).toEqual([
      ["scient", "Scient"],
      ["scient_lab", "scient_lab"],
      ["codex", "Codex"],
      ["droid", "Droid"],
      ["omp", "Oh My Pi"],
    ]);
  });
});
