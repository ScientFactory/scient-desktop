import type { ChatAttachment, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAssetUrlState } from "../../state/assets";

/** A download fallback, independent of mobile's composer and native preview support. */
export function MessageAttachmentFile({
  environmentId,
  attachment,
}: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatAttachment;
}) {
  const knownFile = attachment.type === "file";
  const asset = useAssetUrlState(
    environmentId,
    knownFile
      ? {
          _tag: "attachment",
          attachmentId: attachment.id,
          fileName: attachment.name,
          mimeType: attachment.mimeType,
        }
      : null,
  );
  const [openFailed, setOpenFailed] = useState(false);
  const loading = knownFile && asset._tag === "Loading";
  const available = knownFile && asset._tag === "Success";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${attachment.name}`}
      accessibilityState={{ disabled: !available, busy: loading }}
      disabled={!available}
      onPress={async () => {
        if (asset._tag === "Success") {
          setOpenFailed(!(await tryOpenExternalUrl(asset.url, "file-preview")));
        }
      }}
      className="mt-1.5 min-h-11 flex-row items-center gap-2 rounded-xl border border-adaptive-neutral-200-a80-white-a8 px-3 py-2"
    >
      {loading ? <ActivityIndicator size="small" /> : null}
      <View className="min-w-0 flex-1">
        <Text numberOfLines={2} className="text-sm">
          {attachment.name}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {!knownFile
            ? "Unsupported attachment"
            : openFailed
              ? "Could not open. Tap to retry."
              : asset._tag === "Failure"
                ? "File unavailable"
                : loading
                  ? "Loading file…"
                  : "Open file"}
        </Text>
      </View>
    </Pressable>
  );
}
