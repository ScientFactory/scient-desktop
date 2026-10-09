import type { ChatAttachment } from "@t3tools/contracts";
import type { PiDiscoveredCommands } from "./commands.ts";
import { piRecordField as recordField } from "./rpc.ts";

/** Scient native-input eligibility; callers retain protocol errors and lazy native/FS reads. */
export function piNativeCommandNames(commands: PiDiscoveredCommands): Set<string> {
  return new Set([
    "compact",
    ...commands.slashCommands.map((command) => command.name),
    ...commands.skills.map((skill) => `skill:${skill.name}`),
  ]);
}

export function piNativeCommandWithAttachments(
  userText: string,
  attachments: ReadonlyArray<ChatAttachment>,
  nativeCommandNames: ReadonlySet<string>,
): boolean {
  const command = /^\/([^\s]+)(?:[ \t]|$)/u.exec(userText)?.[1];
  return attachments.length > 0 && command !== undefined && nativeCommandNames.has(command);
}

export function piHasImageAttachments(attachments: ReadonlyArray<ChatAttachment>): boolean {
  return attachments.some((attachment) => attachment.mimeType.startsWith("image/"));
}

export function piModelRefusesImages(state: unknown): boolean {
  const inputs = recordField(recordField(state, "model"), "input");
  return Array.isArray(inputs) && !inputs.includes("image");
}
