// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { droidSystemManagedSettingsPath, readDroidOrgHookPolicy } from "./DroidOrgPolicy.ts";

/** A temp home and a stand-in for the system file; nothing outside the temp directory. */
const fixture = Effect.acquireRelease(
  Effect.sync(() => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-droid-org-policy-"));
    const home = NodePath.join(root, "home");
    NodeFS.mkdirSync(NodePath.join(home, ".factory", "cache"), { recursive: true });
    const write = (file: string, contents: string) => {
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, contents);
      return file;
    };
    const policy = (environment: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = "darwin") =>
      readDroidOrgHookPolicy({
        environment: { [platform === "win32" ? "USERPROFILE" : "HOME"]: home, ...environment },
        platform,
        cwd: root,
        systemSettingsPath: NodePath.join(root, "system", "settings.json"),
      });
    return {
      root,
      home,
      system: NodePath.join(root, "system", "settings.json"),
      write,
      policy,
    };
  }),
  ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ON = encodeJson({ allowManagedHooksOnly: true });
const OFF = encodeJson({ allowManagedHooksOnly: false, sessionRetentionDays: 30 });

describe("Droid organization hook policy", () => {
  it("names Droid's system managed-settings file per platform", () => {
    expect(droidSystemManagedSettingsPath("darwin")).toBe(
      "/Library/Application Support/Factory/settings.json",
    );
    expect(droidSystemManagedSettingsPath("linux")).toBe("/etc/factory/settings.json");
    expect(droidSystemManagedSettingsPath("win32")).toBe(
      "C:\\Program Files\\Factory\\settings.json",
    );
    expect(droidSystemManagedSettingsPath("aix")).toBeUndefined();
  });

  it.effect("allows overlay hooks when no policy source is present", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(yield* f.policy()).toBe("overlay-hooks-allowed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the system file, the only source when it exists", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const local = f.write(NodePath.join(f.root, "local.json"), ON);
      f.write(f.system, OFF);
      // Droid ignores the local path while the system file exists.
      expect(yield* f.policy({ FACTORY_ORG_MANAGED_SETTINGS_LOCAL_PATH: local })).toBe(
        "overlay-hooks-allowed",
      );
      f.write(f.system, `// managed by IT\n{ "allowManagedHooksOnly": true, }`);
      expect(yield* f.policy()).toBe("managed-hooks-only");
      f.write(f.system, "{ not json");
      expect(yield* f.policy()).toBe("unknown");
      f.write(f.system, encodeJson({ allowManagedHooksOnly: "yes" }));
      expect(yield* f.policy()).toBe("unknown");
      f.write(f.system, ON);
      NodeFS.chmodSync(f.system, 0o000);
      expect(yield* f.policy()).toBe("unknown");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads FACTORY_ORG_MANAGED_SETTINGS_LOCAL_PATH, relative to Droid's directory", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.write(NodePath.join(f.root, "on.json"), ON);
      f.write(NodePath.join(f.root, "off.json"), OFF);
      f.write(NodePath.join(f.root, "bad.json"), "[");
      const local = (file: string) => f.policy({ FACTORY_ORG_MANAGED_SETTINGS_LOCAL_PATH: file });
      expect(yield* local(NodePath.join(f.root, "on.json"))).toBe("managed-hooks-only");
      expect(yield* local("on.json")).toBe("managed-hooks-only");
      expect(yield* local("off.json")).toBe("overlay-hooks-allowed");
      expect(yield* local("bad.json")).toBe("unknown");
      expect(yield* local("missing.json")).toBe("unknown");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cannot rule out a policy Droid fetches from FACTORY_ORG_MANAGED_SETTINGS_URL", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(
        yield* f.policy({ FACTORY_ORG_MANAGED_SETTINGS_URL: "https://policy.example/org.json" }),
      ).toBe("unknown");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads Droid's cached answer from Factory's policy API, in either version's file", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const cache = (managedSettings: unknown) =>
        encodeJson({ orgId: "org", userId: "user", managedSettings, cachedAt: 1 });
      const current = NodePath.join(f.home, ".factory", "org-managed-settings.cache.json");
      const legacy = NodePath.join(f.home, ".factory", "cache", "org-managed-settings.json");
      f.write(current, cache(null));
      expect(yield* f.policy()).toBe("overlay-hooks-allowed");
      f.write(`${current}.backup`, cache({ allowManagedHooksOnly: true }));
      expect(yield* f.policy()).toBe("managed-hooks-only");
      NodeFS.rmSync(`${current}.backup`);
      f.write(legacy, cache({ allowManagedHooksOnly: true }));
      expect(yield* f.policy()).toBe("managed-hooks-only");
      f.write(legacy, "garbage");
      expect(yield* f.policy()).toBe("unknown");
      // Droid's settings folder follows FACTORY_HOME_OVERRIDE, then the home directory.
      const override = NodePath.join(f.root, "override");
      f.write(
        NodePath.join(override, ".factory", "org-managed-settings.cache.json"),
        cache({ allowManagedHooksOnly: true }),
      );
      expect(yield* f.policy({ FACTORY_HOME_OVERRIDE: override })).toBe("managed-hooks-only");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("matches Droid's variable names case-insensitively on Windows", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      // Windows looks environment names up case-insensitively, so Droid sees these.
      expect(
        yield* f.policy(
          { Factory_Org_Managed_Settings_Url: "https://policy.example/org.json" },
          "win32",
        ),
      ).toBe("unknown");
      const local = f.write(NodePath.join(f.root, "on.json"), ON);
      expect(yield* f.policy({ factory_org_managed_settings_local_path: local }, "win32")).toBe(
        "managed-hooks-only",
      );
      const override = NodePath.join(f.root, "override");
      f.write(
        NodePath.join(override, ".factory", "org-managed-settings.cache.json"),
        encodeJson({ managedSettings: { allowManagedHooksOnly: true } }),
      );
      expect(yield* f.policy({ Factory_Home_Override: override }, "win32")).toBe(
        "managed-hooks-only",
      );
      expect(yield* f.policy({ UserProfile: override, USERPROFILE: undefined }, "win32")).toBe(
        "managed-hooks-only",
      );
      // Elsewhere names are case-sensitive: Droid does not see these spellings.
      expect(
        yield* f.policy({
          Factory_Org_Managed_Settings_Url: "https://policy.example/org.json",
          factory_org_managed_settings_local_path: local,
          Factory_Home_Override: override,
        }),
      ).toBe("overlay-hooks-allowed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cannot tell which of several Windows spellings Droid sees", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const off = f.write(NodePath.join(f.root, "off.json"), OFF);
      const alsoOff = f.write(NodePath.join(f.root, "also-off.json"), OFF);
      expect(
        yield* f.policy(
          {
            FACTORY_ORG_MANAGED_SETTINGS_LOCAL_PATH: off,
            Factory_Org_Managed_Settings_Local_Path: alsoOff,
          },
          "win32",
        ),
      ).toBe("unknown");
      // An empty spelling beside a set one is just as ambiguous.
      expect(
        yield* f.policy(
          {
            FACTORY_ORG_MANAGED_SETTINGS_LOCAL_PATH: off,
            factory_org_managed_settings_local_path: "",
          },
          "win32",
        ),
      ).toBe("unknown");
      expect(
        yield* f.policy(
          { FACTORY_HOME_OVERRIDE: f.home, Factory_Home_Override: NodePath.join(f.root, "other") },
          "win32",
        ),
      ).toBe("unknown");
      // Identical spellings are one value.
      expect(
        yield* f.policy(
          {
            FACTORY_ORG_MANAGED_SETTINGS_LOCAL_PATH: off,
            Factory_Org_Managed_Settings_Local_Path: off,
          },
          "win32",
        ),
      ).toBe("overlay-hooks-allowed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
