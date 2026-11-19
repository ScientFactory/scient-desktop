import { describe, expect, it } from "vite-plus/test";

import { parseDarwinPlatformUuid, parseWindowsMachineGuid } from "./MachineId.ts";

describe("machine id parsing", () => {
  it("reads the macOS platform UUID from ioreg", () => {
    expect(
      parseDarwinPlatformUuid(
        '  "IOPlatformSerialNumber" = "C02XXXX"\n  "IOPlatformUUID" = "5C2A1B3D-0E4F-4A5B-9C8D-7E6F5A4B3C2D"\n',
      ),
    ).toBe("5C2A1B3D-0E4F-4A5B-9C8D-7E6F5A4B3C2D");
    expect(parseDarwinPlatformUuid("nothing here")).toBeNull();
  });

  it("reads the Windows MachineGuid from reg query", () => {
    expect(
      parseWindowsMachineGuid(
        "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    8f14e45f-ceea-467f-a9e8-1c4b2e0d9a77\r\n",
      ),
    ).toBe("8f14e45f-ceea-467f-a9e8-1c4b2e0d9a77");
    expect(
      parseWindowsMachineGuid("ERROR: The system was unable to find the specified registry key"),
    ).toBeNull();
  });
});
