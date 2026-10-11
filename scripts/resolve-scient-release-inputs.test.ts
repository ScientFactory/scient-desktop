// @effect-diagnostics nodeBuiltinImport:off - Release-policy tests use disposable Git and filesystem fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { resolveScientReleaseInputs } from "./resolve-scient-release-inputs.ts";
import { runScientReleasePreflight } from "./scient-release-preflight.ts";

const sha = "a".repeat(40);
const base = {
  channel: "beta",
  version: "",
  sourceSha: "",
  workflowSha: sha,
  publishRelease: false,
  allowUnsignedWindows: false,
  latestStableVersion: "v0.6.23",
  betaTags: [],
  date: "20261011",
};

describe("Scient release dispatch policy", () => {
  it("makes choosing Beta sufficient to publish the exact main commit with the approved Windows exception", () => {
    expect(resolveScientReleaseInputs(base)).toEqual({
      version: "0.6.24-beta.20261011.1",
      source_sha: sha,
      publish_release: true,
      allow_unsigned_windows: true,
      latest_beta_version: "",
    });
  });

  it("advances past every existing release, including reserved drafts, irrespective of API order", () => {
    expect(
      resolveScientReleaseInputs({
        ...base,
        betaTags: ["v0.6.24-beta.20261011.12", "v0.6.24-beta.20261011.2"],
      }).version,
    ).toBe("0.6.24-beta.20261011.13");
    expect(
      resolveScientReleaseInputs({
        ...base,
        betaTags: ["v0.7.0-beta.20261012.1"],
      }).version,
    ).toBe("0.7.0-beta.20261012.2");
    expect(
      resolveScientReleaseInputs({
        ...base,
        latestStableVersion: "v0.6.24",
        betaTags: ["v0.6.24-beta.20261011.12"],
      }).version,
    ).toBe("0.6.25-beta.20261011.1");
  });

  it("resets the sequence on a new date and permits an explicit newer version", () => {
    expect(
      resolveScientReleaseInputs({
        ...base,
        betaTags: ["v0.6.24-beta.20261010.99"],
      }).version,
    ).toBe("0.6.24-beta.20261011.1");
    expect(
      resolveScientReleaseInputs({
        ...base,
        version: "v0.7.0-beta.20261011.1",
      }).version,
    ).toBe("0.7.0-beta.20261011.1");
  });

  it("retains Stable's explicit inputs and build-only defaults", () => {
    const stable = { ...base, channel: "stable", version: "0.6.24", sourceSha: sha };
    expect(resolveScientReleaseInputs(stable).publish_release).toBe(false);
    expect(resolveScientReleaseInputs(stable).allow_unsigned_windows).toBe(false);
    expect(resolveScientReleaseInputs({ ...stable, publishRelease: true }).publish_release).toBe(
      true,
    );
    expect(() => resolveScientReleaseInputs({ ...stable, version: "" })).toThrow("canonical x.y.z");
    expect(() => resolveScientReleaseInputs({ ...stable, sourceSha: "" })).toThrow("40-character");
  });

  it("rejects wrong sources, channel/version mismatches and regressions before packaging", () => {
    expect(() => resolveScientReleaseInputs({ ...base, sourceSha: "b".repeat(40) })).toThrow(
      "exact workflow commit",
    );
    expect(() => resolveScientReleaseInputs({ ...base, channel: "nightly" })).toThrow(
      "stable or beta",
    );
    expect(() => resolveScientReleaseInputs({ ...base, version: "0.6.24" })).toThrow(
      "beta.YYYYMMDD.N",
    );
    expect(() =>
      resolveScientReleaseInputs({ ...base, version: "0.6.23-beta.20261011.1" }),
    ).toThrow("newer than current Stable");
    expect(() =>
      resolveScientReleaseInputs({
        ...base,
        version: "0.6.24-beta.20261011.1",
        betaTags: ["v0.6.24-beta.20261011.2"],
      }),
    ).toThrow("newer than existing Beta");
  });

  it("accepts Beta without a release-note catalog while Stable still requires approved notes", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-beta-notes-"));
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    try {
      git("init", "-q");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.org",
        "commit",
        "--allow-empty",
        "-qm",
        "fixture",
      );
      const sourceSha = git("rev-parse", "HEAD");
      const notesOutput = NodePath.join(root, "notes.md");
      const options = { sourceSha, releaseSha: sourceSha, root, allowNoteFree: false, notesOutput };
      await runScientReleasePreflight({
        ...options,
        version: "0.6.24-beta.20261011.1",
        channel: "beta",
        latestStableVersion: "0.6.23",
      });
      expect(NodeFS.readFileSync(notesOutput, "utf8")).toBe("");
      await expect(
        runScientReleasePreflight({ ...options, version: "0.6.24", channel: "stable" }),
      ).rejects.toThrow("catalog is not present");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
