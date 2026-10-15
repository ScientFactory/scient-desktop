import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderUpdateLines } from "./ProviderUpdateAllAction";

describe("ProviderUpdateLines", () => {
  it("names each machine, then each runtime with its versions and owner", () => {
    const markup = renderToStaticMarkup(
      <ProviderUpdateLines
        machines={[
          {
            environmentId: EnvironmentId.make("alvin"),
            label: "alvin",
            items: [
              {
                kind: "managed",
                environmentId: EnvironmentId.make("alvin"),
                machineLabel: "alvin",
                driver: ProviderDriverKind.make("codex"),
                instanceId: ProviderInstanceId.make("codex"),
                installedVersion: "0.48.0",
                offeredVersion: "0.50.1",
              },
              {
                kind: "system",
                environmentId: EnvironmentId.make("alvin"),
                machineLabel: "alvin",
                driver: ProviderDriverKind.make("claudeAgent"),
                instanceId: ProviderInstanceId.make("claudeAgent"),
                installedVersion: "2.1.3",
                offeredVersion: "2.2.0",
              },
            ],
          },
        ]}
      />,
    );
    expect(markup).toContain(">alvin</p>");
    expect(markup).toContain("Codex 0.48.0 → 0.50.1 · managed by Scient");
    expect(markup).toContain("Claude 2.1.3 → 2.2.0 · system install");
  });
});
