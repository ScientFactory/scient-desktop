// Azure Trusted Signing from a non-Windows host. The Windows-only path is
// electron-builder's azureSignOptions (PowerShell + signtool.exe); this one is
// electron-builder's `win.signtoolOptions.sign` hook and the CLI archive's
// signer. jsign reads AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET
// itself when no --storepass is given.

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class JsignFailedError extends Schema.TaggedError<JsignFailedError>()("JsignFailedError", {
  file: Schema.String,
  exitCode: Schema.Number,
}) {
  override get message() {
    return `jsign exited with code ${String(this.exitCode)} signing ${this.file}.`;
  }
}

export class JsignConfigurationError extends Schema.TaggedError<JsignConfigurationError>()(
  "JsignConfigurationError",
  {},
) {
  override get message() {
    return "Azure Trusted Signing requires an HTTPS service endpoint without credentials or a path.";
  }
}

export const signWithJsign = Effect.fn("signWithJsign")(function* (file: string) {
  const { jsign, endpoint, account, profile } = yield* Config.all({
    jsign: Config.String("T3CODE_JSIGN").pipe(Config.withDefault("jsign")),
    endpoint: Config.String("AZURE_TRUSTED_SIGNING_ENDPOINT"),
    account: Config.String("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
    profile: Config.String("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"),
  });
  const keystore = yield* Effect.try({
    try: () => {
      const url = new URL(endpoint);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid signing endpoint");
      return url.host;
    },
    catch: () => new JsignConfigurationError(),
  });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(
      jsign,
      [
        "--storetype",
        "TRUSTEDSIGNING",
        "--keystore",
        keystore,
        "--alias",
        `${account}/${profile}`,
        "--alg",
        "SHA-256",
        "--tsaurl",
        "http://timestamp.acs.microsoft.com",
        "--tsmode",
        "RFC3161",
        // jsign appends a nested signature by default; signtool replaces.
        "--replace",
        file,
      ],
      { stdout: "inherit", stderr: "inherit" },
    ),
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) {
    return yield* new JsignFailedError({ file, exitCode });
  }
});

export default function sign(configuration: { readonly path: string }): Promise<void> {
  return signWithJsign(configuration.path).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );
}
