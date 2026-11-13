import { describe, expect, it } from "vite-plus/test";

import {
  fileRights,
  parseSecurityDescriptor,
  securityDescriptorRefusal,
} from "./windowsSecurityDescriptor.ts";

const HELPER = 0xd0156;
const ANCESTOR = 0xd0040;
const USER_SID = "S-1-5-21-1004336348-1177238915-682003330-1001";
const USER = { sid: USER_SID, local: true };
const TI = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const owned = (owner: string, dacl: string) => `O:${owner}G:${owner}D:${dacl}`;
const writable = "Native resource is writable by another principal.";

// Descriptors as a stock Windows 11 install reports them (`(Get-Acl <path>).Sddl`).
const PROGRAM_FILES = `O:${TI}G:${TI}D:PAI(A;;FA;;;${TI})(A;CIIO;GA;;;${TI})(A;;0x1301bf;;;SY)(A;OICIIO;GA;;;SY)(A;;0x1301bf;;;BA)(A;OICIIO;GA;;;BA)(A;;0x1200a9;;;BU)(A;OICIIO;GXGR;;;BU)(A;OICIIO;GA;;;CO)(A;;0x1200a9;;;AC)(A;OICIIO;GXGR;;;AC)(A;;0x1200a9;;;S-1-15-2-2)(A;OICIIO;GXGR;;;S-1-15-2-2)`;
const INSTALLED = `O:BAG:SYD:AI(A;ID;FA;;;${TI})(A;CIIOID;GA;;;${TI})(A;ID;FA;;;SY)(A;OICIIOID;GA;;;SY)(A;ID;FA;;;BA)(A;OICIIOID;GA;;;BA)(A;ID;0x1200a9;;;BU)(A;OICIIOID;GXGR;;;BU)(A;OICIIOID;GA;;;CO)(A;ID;0x1200a9;;;AC)(A;OICIIOID;GXGR;;;AC)(A;ID;0x1200a9;;;S-1-15-2-2)(A;OICIIOID;GXGR;;;S-1-15-2-2)`;
const USERS = `O:SYG:SYD:PAI(A;OICIIO;GA;;;CO)(A;OICIIO;GA;;;SY)(A;;0x1301bf;;;SY)(A;OICIIO;GA;;;BA)(A;;0x1301bf;;;BA)(A;OICIIO;GXGR;;;BU)(A;;0x1200a9;;;BU)(A;CIIO;GXGR;;;WD)(A;;0x1200a9;;;WD)`;
const PROFILE = `O:${USER_SID}G:${USER_SID}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER_SID})`;
const LOCAL_PROGRAMS = `O:${USER_SID}G:S-1-5-21-1004336348-1177238915-682003330-513D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER_SID})`;
const DRIVE = `O:${TI}G:${TI}D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)(A;OICIIO;SDGXGWGR;;;AU)(A;;LC;;;AU)`;
// A folder made directly under C:\ inherits Authenticated Users: Modify.
const UNDER_DRIVE = `O:${USER_SID}G:${USER_SID}D:AI(A;ID;FA;;;BA)(A;OICIIOID;FA;;;BA)(A;ID;FA;;;SY)(A;OICIIOID;FA;;;SY)(A;ID;0x1200a9;;;BU)(A;OICIIOID;GXGR;;;BU)(A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)`;
// `icacls <folder> /grant Everyone:(OI)(CI)M` on the helper's folder.
const WEAKENED = `${LOCAL_PROGRAMS}(A;OICI;0x1301bf;;;WD)`;

