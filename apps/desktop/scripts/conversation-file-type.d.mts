export const CONVERSATION_FILE_TYPE: Readonly<{
  extension: "scic";
  mediaType: "application/vnd.scient.conversation+zip";
  name: "Scient Conversation";
  description: "Scient conversation";
  linuxMimePackageName: "scient-conversation.xml";
  macUti: "com.scientfactory.scient.conversation";
}>;

export function macConversationDocumentTypes(options?: { isDevelopment?: boolean }): Array<{
  CFBundleTypeName: string;
  CFBundleTypeExtensions: string[];
  CFBundleTypeRole: string;
  CFBundleTypeIconFile: string;
  LSItemContentTypes: string[];
  LSHandlerRank: "Alternate" | "Default";
}>;
export function macConversationExportedTypes(): Array<{
  UTTypeIdentifier: string;
  UTTypeDescription: string;
  UTTypeConformsTo: string[];
  UTTypeTagSpecification: Record<string, string[]>;
}>;
export function windowsConversationProgId(channel: "latest" | "nightly" | "preview"): string;
export function linuxConversationMimeXml(): string;
