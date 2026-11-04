// @effect-diagnostics nodeBuiltinImport:off -- Copy records are plain files written beside the cookie work, outside Effect.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { SessionCookie } from "@t3tools/contracts";
import {
  unitFingerprintText,
  withMainCopies,
  type MainCopy,
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

/** One queue per file: environments have separate Main locks but share the file. */
const queues = new Map<string, Promise<unknown>>();

/**
 * What each copy into an environment's Main wrote, by source profile, in one file of digests.
 * Every operation reads the file afresh, one at a time.
 */
export function mainCopyRecords(file: string): MainCopyRecords {
  const serial = <A>(operation: () => Promise<A>) => {
    const next = (queues.get(file) ?? Promise.resolve()).then(operation, operation);
    queues.set(
      file,
      next.catch(() => undefined),
    );
    return next;
  };
  const load = () =>
    NodeFSP.readFile(file, "utf8").then(
      (text): ByEnvironment => ({ ...Option.getOrElse(decodeRecords(text), () => ({})) }),
      (): ByEnvironment => ({}),
    );
  const save = async (records: ByEnvironment) => {
    const temporary = `${file}.tmp`;
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    // A leftover temporary file would keep its own mode; this one is the owner's alone.
    await NodeFSP.rm(temporary, { force: true });
    await NodeFSP.writeFile(temporary, JSON.stringify(records), { mode: 0o600 });
    await NodeFSP.rename(temporary, file);
  };
  return {
    record: (environmentId, copies) =>
      copies.length === 0
        ? Promise.resolve()
        : serial(async () => {
            const records = await load();
            records[environmentId] = withMainCopies(records[environmentId] ?? [], copies);
            await save(records);
          }).catch(() => undefined),
    from: (environmentId, profileId) =>
      serial(async () =>
        ((await load())[environmentId] ?? []).filter((copy) => copy.from === profileId),
      ),
    forget: (environmentId, profileId) =>
      serial(async () => {
        const records = await load();
        const kept = (records[environmentId] ?? []).filter((copy) => copy.from !== profileId);
        if (kept.length === (records[environmentId] ?? []).length) return;
        records[environmentId] = kept;
        await save(records);
      }).catch(() => undefined),
  };
}
