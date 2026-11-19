// @effect-diagnostics nodeBuiltinImport:off -- Reads the checked-in installer include.
import * as NodeFS from "node:fs";
import { assert, describe, it } from "@effect/vitest";

import { installFolderSddl, renderWindowsInstallFolderMacros } from "./installFolderProtection.ts";

// The behavior itself runs on Windows runners: scripts/qualify-windows-install-folder.mjs.
describe("Windows install folder protection", () => {
  const macros = renderWindowsInstallFolderMacros();
  const protect = macros.slice(
    macros.indexOf("Function scientProtectInstallFolder"),
    macros.indexOf("FunctionEnd\n!macroend") + "FunctionEnd".length,
  );
  const order = (...needles: ReadonlyArray<string>) => {
    const positions = needles.map((needle) => protect.indexOf(needle));
    for (const [index, position] of positions.entries())
      assert.isAtLeast(position, 0, `missing ${needles[index]}`);
    assert.deepStrictEqual(
      positions,
      positions.toSorted((a, b) => a - b),
    );
  };

  it("is defined after the template's headers and runs after the running-app check", () => {
    // Top-level LogicLib or ${INSTALL_REGISTRY_KEY} would be compiled before the template
    // includes them; customHeader is expanded after.
    assert.match(
      macros,
      /^!ifndef BUILD_UNINSTALLER\nVar \/GLOBAL scientInstallFolderHandle\n\n!macro customHeader\n!include "getProcessInfo\.nsh"\nVar pid\n/u,
    );
    // The template's own check first: cancelling "close the running app" changes nothing.
    assert.include(
      macros,
      "!macro customCheckAppRunning\n  !insertmacro IS_POWERSHELL_AVAILABLE\n  !insertmacro _CHECK_APP_RUNNING\n  Call scientProtectInstallFolder\n!macroend",
    );
    assert.notInclude(macros, "!macro customInit");
  });

  it("checks the folder and every folder above before changing anything", () => {
    order(
      'SetOutPath "$TEMP"',
      '${If} $installMode == "all"',
      "lstrcpynW(w .R1, p r6, i ${NSIS_MAX_STRLEN})",
      "${GetParent} $3 $3",
      "${If} $4 = -1\n      Goto scientInstallFolderDone",
      "IntOp $4 $4 & 0x400",
      '${AndIf} ${FileExists} "$INSTDIR\\${UNINSTALL_FILENAME}"',
      'GetFileAttributesW(w "$INSTDIR")',
      'CreateFileW(w "$INSTDIR", i 0x70081, i 3, p 0, i 3, i 0x02200000, p 0)',
      "Call scientInstallFolderVerifyHandle",
      "SetKernelObjectSecurity(p r0, i -2147483644, p r6)",
      "System::Call '*$1(i .r7)'",
      "IntOp $7 $7 & 0x4800",
      'PathIsDirectoryEmptyW(w "$INSTDIR")',
      'FindFirstStreamW(w "$INSTDIR", i 0, p r1, i 0) p .r3 ?e',
      "${If} $2 <> 38",
      "SetFileInformationByHandle(p r0, i 4, p r1, i 1)",
      "System::Call '*(i 12, p r6, i 0) p .r1'",
      'CreateDirectoryW(w "$INSTDIR", p r1)',
      "StrCpy $scientInstallFolderHandle $0",
    );
    // A folder reached through a link after creating is released, never deleted: the handle
    // may name one this run did not create.
    const created = protect.slice(protect.indexOf("CreateDirectoryW"));
    assert.notInclude(created, "SetFileInformationByHandle");
    // The same list for the previous install and for a folder created anew.
    assert.equal(protect.split(`w "${installFolderSddl("$R1")}"`).length - 1, 2);
    // An empty folder is removed only through the handle that was checked, never by path.
    assert.notInclude(macros, "RemoveDirectoryW");
    // Locale-aware comparison can equate different names.
    assert.notMatch(protect, /\$8 [!=]=/u);
    // Fixed-length reads of a returned string can fault past its allocation.
    assert.notMatch(macros, /\(&w/u);
    // Permissions change only by creation or through the handle, never by path.
    assert.notMatch(macros, /icacls|SetNamedSecurityInfo|SetFileSecurity|powershell\.exe/iu);
    assert.notMatch(macros, /\b(?:Quit|Abort)\b/u);
  });

  it("accepts only a directory, not a link, owned by the user, Administrators or SYSTEM", () => {
    const verify = macros.slice(
      macros.indexOf("Function scientInstallFolderVerifyHandle"),
      macros.indexOf("Function scientProtectInstallFolder"),
    );
    for (const needle of [
      "GetFileInformationByHandle(p r0, p r1)",
      "IntOp $3 $3 & 0x410",
      "${AndIf} $3 = 0x10",
      "GetSecurityInfo(p r0, i 1, i 1, *p .r6, p 0, p 0, p 0, *p .r7)",
      "EqualSid(p r6, p r5)",
      "IsWellKnownSid(p r6, i 26)",
      "IsWellKnownSid(p r6, i 22)",
      "GetFinalPathNameByHandleW(p r0, w .r8, i ${NSIS_MAX_STRLEN}, i 0)",
      "${AndIf} $2 < ${NSIS_MAX_STRLEN}",
      'CompareStringOrdinal(w r8, i -1, w "\\\\?\\$INSTDIR", i -1, i 0)',
      "${If} $2 = 2",
    ])
      assert.include(verify, needle);
  });

  it("keeps every register it uses", () => {
    const lines = protect.trimEnd().split("\n").slice(1, -1);
    const pushed = lines
      .slice(
        0,
        lines.findIndex((line) => !line.startsWith("  Push ")),
      )
      .map((line) => line.slice("  Push ".length));
    const popped = lines
      .slice(lines.findLastIndex((line) => !line.startsWith("  Pop ")) + 1)
      .map((line) => line.slice("  Pop ".length));
    assert.deepStrictEqual(popped, pushed.toReversed());
    for (const used of new Set(protect.match(/\$R?\d\b/gu)))
      assert.include(pushed, used, `${used} is not saved`);
  });

  it("is the only customHeader and customCheckAppRunning, and customInstall releases the handle", () => {
    assert.match(macros, /\n!endif\n$/u);
    const installer = NodeFS.readFileSync(
      new URL("../../apps/desktop/resources/installer.nsh", import.meta.url),
      "utf8",
    );
    assert.notMatch(installer, /!macro (?:customHeader|customCheckAppRunning)\b/u);
    assert.include(installer, "!insertmacro scientInstallFolderInstall");
  });

  it("grants only the principals the app's permission check trusts", () => {
    assert.equal(
      installFolderSddl("S-1-5-21-1-2-3-1001"),
      "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;S-1-5-21-1-2-3-1001)",
    );
  });
});
