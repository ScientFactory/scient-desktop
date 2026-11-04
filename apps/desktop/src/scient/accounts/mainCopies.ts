// @effect-diagnostics nodeBuiltinImport:off -- Copy records are plain files written beside the cookie work, outside Effect.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { SessionCookie } from "@t3tools/contracts";
import {
  unitFingerprintText,
  withMainCopies,
  type MainCopy,
  type SiteOf,
} from "@t3tools/shared/scientSessionCookies";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Records = Schema.Record(
  Schema.String,
  Schema.Array(
    Schema.Struct({
      from: Schema.String,
      sites: Schema.Array(Schema.String),
      fingerprint: Schema.String,
    }),
  ),
);
const decodeRecords = Schema.decodeUnknownOption(Schema.fromJsonString(Records));

/** The digest a copy into Main records, the same one a computer receiving sign-ins keeps. */
export const mainCopyFingerprint = (cookies: ReadonlyArray<SessionCookie>, nowSeconds: number) =>
  NodeCrypto.createHash("sha256")
    .update(unitFingerprintText(cookies, nowSeconds))
    .digest("base64url");

export interface MainCopyRecords {
  readonly record: (environmentId: string, copies: ReadonlyArray<MainCopy>) => Promise<void>;
  readonly from: (environmentId: string, profileId: string) => Promise<ReadonlyArray<MainCopy>>;
  readonly forget: (environmentId: string, profileId: string) => Promise<void>;
}

type ByEnvironment = Record<string, ReadonlyArray<MainCopy>>;

const stores = new Map<string, MainCopyRecords>();

/**
 * What each copy into an environment's Main wrote, by source profile, in one file of digests.
 * Callers hold that environment's Main lock, so reads and writes of one environment never race.
 */
export function mainCopyRecords(file: string, siteOf: SiteOf): MainCopyRecords {
  const known = stores.get(file);
  if (known) return known;
  let loaded: Promise<ByEnvironment> | undefined;
  let writes = Promise.resolve();
  const load = () =>
    (loaded ??= NodeFSP.readFile(file, "utf8").then(
      (text): ByEnvironment => ({ ...Option.getOrElse(decodeRecords(text), () => ({})) }),
      (): ByEnvironment => ({}),
    ));
  const save = (records: ByEnvironment) => {
    writes = writes
      .then(async () => {
        const temporary = `${file}.tmp`;
        await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
        await NodeFSP.writeFile(temporary, JSON.stringify(records), { mode: 0o600 });
        await NodeFSP.rename(temporary, file);
      })
      .catch(() => undefined);
    return writes;
  };
  const store: MainCopyRecords = {
    record: async (environmentId, copies) => {
      if (copies.length === 0) return;
      const records = await load();
      records[environmentId] = withMainCopies(records[environmentId] ?? [], copies, siteOf);
      await save(records);
    },
    from: async (environmentId, profileId) =>
      ((await load())[environmentId] ?? []).filter((copy) => copy.from === profileId),
    forget: async (environmentId, profileId) => {
      const records = await load();
      const kept = (records[environmentId] ?? []).filter((copy) => copy.from !== profileId);
      if (kept.length === (records[environmentId] ?? []).length) return;
      records[environmentId] = kept;
      await save(records);
    },
  };
  stores.set(file, store);
  return store;
}
