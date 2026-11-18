// SCIENT-FORK:START — the Windows installer protects the folder it installs into.
// In a folder other accounts may add files to, a planted DLL could join the app and the
// publication helper refuses itself, so the folder gets the user, SYSTEM and Administrators
// only, before the app's files are copied (docs/internals/scient-overleaf-engine.md).

/** SDDL for the protected access list; every installed file inherits it. */
export const installFolderSddl = (userSid: string) =>
  `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${userSid})`;

/**
 * NSIS for the installer. `customHeader` defines the function after the template's headers;
 * `customCheckAppRunning` runs the template's own running-app check, then the function, before
 * the old version is uninstalled or files are copied; `customInstall` releases the handle.
 */
export function renderWindowsInstallFolderMacros() {
  // CreateFileW: READ_CONTROL | WRITE_DAC | DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
  // read and write sharing only, OPEN_EXISTING, BACKUP_SEMANTICS | OPEN_REPARSE_POINT.
  const openFolder = [
    `  System::Call 'kernel32::CreateFileW(w "$INSTDIR", i 0x70081, i 3, p 0, i 3, i 0x02200000, p 0) p .r0'`,
    "  ${If} $0 = -1",
    "    Goto scientInstallFolderDone",
    "  ${EndIf}",
    "  Call scientInstallFolderVerifyHandle",
    "  Pop $3",
    "  ${If} $3 = 0",
    "    Goto scientInstallFolderRelease",
    "  ${EndIf}",
  ];
  const sddl = installFolderSddl("$R1");
  const registers = ["$0", "$1", "$2", "$3", "$4", "$5", "$6", "$7", "$8", "$9", "$R0", "$R1"];
  return [
    "!ifndef BUILD_UNINSTALLER",
    "Var /GLOBAL scientInstallFolderHandle",
    "",
    // Defining customCheckAppRunning keeps the template from including these itself.
    "!macro customHeader",
    '!include "getProcessInfo.nsh"',
    "Var pid",
    "",
    // With $0 a handle to the install folder and $5 the user's SID: pushes 1 when it is a
    // directory, not a link, owned by the user, Administrators (26) or SYSTEM (22), and
    // reached by $INSTDIR itself: its real path shows no link on the way.
    "Function scientInstallFolderVerifyHandle",
    "  Push $1",
    "  Push $2",
    "  Push $3",
    "  Push $4",
    "  Push $6",
    "  Push $7",
    "  Push $8",
    "  StrCpy $4 0",
    "  System::Call '*(&i52) p .r1'",
    "  System::Call 'kernel32::GetFileInformationByHandle(p r0, p r1) i .r2'",
    "  System::Call '*$1(i .r3)'",
    "  System::Free $1",
    "  IntOp $3 $3 & 0x410",
    "  ${If} $2 <> 0",
    "  ${AndIf} $3 = 0x10",
    "    System::Call 'advapi32::GetSecurityInfo(p r0, i 1, i 1, *p .r6, p 0, p 0, p 0, *p .r7) i .r2'",
    "    ${If} $2 = 0",
    "      System::Call 'advapi32::EqualSid(p r6, p r5) i .r2'",
    "      System::Call 'advapi32::IsWellKnownSid(p r6, i 26) i .r3'",
    "      IntOp $4 $2 | $3",
    "      System::Call 'advapi32::IsWellKnownSid(p r6, i 22) i .r3'",
    "      IntOp $4 $4 | $3",
    "      System::Call 'kernel32::LocalFree(p r7)'",
    "    ${EndIf}",
    "  ${EndIf}",
    "  ${If} $4 <> 0",
    "    System::Call 'kernel32::GetFinalPathNameByHandleW(p r0, w .r8, i ${NSIS_MAX_STRLEN}, i 0) i .r2'",
    "    StrCpy $4 0",
    "    ${If} $2 > 0",
    "    ${AndIf} $2 < ${NSIS_MAX_STRLEN}",
    // Ordinal and exact (CSTR_EQUAL = 2): a different spelling only skips the protection.
    "      System::Call 'kernel32::CompareStringOrdinal(w r8, i -1, w \"\\\\?\\$INSTDIR\", i -1, i 0) i .r2'",
    "      ${If} $2 = 2",
    "        StrCpy $4 1",
    "      ${EndIf}",
    "    ${EndIf}",
    "  ${EndIf}",
    "  StrCpy $1 $4",
    "  Pop $8",
    "  Pop $7",
    "  Pop $6",
    "  Pop $4",
    "  Pop $3",
    "  Pop $2",
    "  Exch $1",
    "FunctionEnd",
    "",
    // Takes the install folder only when it is this app's previous install, or a missing or
    // empty folder, which it recreates already protected. Anything else keeps its permissions.
    "Function scientProtectInstallFolder",
    ...registers.map((register) => `  Push ${register}`),
    "  StrCpy $scientInstallFolderHandle -1",
    "  StrCpy $0 -1",
    "  StrCpy $9 0",
    // .onInit made the folder the current directory, whose handle would block removing it;
    // the install section sets the output folder again before copying.
    '  SetOutPath "$TEMP"',
    // A machine-wide install keeps its inherited permissions, which let every user run it.
    '  ${If} $installMode == "all"',
    "    Goto scientInstallFolderDone",
    "  ${EndIf}",
    // The installing user's SID (TOKEN_USER): $5 points into the token buffer $9, $R1 is text.
    '  StrCpy $R1 ""',
    "  System::Call 'advapi32::OpenProcessToken(p -1, i 8, *p .r7) i .r2'",
    "  ${If} $2 = 0",
    "    Goto scientInstallFolderDone",
    "  ${EndIf}",
    "  StrCpy $8 0",
    "  System::Call 'advapi32::GetTokenInformation(p r7, i 1, p 0, i 0, *i .r8)'",
    "  System::Alloc $8",
    "  Pop $9",
    "  System::Call 'advapi32::GetTokenInformation(p r7, i 1, p r9, i r8, *i .r8) i .r2'",
    "  System::Call 'kernel32::CloseHandle(p r7)'",
    "  ${If} $2 = 0",
    "    Goto scientInstallFolderDone",
    "  ${EndIf}",
    "  System::Call '*$9(p .r5)'",
    "  System::Call 'advapi32::ConvertSidToStringSidW(p r5, *p .r6) i .r2'",
    "  ${If} $2 = 0",
    "    Goto scientInstallFolderDone",
    "  ${EndIf}",
    "  System::Call 'kernel32::lstrcpynW(w .R1, p r6, i ${NSIS_MAX_STRLEN})'",
    "  System::Call 'kernel32::LocalFree(p r6)'",
    '  ${If} $R1 == ""',
    "    Goto scientInstallFolderDone",
    "  ${EndIf}",
    // No link above it, nor one that cannot be read: the folder is created by name.
    "  StrCpy $3 $INSTDIR",
    "  ${Do}",
    "    ${GetParent} $3 $3",
    '    ${If} $3 == ""',
    "      ${Break}",
    "    ${EndIf}",
    '    StrCpy $4 "$3\\"',
    "    System::Call 'kernel32::GetFileAttributesW(w r4) i .r4'",
    "    ${If} $4 = -1",
    "      Goto scientInstallFolderDone",
    "    ${EndIf}",
    "    IntOp $4 $4 & 0x400",
    "    ${If} $4 <> 0",
    "      Goto scientInstallFolderDone",
    "    ${EndIf}",
    "  ${Loop}",
    // This app's previous install: registered here, with its uninstaller, which moves the old
    // files out. $4 = 1 when the folder is instead to be created already protected.
    "  StrCpy $R0 0",
    '  ReadRegStr $3 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation',
    "  ${If} $3 == $INSTDIR",
    '  ${AndIf} ${FileExists} "$INSTDIR\\${UNINSTALL_FILENAME}"',
    "    StrCpy $R0 1",
    "  ${EndIf}",
    "  StrCpy $4 1",
    "  System::Call 'kernel32::GetFileAttributesW(w \"$INSTDIR\") i .r3'",
    "  ${If} $3 <> -1",
    // From here on only through this handle to the folder itself.
    ...openFolder.map((line) => `  ${line}`),
    "    ${If} $R0 = 1",
    // Replace the access list in one operation, without propagating to the old files.
    `      System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "${sddl}", i 1, *p .r6, p 0) i .r2'`,
    "      ${If} $2 = 0",
    "        Goto scientInstallFolderRelease",
    "      ${EndIf}",
    // DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION (0x80000004).
    "      System::Call 'advapi32::SetKernelObjectSecurity(p r0, i -2147483644, p r6) i .r2'",
    "      System::Call 'kernel32::LocalFree(p r6)'",
    "      ${If} $2 = 0",
    "        Goto scientInstallFolderRelease",
    "      ${EndIf}",
    "      StrCpy $4 0",
    "    ${Else}",
    // Otherwise only an empty folder (an error counts as not empty), neither encrypted nor
    // compressed and with no named streams, removed through the checked handle: a new one
    // would lose those, so anything else stays as it is.
    "      System::Call '*(&i52) p .r1'",
    "      System::Call 'kernel32::GetFileInformationByHandle(p r0, p r1) i .r2'",
    "      System::Call '*$1(i .r7)'",
    "      System::Free $1",
    // FILE_ATTRIBUTE_ENCRYPTED | FILE_ATTRIBUTE_COMPRESSED.
    "      IntOp $7 $7 & 0x4800",
    "      ${If} $2 = 0",
    "      ${OrIf} $7 <> 0",
    "        Goto scientInstallFolderRelease",
    "      ${EndIf}",
    "      System::Call 'shlwapi::PathIsDirectoryEmptyW(w \"$INSTDIR\") i .r3'",
    "      ${If} $3 = 0",
    "        Goto scientInstallFolderRelease",
    "      ${EndIf}",
    "      System::Call '*(&i600) p .r1'",
    "      System::Call 'kernel32::FindFirstStreamW(w \"$INSTDIR\", i 0, p r1, i 0) p .r3 ?e'",
    "      Pop $2",
    "      System::Free $1",
    "      ${If} $3 <> -1",
    "        System::Call 'kernel32::FindClose(p r3)'",
    "        Goto scientInstallFolderRelease",
    "      ${EndIf}",
    // Only ERROR_HANDLE_EOF (38) means no streams; any other failure leaves the folder.
    "      ${If} $2 <> 38",
    "        Goto scientInstallFolderRelease",
    "      ${EndIf}",
    // FILE_DISPOSITION_INFO { DeleteFile = TRUE } (FileDispositionInfo = 4): gone on close.
    "      System::Call '*(&i1 1) p .r1'",
    "      System::Call 'kernel32::SetFileInformationByHandle(p r0, i 4, p r1, i 1) i .r2'",
    "      System::Free $1",
    "      System::Call 'kernel32::CloseHandle(p r0)'",
    "      StrCpy $0 -1",
    "      ${If} $2 = 0",
    "        Goto scientInstallFolderDone",
    "      ${EndIf}",
    "    ${EndIf}",
    "  ${EndIf}",
    // Created already protected, so nothing can be added to it or opened in it first. If
    // another account takes the name in between, creating fails and the folder is theirs.
    "  ${If} $4 = 1",
    `    System::Call 'advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(w "${sddl}", i 1, *p .r6, p 0) i .r2'`,
    "    ${If} $2 = 0",
    "      Goto scientInstallFolderDone",
    "    ${EndIf}",
    // SECURITY_ATTRIBUTES { nLength, lpSecurityDescriptor, bInheritHandle } (32-bit installer).
    "    System::Call '*(i 12, p r6, i 0) p .r1'",
    "    System::Call 'kernel32::CreateDirectoryW(w \"$INSTDIR\", p r1) i .r2'",
    "    System::Free $1",
    "    System::Call 'kernel32::LocalFree(p r6)'",
    "    ${If} $2 = 0",
    "      Goto scientInstallFolderDone",
    "    ${EndIf}",
    `  ${openFolder[0]}`,
    "    ${If} $0 = -1",
    "      Goto scientInstallFolderDone",
    "    ${EndIf}",
    "    Call scientInstallFolderVerifyHandle",
    "    Pop $3",
    // Reached through a link after all: released, never deleted, since this handle may name a
    // folder this run did not create.
    "    ${If} $3 = 0",
    "      Goto scientInstallFolderRelease",
    "    ${EndIf}",
    "  ${EndIf}",
    // Held without delete sharing until the files are copied: the folder cannot be removed or
    // renamed meanwhile, so the old uninstaller empties it instead of recreating it.
    "  StrCpy $scientInstallFolderHandle $0",
    "  Goto scientInstallFolderDone",
    "  scientInstallFolderRelease:",
    "  System::Call 'kernel32::CloseHandle(p r0)'",
    "  scientInstallFolderDone:",
    "  ${If} $9 <> 0",
    "    System::Free $9",
    "  ${EndIf}",
    ...[...registers].reverse().map((register) => `  Pop ${register}`),
    "FunctionEnd",
    "!macroend",
    "",
    // After the user agreed to close a running app, so cancelling that changes nothing.
    "!macro customCheckAppRunning",
    "  !insertmacro IS_POWERSHELL_AVAILABLE",
    "  !insertmacro _CHECK_APP_RUNNING",
    "  Call scientProtectInstallFolder",
    "!macroend",
    "",
    "!macro scientInstallFolderInstall",
    "  ${If} $scientInstallFolderHandle != -1",
    '  ${AndIf} $scientInstallFolderHandle != ""',
    "    System::Call 'kernel32::CloseHandle(p $scientInstallFolderHandle)'",
    "    StrCpy $scientInstallFolderHandle -1",
    "  ${EndIf}",
    "!macroend",
    "!endif",
    "",
  ].join("\n");
}
// SCIENT-FORK:END
