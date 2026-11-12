// @effect-diagnostics nodeBuiltinImport:off -- The function under test takes a plain path joiner.
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { developmentTrustedCertificates } from "./developmentCertificates.ts";

const HASH = "7P0tJMNXWoaYMQ1bJ5KUwLHVGb6GduIOmm6UorMVZVY=";
const file = NodePath.posix.join(
  "/candidate",
  "scient-next-dev",
  "server-browser",
  "dev-trusted-spki.txt",
);
const reader = (contents: string) => (path: string) => {
  if (path !== file) throw new Error("missing");
  return contents;
};

describe("development certificate trust", () => {
  it("is ignored by an installed app, even with the file present", () => {
    expect(
      developmentTrustedCertificates({
        env: { SCIENT_NEXT_HOME: "/candidate" },
        homeDirectory: "/home",
        joinPath: NodePath.posix.join,
        readFileString: reader(HASH),
      }),
    ).toBeNull();
  });

  it("trusts only well-formed hashes from the candidate's own state folder", () => {
    expect(
      developmentTrustedCertificates({
        env: { SCIENT_NEXT_HOME: "/candidate", VITE_DEV_SERVER_URL: "http://127.0.0.1:5733" },
        homeDirectory: "/home",
        joinPath: NodePath.posix.join,
        readFileString: reader(`${HASH}\n--disable-web-security\nnot-a-hash\n`),
      }),
    ).toBe(HASH);
  });
});
