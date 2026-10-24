import { expect, it } from "@effect/vitest";

import { runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

it.each([1, 2])(
  "blocks legacy launcher protocol %i with installation-specific guidance",
  (launcherProtocol) => {
    const result = runServicePreflight({
      databasePath: "/missing/private-profile/state.sqlite",
      launcherProtocol,
      version: "9.8.7",
    });

    expect(result).toMatchObject({ status: "blocked", version: "9.8.7" });
    const reason = result.status === "blocked" ? result.reason : "";
    expect(reason).toContain(`launcher speaks protocol ${launcherProtocol}`);
    expect(reason).toContain("9.8.7");
    expect(reason).toContain(`protocol ${SERVICE_LAUNCHER_PROTOCOL}`);
    expect(reason).toContain("matching Scient installation");
    expect(reason).toContain("for this profile");
    expect(reason).not.toContain("curl");
    expect(reason).not.toContain("~/.local/bin/t3");
  },
);
