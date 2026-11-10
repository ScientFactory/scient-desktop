// @effect-diagnostics nodeBuiltinImport:off -- Writes the candidate's trust file in a scratch folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { developmentTrustedCertificateArgs } from "./developmentCertificates.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const HASH = "7P0tJMNXWoaYMQ1bJ5KUwLHVGb6GduIOmm6UorMVZVY=";

const profilesWithTrustFile = async (contents: string) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-dev-certs-"));
  roots.push(root);
  const profiles = NodePath.join(root, "server-browser", "profiles");
  await NodeFSP.mkdir(profiles, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "server-browser", "dev-trusted-spki.txt"), contents);
  return profiles;
};

describe("development certificate trust", () => {
  it("is ignored outside a development build, even with the file present", async () => {
    const profiles = await profilesWithTrustFile(`${HASH}\n`);
    expect(await developmentTrustedCertificateArgs({}, profiles)).toEqual([]);
    expect(
      await developmentTrustedCertificateArgs({ SCIENT_NEXT_DEVELOPMENT_STATE: "false" }, profiles),
    ).toEqual([]);
  });

  it("trusts only well-formed hashes in a development build", async () => {
    const profiles = await profilesWithTrustFile(`${HASH}\n--disable-web-security\nnot-a-hash\n`);
    expect(
      await developmentTrustedCertificateArgs({ SCIENT_NEXT_DEVELOPMENT_STATE: "true" }, profiles),
    ).toEqual([`--ignore-certificate-errors-spki-list=${HASH}`]);
  });
});
