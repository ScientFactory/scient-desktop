import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { AccountId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { expect, it } from "vite-plus/test";
import { fakeAccounts } from "./Accounts.testkit.ts";
import { makePlainKeys, secretsInText } from "./plainKeys.ts";

it("finds real-looking secrets and skips the rest", () => {
  const text = [
    'OPENAI_API_KEY="sk-synthetic-1234567890abcdef"',
    "export GITHUB_TOKEN=ghp_synthetic1234567890",
    "API_KEY=your-api-key-goes-here-please",
    "DATABASE_PASSWORD=short",
    "PORT=8080800808080808",
    "NEXT_PUBLIC_URL=https://example.com/a/long/path",
    "# COMMENTED_TOKEN=abcdefghijklmnopqrstuvwxyz",
    "TOKEN=${OTHER_TOKEN_FROM_SOMEWHERE}",
  ].join("\n");
  expect(secretsInText(text).map(({ name }) => name)).toEqual(["OPENAI_API_KEY", "GITHUB_TOKEN"]);
});

it("reads PowerShell's way of setting a variable", () => {
  expect(secretsInText('$env:OPENAI_API_KEY = "sk-synthetic-value-12345"')).toEqual([
    { name: "OPENAI_API_KEY", value: "sk-synthetic-value-12345" },
  ]);
});

effectIt.effect("counts a file's key as kept only when its value is in Accounts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${root}/.env`, "OPENAI_API_KEY=sk-synthetic-development-key");
    yield* fs.writeFileString(
      `${root}/.env.production`,
      "OPENAI_API_KEY=sk-synthetic-production-key",
    );
    const kept = {
      accountId: AccountId.make("acc_fixture1"),
      details: { kind: "api-key", envName: "OPENAI_API_KEY" },
      secrets: { token: { source: { type: "scient" } } },
    };
    const accounts = fakeAccounts({
      accounts: [kept as never],
      values: { token: "sk-synthetic-development-key" },
    });
    const found = yield* (yield* makePlainKeys(accounts.service, Effect.succeed([root]))).find();
    expect(found.filter((key) => key.file.startsWith(root))).toEqual([
      { file: `${root}/.env`, name: "OPENAI_API_KEY", kept: true },
      { file: `${root}/.env.production`, name: "OPENAI_API_KEY", kept: false },
    ]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

effectIt.effect("keeps a key only from a file in one of the server's own projects", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const project = yield* fs.makeTempDirectoryScoped();
    const elsewhere = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${elsewhere}/.env`, "OPENAI_API_KEY=sk-synthetic-elsewhere-key");
    const accounts = fakeAccounts();
    const plainKeys = yield* makePlainKeys(accounts.service, Effect.succeed([project]));
    const error = yield* Effect.flip(
      plainKeys.keep({ file: `${elsewhere}/.env`, name: "OPENAI_API_KEY" }),
    );
    expect(error.reason).toBe("invalid-input");
    expect(accounts.saves).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
