import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarUpdatePresentation } from "~/components/sidebar/SidebarUpdatePill";
import { shouldRunUpdateEverything } from "~/components/sidebar/updateEverything.logic";

import {
  describeUpdateEverythingDetails,
  UpdateEverythingTooltip,
  withUpdatesAfterRestart,
} from "./sidebarUpdateButton";

const icon = (input: {
  readonly action: "none" | "download" | "install";
  readonly remote?: boolean;
  readonly downloading?: boolean;
}) => {
  const isDownloading = input.downloading ?? false;
  return resolveSidebarUpdatePresentation({
    action: input.action,
    showsEverything: shouldRunUpdateEverything(input.remote ?? false, isDownloading, input.action),
    isDownloading,
    showCheckIcon: false,
  }).iconStatus;
};

describe("sidebar update button identity", () => {
  it.each([
    ["the app update alone", { action: "download" }, "available"],
    ["the app update with others", { action: "download", remote: true }, "available"],
    [
      "the app downloading with others",
      { action: "download", remote: true, downloading: true },
      "downloading",
    ],
    ["the app ready with others", { action: "install", remote: true }, "downloaded"],
    ["providers and servers alone", { action: "none", remote: true }, "everything"],
    ["nothing pending", { action: "none" }, "idle"],
  ] as const)("shows %s as %s", (_case, input, expected) => {
    expect(icon(input)).toBe(expected);
  });

  it("keeps Restart a direct restart while other updates wait", () => {
    expect(shouldRunUpdateEverything(true, false, "install")).toBe(false);
    expect(shouldRunUpdateEverything(true, false, "download")).toBe(true);
  });
});

describe("withUpdatesAfterRestart", () => {
  it("adds what can update once the app is back", () => {
    expect(
      withUpdatesAfterRestart(
        "Update 1.5.0 ready. Restart to install",
        "Update 1 server and 2 providers",
      ),
    ).toBe("Update 1.5.0 ready. Restart to install. Then update 1 server and 2 providers.");
    expect(withUpdatesAfterRestart("Restart to install.", null)).toBe("Restart to install.");
  });
});

describe("describeUpdateEverythingDetails", () => {
  const alvin = EnvironmentId.make("alvin");
  const details = describeUpdateEverythingDetails({
    localVersion: "1.5.0",
    servers: [
      {
        environmentId: alvin,
        serverLabel: "alvin",
        selfUpdate: "boot-service",
        targetVersion: "1.5.0",
      },
    ],
    providerMachines: [
      {
        environmentId: alvin,
        label: "alvin",
        items: [
          {
            kind: "managed",
            environmentId: alvin,
            machineLabel: "alvin",
            driver: ProviderDriverKind.make("codex"),
            instanceId: ProviderInstanceId.make("codex"),
            installedVersion: "0.48.0",
            offeredVersion: "0.50.1",
          },
        ],
      },
    ],
  });

  it("lists this app first, then one line per server or provider on each machine", () => {
    expect(details.map(({ label, items }) => ({ label, items }))).toEqual([
      { label: "This app", items: ["1.5.0 · restarts last"] },
      { label: "alvin", items: ["Server → 1.5.0", "Codex 0.48.0 → 0.50.1 · managed by Scient"] },
    ]);
  });

  it("renders the summary above each machine's lines", () => {
    const markup = renderToStaticMarkup(
      <UpdateEverythingTooltip
        summary="Update this app, 1 server, and 1 provider"
        details={details}
      />,
    );
    expect(markup.indexOf("Update this app, 1 server, and 1 provider")).toBeLessThan(
      markup.indexOf("Codex 0.48.0 → 0.50.1 · managed by Scient"),
    );
  });
});