describe("a Windows security descriptor", () => {
  it.each([
    ["Program Files", PROGRAM_FILES, HELPER],
    ["a folder installed under Program Files", INSTALLED, HELPER],
    ["C:\\Users", USERS, ANCESTOR],
    ["the user's profile", PROFILE, HELPER],
    ["%LOCALAPPDATA%\\Programs", LOCAL_PROGRAMS, HELPER],
    ["the drive's root", DRIVE, ANCESTOR],
  ])("admits %s", (_name, sddl, mask) => {
    expect(securityDescriptorRefusal(sddl, mask, USER)).toBeUndefined();
  });

  it("refuses a folder that grants Everyone write, or one under C:\\ that inherits Modify", () => {
    expect(securityDescriptorRefusal(WEAKENED, HELPER, USER)).toBe(writable);
    expect(securityDescriptorRefusal(UNDER_DRIVE, HELPER, USER)).toBe(writable);
  });

  it("lets others add to a folder above, but never delete from it", () => {
    const adding = owned("SY", "(A;;0x6;;;WD)");
    expect(securityDescriptorRefusal(adding, ANCESTOR, USER)).toBeUndefined();
    expect(securityDescriptorRefusal(adding, HELPER, USER)).toBe(writable);
    expect(securityDescriptorRefusal(owned("SY", "(A;;DT;;;WD)"), ANCESTOR, USER)).toBe(writable);
  });

  it("counts an inherit-only grant only where it is inherited", () => {
    expect(
      securityDescriptorRefusal(owned("SY", "(A;OICIIO;GA;;;WD)"), HELPER, USER),
    ).toBeUndefined();
    expect(securityDescriptorRefusal(owned("SY", "(A;OICIID;GA;;;WD)"), HELPER, USER)).toBe(
      writable,
    );
  });

  it("maps generic rights to what they mean for a file", () => {
    expect(fileRights(0x10000000)).toBe(0x1f01ff);
    expect(fileRights(0x80000000)).toBe(0x120089);
    expect(fileRights(0x40000000)).toBe(0x120116);
    expect(fileRights(0x20000000)).toBe(0x1200a0);
    expect(securityDescriptorRefusal(owned("SY", "(A;;GW;;;WD)"), HELPER, USER)).toBe(writable);
    expect(securityDescriptorRefusal(owned("SY", "(A;;GA;;;BU)"), ANCESTOR, USER)).toBe(writable);
    expect(securityDescriptorRefusal(owned("SY", "(A;;GRGX;;;WD)"), HELPER, USER)).toBeUndefined();
    expect(securityDescriptorRefusal(owned("SY", "(A;;0x40000000;;;WD)"), HELPER, USER)).toBe(
      writable,
    );
  });

  it.each([
    ["CC", 0x1],
    ["DC", 0x2],
    ["LC", 0x4],
    ["SW", 0x8],
    ["RP", 0x10],
    ["WP", 0x20],
    ["DT", 0x40],
    ["LO", 0x80],
    ["CR", 0x100],
    ["SD", 0x10000],
    ["RC", 0x20000],
    ["WD", 0x40000],
    ["WO", 0x80000],
    ["FA", 0x1f01ff],
    ["FR", 0x120089],
    ["FW", 0x120116],
    ["FX", 0x1200a0],
    ["KA", 0xf003f],
    ["KR", 0x20019],
    ["KW", 0x20006],
    ["KX", 0x20019],
    ["NW", 0x1],
    ["NR", 0x2],
    ["NX", 0x4],
    ["GA", 0x10000000],
    ["GX", 0x20000000],
    ["GW", 0x40000000],
    ["GR", 0x80000000],
    ["0x1301bf", 0x1301bf],
    ["CCDCLCSWRPWPDTLOCRSDRCWDWO", 0xf01ff],
  ])("reads the rights %s as their exact value", (rights, value) => {
    expect(parseSecurityDescriptor(owned("SY", `(A;;${rights};;;WD)`)).dacl![0]!.rights).toBe(
      value,
    );
  });

  it.each([
    ["the user", USER_SID, true],
    ["SYSTEM", "SY", true],
    ["Administrators", "BA", true],
    ["TrustedInstaller", TI, true],
    ["Everyone", "WD", false],
    ["Users", "BU", false],
    ["Authenticated Users", "AU", false],
    ["another user", "S-1-5-21-1004336348-1177238915-682003330-1002", false],
    ["Domain Admins", "DA", false],
    ["the machine's Administrator, when the user is another account", "LA", false],
  ])("admits %s as owner only if trusted", (_name, owner, trusted) => {
    expect(securityDescriptorRefusal(owned(owner, "(A;;FA;;;SY)"), HELPER, USER)).toBe(
      trusted ? undefined : "Unexpected native resource owner.",
    );
  });

  it("treats the machine's Administrator or Guest as the user only when the user is that local account", () => {
    const administrator = { sid: "S-1-5-21-1004336348-1177238915-682003330-500", local: true };
    const profile = owned("BA", "(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)");
    expect(securityDescriptorRefusal(profile, HELPER, administrator)).toBeUndefined();
    expect(securityDescriptorRefusal(profile, HELPER, USER)).toBe(writable);
    // A domain account with the same RID is someone else: LA and LG are the machine's own.
    expect(securityDescriptorRefusal(profile, HELPER, { ...administrator, local: false })).toBe(
      writable,
    );
    const domainGuest = { sid: "S-1-5-21-111-222-333-501", local: false };
    expect(securityDescriptorRefusal("O:SYD:(A;;FA;;;LG)", HELPER, domainGuest)).toBe(writable);
  });

  it("never counts a grant to Creator Owner or Owner Rights as the user's", () => {
    expect(securityDescriptorRefusal(owned("SY", "(A;;FA;;;CO)"), HELPER, USER)).toBe(writable);
    expect(securityDescriptorRefusal(owned("SY", "(A;;FA;;;OW)"), HELPER, USER)).toBe(writable);
  });

  it("never lets a deny offset a grant, and counts conditional and object grants", () => {
    expect(securityDescriptorRefusal(owned("SY", "(D;;FA;;;WD)"), HELPER, USER)).toBeUndefined();
    expect(securityDescriptorRefusal(owned("SY", "(D;;FA;;;WD)(A;;FA;;;WD)"), HELPER, USER)).toBe(
      writable,
    );
    expect(
      securityDescriptorRefusal(owned("SY", '(XD;;FA;;;WD;(@User.Title == "a(b"))'), HELPER, USER),
    ).toBeUndefined();
    expect(
      securityDescriptorRefusal(owned("SY", '(XA;;FA;;;WD;(@User.Title == "a)b"))'), HELPER, USER),
    ).toBe(writable);
    expect(
      securityDescriptorRefusal(
        owned("SY", "(OA;;RPWP;bf967aba-0de6-11d0-a285-00aa003049e2;;WD)"),
        HELPER,
        USER,
      ),
    ).toBe(writable);
  });

  it("reads a SACL without counting it", () => {
    expect(securityDescriptorRefusal(`${PROFILE}S:(ML;;NW;;;HI)`, HELPER, USER)).toBeUndefined();
  });

  it.each([
    ["an empty descriptor", ""],
    ["no owner", "G:SYD:(A;;FA;;;SY)"],
    ["no DACL", "O:SYG:SY"],
    ["a NULL DACL", "O:SYG:SYD:NO_ACCESS_CONTROL"],
    ["an unknown account alias, even with no write right", "O:SYG:SYD:(A;;FR;;;ZZ)"],
    ["an unknown account alias in a deny", "O:SYG:SYD:(D;;FA;;;ZZ)"],
    ["an unknown group alias", "O:SYG:ZZD:(A;;FA;;;SY)"],
    ["an unknown rights token", "O:SYG:SYD:(A;;ZZ;;;SY)"],
    ["a malformed rights mask", "O:SYG:SYD:(A;;0xZZ;;;SY)"],
    ["decimal rights", "O:SYG:SYD:(A;;1245631;;;SY)"],
    ["an unknown ACE flag", "O:SYG:SYD:(A;QQ;FA;;;SY)"],
    ["an unknown ACE type", "O:SYG:SYD:(Q;;FA;;;SY)"],
    ["an audit ACE in the DACL", "O:SYG:SYD:(AU;SA;FA;;;WD)"],
    [
      "an object type on an ordinary ACE",
      "O:SYG:SYD:(A;;FA;bf967aba-0de6-11d0-a285-00aa003049e2;;SY)",
    ],
    ["a condition on an ordinary ACE", "O:SYG:SYD:(A;;FA;;;SY;(x))"],
    ["an unclosed ACE", "O:SYG:SYD:(A;;FA;;;SY"],
    ["a short ACE", "O:SYG:SYD:(A;;FA)"],
    ["a malformed SID", "O:S-1-5-x-18G:SYD:(A;;FA;;;SY)"],
    ["text after the ACEs", "O:SYG:SYD:(A;;FA;;;SY)junk"],
    ["a repeated owner", "O:SYO:WDG:SYD:(A;;FA;;;SY)"],
  ])("refuses %s", (_name, sddl) => {
    expect(securityDescriptorRefusal(sddl, HELPER, USER)).not.toBeUndefined();
  });
});
