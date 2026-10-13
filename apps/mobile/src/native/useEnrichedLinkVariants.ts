import { useMemo } from "react";
// SCIENT-FORK:START — authored descriptions belong to each link occurrence.
import { isMarkdownFileLinkLabel } from "@t3tools/shared/markdownLinks";
// SCIENT-FORK:END
import { Image } from "react-native";
import type {
  LinkPillContent,
  MarkdownDocumentAsset,
  MarkdownStyle,
} from "react-native-enriched-markdown";
import { markdownFileIconSource } from "../lib/markdownFileIcons";
import { markdownLinkIconSource } from "../lib/markdownLinkIcons";
import { resolveMarkdownLinkIcon, resolveMarkdownLinkPresentation } from "../lib/markdownLinks";
import type { SelectableMarkdownTextProps } from "./SelectableMarkdownText.types";
import {
  enrichedContextLinkPresentation,
  enrichedLinkVariantPattern,
  enrichedSkillDisplayName,
  enrichedSkillReference,
} from "../lib/enrichedLinkPresentation";

function presentation(
  url: string,
  props: Pick<SelectableMarkdownTextProps, "linkCustomization" | "skills" | "textStyle">,
) {
  const custom = props.linkCustomization?.(url);
  if (custom) return custom;
  const context = enrichedContextLinkPresentation(url);
  if (context) return { color: context.color, icon: markdownFileIconSource(context.icon) };
  const skill = enrichedSkillReference(url, props.skills);
  if (skill)
    return {
      color: props.textStyle.skillTextColor,
      label: enrichedSkillDisplayName(skill),
      icon: markdownFileIconSource("mcp"),
    };
  const link = resolveMarkdownLinkPresentation(url);
  if (link.kind === "file")
    return {
      color: props.textStyle.fileTextColor,
      label: link.label,
      icon: markdownFileIconSource(link.icon),
    };
  const icon = link.kind === "external" ? resolveMarkdownLinkIcon(link.host) : null;
  return icon
    ? {
        color: props.textStyle.linkColor,
        icon: markdownLinkIconSource(icon),
        iconTintColor: props.textStyle.linkColor,
      }
    : undefined;
}

export function useEnrichedLinkVariants(
  assets: ReadonlyArray<MarkdownDocumentAsset>,
  props: SelectableMarkdownTextProps,
) {
  const { linkCustomization, skills, textStyle } = props;
  const links = useMemo(() => {
    const byUrl = new Map<
      string,
      NonNullable<ReturnType<typeof presentation>> & {
        preserveAuthoredContent?: boolean;
      }
    >();
    for (const asset of assets) {
      if (asset.kind !== "link" || byUrl.has(asset.url)) continue;
      const value = presentation(asset.url, { linkCustomization, skills, textStyle });
      // SCIENT-FORK:START — a URL-wide pill label must not overwrite distinct descriptions.
      const hasAuthoredDescription =
        resolveMarkdownLinkPresentation(asset.url).kind === "file" &&
        assets.some(
          (candidate) =>
            candidate.kind === "link" &&
            candidate.url === asset.url &&
            !isMarkdownFileLinkLabel(candidate.altText, candidate.url),
        );
      if (value)
        byUrl.set(
          asset.url,
          hasAuthoredDescription
            ? { ...value, label: undefined, preserveAuthoredContent: true }
            : value,
        );
      // SCIENT-FORK:END
    }
    return byUrl;
  }, [assets, linkCustomization, skills, textStyle]);
  const linkVariants = useMemo<MarkdownStyle["linkVariants"]>(
    () =>
      Object.fromEntries(
        [...links]
          .filter(([, link]) => !link.preserveAuthoredContent)
          .map(([url, link]) => {
            const color = link.color ?? textStyle.fileTextColor;
            return [
              enrichedLinkVariantPattern(url),
              {
                pill: {
                  borderColor: "transparent",
                  borderWidth: 0,
                  borderRadius: 6,
                  paddingHorizontal: 5,
                  paddingVertical: 2,
                },
                fontFamily: textStyle.fontFamily,
                color,
                underline: false,
                backgroundColor: "transparent",
              },
            ];
          }),
      ),
    [links, textStyle],
  );
  const linkPillContent = useMemo<Record<string, LinkPillContent>>(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => [
          url,
          {
            label: link.label,
            iconUri: link.icon ? Image.resolveAssetSource(link.icon)?.uri : undefined,
            iconTintColor: link.iconTintColor,
          },
        ]),
      ),
    [links],
  );
  return { linkVariants, linkPillContent };
}
