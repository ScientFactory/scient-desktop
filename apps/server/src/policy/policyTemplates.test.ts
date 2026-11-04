import { assert, it } from "@effect/vitest";
import {
  MACOS_MANAGED_PREFERENCES_PATH,
  WINDOWS_POLICY_GROUPS,
  WINDOWS_POLICY_KEY,
  WINDOWS_POLICY_LISTS,
  WINDOWS_POLICY_VALUES,
} from "@t3tools/shared/managedPolicyFile";

import { MACOS_POLICY_DOMAIN, macosProfile, windowsAdml, windowsAdmx } from "./policyTemplates.ts";

it("gives every registry value the Windows reader accepts a Group Policy control", () => {
  const admx = windowsAdmx();
  for (const name of Object.keys(WINDOWS_POLICY_VALUES)) {
    assert.include(admx, `valueName="${name}"`);
  }
  for (const key of Object.keys(WINDOWS_POLICY_LISTS)) {
    assert.include(admx, `key="SOFTWARE\\Policies\\ScientFactory\\Scient\\${key}"`);
  }
  for (const name of Object.keys(WINDOWS_POLICY_GROUPS)) {
    assert.include(admx, `valueName="${name}"`);
  }
});

it("refuses a profile for a policy with a null value, which a plist cannot hold", () => {
  const profile = macosProfile(
    {
      schemaVersion: 1,
      organization: "Example Corp",
      settings: { defaultModelSelection: { value: null, locked: true } },
    },
    { profile: "profile-uuid", payload: "payload-uuid" },
  );
  assert.deepStrictEqual(profile, {
    _tag: "Invalid",
    reason:
      "settings.defaultModelSelection is null, which a configuration profile cannot hold; deploy this policy as a file.",
  });
});

// SCIENT-FORK:START — templates must write where Scient's policy reader looks.
it("writes the registry key and preference domain the policy reader reads", () => {
  assert.equal(WINDOWS_POLICY_KEY, "HKLM\\SOFTWARE\\Policies\\ScientFactory\\Scient");
  const admx = windowsAdmx();
  assert.include(admx, ` key="${WINDOWS_POLICY_KEY.slice("HKLM\\".length)}"`);
  assert.include(admx, 'namespace="ScientFactory.Policies.Scient"');
  assert.notMatch(`${admx}${windowsAdml()}`, /T3|t3code/);

  assert.equal(MACOS_POLICY_DOMAIN, "com.scientfactory.scient");
  assert.equal(
    MACOS_MANAGED_PREFERENCES_PATH,
    `/Library/Managed Preferences/${MACOS_POLICY_DOMAIN}.plist`,
  );
  const profile = macosProfile(
    { schemaVersion: 1, organization: "Example Corp" },
    { profile: "profile-uuid", payload: "payload-uuid" },
  );
  assert.equal(profile._tag, "Valid");
  if (profile._tag === "Valid") {
    // The payload a profile installs lands in the domain the reader opens.
    assert.match(
      profile.profile,
      /<key>PayloadType<\/key>\s*<string>com\.scientfactory\.scient<\/string>/,
    );
    assert.notMatch(profile.profile, /T3|t3code/);
  }
});
// SCIENT-FORK:END
