// Loaded by the release builder, development launcher, and Linux runtime.
// Keep this free of application and build-time dependencies.
export const CONVERSATION_FILE_TYPE = Object.freeze({
  extension: "scic",
  mediaType: "application/vnd.scient.conversation+zip",
  name: "Scient Conversation",
  description: "Scient conversation",
  linuxMimePackageName: "scient-conversation.xml",
  macUti: "com.scientfactory.scient.conversation",
});

export function macConversationDocumentTypes({ isDevelopment = false } = {}) {
  return [
    {
      CFBundleTypeName: CONVERSATION_FILE_TYPE.name,
      CFBundleTypeExtensions: [CONVERSATION_FILE_TYPE.extension],
      CFBundleTypeRole: "Viewer",
      CFBundleTypeIconFile: "icon.icns",
      LSItemContentTypes: [CONVERSATION_FILE_TYPE.macUti],
      LSHandlerRank: isDevelopment ? "Alternate" : "Default",
    },
  ];
}

export function macConversationExportedTypes() {
  return [
    {
      UTTypeIdentifier: CONVERSATION_FILE_TYPE.macUti,
      UTTypeDescription: CONVERSATION_FILE_TYPE.name,
      UTTypeConformsTo: ["public.zip-archive", "public.data"],
      UTTypeTagSpecification: {
        "public.filename-extension": [CONVERSATION_FILE_TYPE.extension],
        "public.mime-type": [CONVERSATION_FILE_TYPE.mediaType],
      },
    },
  ];
}

export function windowsConversationProgId(channel) {
  if (channel !== "latest" && channel !== "nightly" && channel !== "preview") {
    throw new Error(`Unsupported Windows conversation file channel: ${channel}`);
  }
  if (channel === "nightly") return "Scient.Nightly.Conversation";
  if (channel === "preview") return "Scient.Preview.Conversation";
  return "Scient.Conversation";
}

export function linuxConversationMimeXml() {
  const { extension, mediaType, name } = CONVERSATION_FILE_TYPE;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">',
    `  <mime-type type="${mediaType}">`,
    `    <comment>${name}</comment>`,
    '    <sub-class-of type="application/zip"/>',
    `    <glob pattern="*.${extension}" weight="80"/>`,
    "  </mime-type>",
    "</mime-info>",
    "",
  ].join("\n");
}
