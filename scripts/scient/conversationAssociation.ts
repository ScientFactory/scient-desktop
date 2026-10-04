import {
  CONVERSATION_FILE_TYPE,
  macConversationDocumentTypes,
  macConversationExportedTypes,
  windowsConversationProgId,
} from "../../apps/desktop/scripts/conversation-file-type.mjs";
import {
  WINDOWS_PREVIEW_APP_ID,
  WINDOWS_PREVIEW_CLSIDS,
  WINDOWS_PREVIEW_DLL,
} from "../lib/conversation-preview-build.ts";

export { macConversationDocumentTypes };

// SCIENT-FORK:START — Scient conversation files open with Scient on every
// platform. The extension and media type are the `.scic` contract's
// (SCIC_FILE_EXTENSION, SCIC_MEDIA_TYPE in @t3tools/contracts).
export const DESKTOP_FILE_ASSOCIATIONS = [
  {
    ext: CONVERSATION_FILE_TYPE.extension,
    name: CONVERSATION_FILE_TYPE.name,
    description: CONVERSATION_FILE_TYPE.description,
    mimeType: CONVERSATION_FILE_TYPE.mediaType,
    role: "Viewer",
    icon: "icon.icns",
  },
] as const;
/**
 * macOS type declarations for those files, so Finder and drags recognise a
 * `.scic` as Scient's own zip-based document rather than an unknown file.
 */
export const DESKTOP_MAC_EXPORTED_TYPES = macConversationExportedTypes();

export const WINDOWS_CONVERSATION_ASSOCIATION_INCLUDE = "scient-conversation-association.nsh";

// electron-builder 26's APP_ASSOCIATE writes the .scic extension default on
// every install. Register an owned OpenWith ProgID instead; Windows UserChoice
// and any existing extension default remain the user's decision.
export function renderWindowsConversationAssociationInclude(
  channel: "latest" | "nightly" | "preview",
  nativePreviewEnabled = false,
) {
  const progId = windowsConversationProgId(channel);
  const clsid = WINDOWS_PREVIEW_CLSIDS[channel];
  const previewKey = "{8895b1c6-b41f-4c1c-a562-0d564250836f}";
  return [
    "!macro customInstall",
    `  WriteRegNone SHELL_CONTEXT "Software\\Classes\\.scic\\OpenWithProgids" "${progId}"`,
    `  WriteRegStr SHELL_CONTEXT "Software\\Classes\\${progId}" "" "${CONVERSATION_FILE_TYPE.name}"`,
    `  WriteRegStr SHELL_CONTEXT "Software\\Classes\\${progId}\\DefaultIcon" "" '"$appExe",0'`,
    `  WriteRegStr SHELL_CONTEXT "Software\\Classes\\${progId}\\shell\\open\\command" "" '"$appExe" "%1"'`,
    '  ReadRegStr $R0 SHELL_CONTEXT "Software\\Classes\\.scic" ""',
    '  StrCmp $R0 "Scient Conversation" 0 +2',
    `    WriteRegStr SHELL_CONTEXT "Software\\Classes\\.scic" "" "${progId}"`,
    ...(nativePreviewEnabled
      ? [
          `  WriteRegStr SHELL_CONTEXT "Software\\Classes\\CLSID\\${clsid}" "" "Scient Conversation Preview (${channel})"`,
          `  WriteRegStr SHELL_CONTEXT "Software\\Classes\\CLSID\\${clsid}" "AppID" "${WINDOWS_PREVIEW_APP_ID}"`,
          `  WriteRegStr SHELL_CONTEXT "Software\\Classes\\CLSID\\${clsid}\\InprocServer32" "" "$INSTDIR\\resources\\conversation-preview\\${WINDOWS_PREVIEW_DLL}"`,
          `  WriteRegStr SHELL_CONTEXT "Software\\Classes\\CLSID\\${clsid}\\InprocServer32" "ThreadingModel" "Apartment"`,
          `  WriteRegStr SHELL_CONTEXT "Software\\Classes\\${progId}\\shellex\\${previewKey}" "" "${clsid}"`,
          `  WriteRegStr SHELL_CONTEXT "Software\\Microsoft\\Windows\\CurrentVersion\\PreviewHandlers" "${clsid}" "Scient Conversation Preview (${channel})"`,
        ]
      : []),
    "!macroend",
    "",
    "!macro customUnInstall",
    `  DeleteRegValue SHELL_CONTEXT "Software\\Classes\\.scic\\OpenWithProgids" "${progId}"`,
    '  ReadRegStr $R0 SHELL_CONTEXT "Software\\Classes\\.scic" ""',
    `  StrCmp $R0 "${progId}" 0 +2`,
    '    DeleteRegValue SHELL_CONTEXT "Software\\Classes\\.scic" ""',
    ...(nativePreviewEnabled
      ? [
          `  DeleteRegKey SHELL_CONTEXT "Software\\Classes\\${progId}\\shellex\\${previewKey}"`,
          `  DeleteRegValue SHELL_CONTEXT "Software\\Microsoft\\Windows\\CurrentVersion\\PreviewHandlers" "${clsid}"`,
          `  DeleteRegKey SHELL_CONTEXT "Software\\Classes\\CLSID\\${clsid}"`,
        ]
      : []),
    `  DeleteRegKey SHELL_CONTEXT "Software\\Classes\\${progId}"`,
    "!macroend",
    "",
  ].join("\n");
}
// SCIENT-FORK:END
