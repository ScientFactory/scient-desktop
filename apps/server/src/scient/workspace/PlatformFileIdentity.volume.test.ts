import { describe, expect, it } from "@effect/vitest";

import { type CommandRunner, macVolumeReading } from "./PlatformFileIdentity.ts";

const UUID = "0a1b2c3d-0000-4000-8000-000000000001";
const DF =
  "Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk6s1 81880 1 81879 1% /m\n";
const INFO = `<dict>\n\t<key>VolumeUUID</key>\n\t<string>${UUID}</string>\n</dict>`;

/** Answers each command from its queue, recording what ran. */
const scripted = (answers: Record<string, Array<Awaited<ReturnType<CommandRunner>>>>) => {
  const calls: Array<string> = [];
  const run: CommandRunner = async (file) => {
    calls.push(file);
    const next = answers[file]?.shift();
    if (next === undefined) throw new Error(`Unexpected ${file}`);
    return next;
  };
  return { run, calls };
};

describe("macVolumeReading", () => {
  it("reads the volume again when one diskutil query fails", async () => {
    const { run, calls } = scripted({
      "/bin/df": [{ stdout: DF }, { stdout: DF }],
      "/usr/sbin/diskutil": [
        { failure: "diskutil was killed (SIGTERM) after 10003 ms" },
        { stdout: INFO },
      ],
    });
    expect(await macVolumeReading("/m/paper", run)).toEqual({ volume: UUID.toUpperCase() });
    expect(calls).toEqual(["/bin/df", "/usr/sbin/diskutil", "/bin/df", "/usr/sbin/diskutil"]);
  });

  it("keeps why both reads failed", async () => {
    const { run } = scripted({
      "/bin/df": [{ failure: "df exited 1 after 4 ms: No such file" }, { stdout: DF }],
      "/usr/sbin/diskutil": [{ stdout: "<dict></dict>" }],
    });
    expect(await macVolumeReading("/m/paper", run)).toEqual({
      volume: null,
      reason:
        "diskutil reported no VolumeUUID for /dev/disk6s1; first try: df exited 1 after 4 ms: No such file",
    });
  });

  it("does not ask again about a folder that is not on a disk", async () => {
    const { run, calls } = scripted({
      "/bin/df": [{ stdout: "Filesystem 512-blocks\n//server/share 1 1 1 1% /m\n" }],
    });
    expect(await macVolumeReading("/m/paper", run)).toEqual({
      volume: null,
      reason: "df names //server/share, not a disk",
    });
    expect(calls).toEqual(["/bin/df"]);
  });
});
