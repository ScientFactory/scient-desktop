// @effect-diagnostics nodeBuiltinImport:off
import { publicationDigest } from "@t3tools/shared/scientPublicationArtifact";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Schema from "effect/Schema";

const decodeArtifact = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      protocol: Schema.Literal(1),
      platform: Schema.Literal("darwin"),
      arch: Schema.Literals(["arm64", "x64", "universal"]),
      probe: Schema.Literal(false),
      executable: Schema.Literal("scient-file-publication"),
    }),
  ),
);

/** Inspect the final app resource, including its real architecture and protocol. */
export async function validatePackagedFilePublication(
  app: string,
  arch: "arm64" | "x64" | "universal",
) {
  const directory = NodePath.join(app, "Contents/Resources/file-exchange");
  const helper = NodePath.join(directory, "scient-file-publication");
  const stat = await NodeFSP.lstat(helper);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0)
    throw new Error("Packaged file publication is not a regular executable.");
  const artifact = decodeArtifact(
    await NodeFSP.readFile(NodePath.join(directory, "publication-artifact.json"), "utf8"),
  );
  if (artifact.arch !== arch)
    throw new Error("Packaged file publication has the wrong architecture.");
  const receipt = JSON.parse(
    await NodeFSP.readFile(NodePath.join(directory, "publication-artifact.json"), "utf8"),
  );
  if (receipt.sha256 !== publicationDigest(await NodeFSP.readFile(helper)))
    throw new Error("Packaged file publication hash differs from its receipt.");
  const actual = NodeChildProcess.execFileSync("lipo", ["-archs", helper], {
    encoding: "utf8",
    timeout: 10_000,
  })
    .trim()
    .split(/\s+/u)
    .sort();
  const expected = (
    arch === "universal" ? ["arm64", "x86_64"] : [arch === "x64" ? "x86_64" : "arm64"]
  ).sort();
  if (actual.join(" ") !== expected.join(" "))
    throw new Error("Packaged file publication has the wrong architecture.");
  if (arch === "universal" || arch === HostProcess.Architecture.defaultValue()) {
    const capability = JSON.parse(
      NodeChildProcess.execFileSync(helper, ["--protocol=1", "capabilities"], {
        encoding: "utf8",
        timeout: 10_000,
      }),
    );
    if (capability.version !== 1 || !capability.atomicExchange || !capability.publicationLease)
      throw new Error("Packaged file publication has an incompatible protocol.");
  }
}
