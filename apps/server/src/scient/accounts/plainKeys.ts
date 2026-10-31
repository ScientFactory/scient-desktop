// @effect-diagnostics nodeBuiltinImport:off -- Reads the user's shell profiles by their fixed names.
import * as NodeOS from "node:os";
import { AccountsError, type AccountPlainKey, type AccountPlainKeyInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { AccountsServiceShape } from "./AccountsService.ts";

const PROJECT_FILES = [".env", ".env.local", ".env.development", ".env.production"];
const SHELL_FILES = [
  ".zshrc",
  ".zprofile",
  ".bashrc",
  ".bash_profile",
  ".profile",
  "Documents/PowerShell/Microsoft.PowerShell_profile.ps1",
  "Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1",
];
const SECRET_NAME = /(?:^|_)(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|ACCESS_KEY)(?:$|_)/iu;
const NOT_A_VALUE = /^(?:your|<|\$|xxx|change|example|todo|none|null|true|false|\/|~)/iu;
const LINE =
  /^\s*(?:export\s+|\$env:)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]*))/gmu;

/** Assignments that look like real secrets: a secret's name, and a value long enough to be one. */
export function secretsInText(text: string) {
  return [...text.matchAll(LINE)].flatMap((match) => {
    const name = match[1] ?? "";
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    return SECRET_NAME.test(name) && value.length >= 16 && !NOT_A_VALUE.test(value)
      ? [{ name, value }]
      : [];
  });
}

const titleOf = (name: string) =>
  name
    .replace(/_?(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|ACCESS_KEY)$/iu, "")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/gu, (letter) => letter.toUpperCase()) || name;

/**
 * Plain secrets in project `.env` files and shell profiles, by name only. Scient never changes
 * those files: keeping a key in Accounts is an offer, and the file stays as it is.
 */
export const makePlainKeys = Effect.fn("PlainKeys.make")(function* (
  accounts: AccountsServiceShape,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = NodeOS.homedir();
  const readSecrets = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map(secretsInText),
      Effect.orElseSucceed(() => []),
    );
  const candidates = (roots: ReadonlyArray<string>) => [
    ...roots.flatMap((root) => PROJECT_FILES.map((file) => path.join(root, file))),
    ...SHELL_FILES.map((file) => path.join(home, file)),
  ];
  return {
    find: Effect.fn("PlainKeys.find")(function* (roots: ReadonlyArray<string>) {
      const { accounts: saved } = yield* accounts.snapshot;
      const known = new Set(
        saved.flatMap((account) =>
          account.details.kind === "api-key" && account.details.envName
            ? [account.details.envName]
            : [],
        ),
      );
      const found = yield* Effect.forEach(
        candidates(roots),
        (file) =>
          readSecrets(file).pipe(
            Effect.map((secrets) =>
              secrets.map(({ name }): AccountPlainKey => ({ file, name, kept: known.has(name) })),
            ),
          ),
        { concurrency: 8 },
      );
      return found.flat();
    }),
    keep: Effect.fn("PlainKeys.keep")(function* (
      input: AccountPlainKeyInput,
      roots: ReadonlyArray<string>,
    ) {
      if (!candidates(roots).includes(input.file))
        return yield* new AccountsError({
          reason: "invalid-input",
          message: "This file is not one Scient looks at.",
        });
      const value = (yield* readSecrets(input.file)).find(({ name }) => name === input.name)?.value;
      if (value === undefined)
        return yield* new AccountsError({
          reason: "not-found",
          message: "This key is no longer in the file.",
        });
      yield* accounts.save({
        name: titleOf(input.name),
        details: { kind: "api-key", sites: [], auth: { type: "bearer" }, envName: input.name },
        secrets: { token: { type: "scient", value } },
      });
    }),
  };
});
