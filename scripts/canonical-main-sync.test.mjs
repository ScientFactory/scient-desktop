import { assert, describe, it } from "vite-plus/test";

import { CANONICAL_SYNC_LABEL, makeLaunchAgentPlist } from "./canonical-main-sync.mjs";

describe("canonical main sync", () => {
  it("generates a guarded one-minute launch agent for the stable role", () => {
    const plist = makeLaunchAgentPlist({
      root: "/repo/scient-desktop-next",
      nodePath: "/toolchains/node24/bin/node",
    });

    assert.include(plist, `<string>${CANONICAL_SYNC_LABEL}</string>`);
    assert.include(plist, "/repo/scient-desktop-next/scripts/canonical-main-sync.mjs");
    assert.include(plist, "<string>--once</string>");
    assert.include(plist, "<integer>60</integer>");
    assert.include(plist, "<string>stable</string>");
    assert.include(plist, "/toolchains/node24/bin:/opt/homebrew/bin");
  });
});
