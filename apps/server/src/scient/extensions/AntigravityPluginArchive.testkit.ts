// @effect-diagnostics nodeBuiltinImport:off -- test archives are built in memory.
import * as NodeStreamConsumers from "node:stream/consumers";
import * as Effect from "effect/Effect";
import * as yazl from "yazl";

export interface ZipMember {
  readonly name: string;
  readonly data?: string;
  readonly mode?: number;
  readonly directory?: boolean;
}

export const makeZip = (members: ReadonlyArray<ZipMember>) =>
  Effect.promise(() => {
    const zip = new yazl.ZipFile();
    for (const member of members) {
      if (member.directory) zip.addEmptyDirectory(member.name, { mode: member.mode ?? 0o40755 });
      else
        zip.addBuffer(Buffer.from(member.data ?? ""), member.name, {
          mode: member.mode ?? 0o100644,
        });
    }
    zip.end();
    return NodeStreamConsumers.buffer(zip.outputStream);
  });

/** yazl refuses unsafe names, so a same-length safe name is rewritten in the finished bytes. */
export const renameInZip = (zip: Buffer, from: string, to: string) =>
  Buffer.from(zip.toString("latin1").split(from).join(to), "latin1");
