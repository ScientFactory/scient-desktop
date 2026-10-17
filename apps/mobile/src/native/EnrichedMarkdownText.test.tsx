// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ComponentProps } from "react";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import { ComposerContextId, EnvironmentId } from "@t3tools/contracts";

const harness = vi.hoisted(() => ({
  props: null as ComponentProps<
    typeof import("react-native-enriched-markdown").EnrichedMarkdownText
  > | null,
}));
vi.mock("react-native-enriched-markdown", () => ({
  EnrichedMarkdownText: (props: NonNullable<typeof harness.props>) => {
    harness.props = props;
    return null;
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  StyleSheet: { hairlineWidth: 1 },
  View: "div",
  Image: { resolveAssetSource: () => ({ uri: "test-icon" }) },
  ActionSheetIOS: {},
  Share: {},
}));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("../components/AndroidAnchoredMenu", () => ({ AndroidAnchoredMenu: "div" }));
vi.mock("../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("../lib/markdownFileIcons", () => ({
  markdownFileIconSource: () => ({ uri: "test-icon" }),
}));
vi.mock("../lib/markdownLinkIcons", () => ({
  markdownLinkIconSource: () => ({ uri: "test-icon" }),
}));

import { MobileEnrichedMarkdownText } from "./EnrichedMarkdownText";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const textStyle = {
  color: "#222",
  strongColor: "#111",
  mutedColor: "#555",
  linkColor: "#00f",
  inlineCodeColor: "#444",
  codeColor: "#222",
  codeBackgroundColor: "#eee",
  codeBlockBackgroundColor: "#eee",
  fileTextColor: "#222",
  skillTextColor: "#950",
  quoteMarkerColor: "#555",
  dividerColor: "#ccc",
  fontSize: 16,
  lineHeight: 24,
  fontFamily: "body",
  headingFontFamily: "heading",
  boldFontFamily: "bold",
};
function render(props: Omit<ComponentProps<typeof MobileEnrichedMarkdownText>, "textStyle">) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root!.render(<MobileEnrichedMarkdownText {...props} textStyle={textStyle} />));
  return harness.props!;
}
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  harness.props = null;
  vi.unstubAllGlobals();
});

describe("live Enriched native adapter", () => {
  it("keeps exact thread-link event destinations and native authored soft-break semantics", () => {
    const onLinkPress = vi.fn();
    const markdown = "first\nsecond  \nthird\n\n> quoted\n\n```text\nsource\n```";
    const props = render({ markdown, preserveSoftBreaks: true, onLinkPress });
    expect(props.markdown).toBe(markdown);
    expect(props.md4cFlags).toMatchObject({ hardSoftBreaks: true, latexMath: false });
    for (const url of ["t3-thread://v1/thread-1", "t3-thread://v1/remote/thread%252F1"]) {
      props.onLinkPress?.({ url });
      expect(onLinkPress).toHaveBeenLastCalledWith(url);
    }
    expect(render({ markdown }).md4cFlags?.hardSoftBreaks).toBe(false);
  });

  it("supplies distinct canonical occurrences while preserving descriptions on URL-wide pills", () => {
    const markdown = "[**details**](</repo/a.ts>) [*details*](/repo/a.ts)";
    render({ markdown });
    expect(harness.props!.selectionClipboard?.linkSources).toEqual([
      { url: "/repo/a.ts", source: "[**details**](</repo/a.ts>)" },
      { url: "/repo/a.ts", source: "[*details*](/repo/a.ts)" },
    ]);
    act(() =>
      harness.props!.onDocumentAssets?.({
        revision: 1,
        assets: [
          {
            id: "first",
            kind: "link",
            url: "/repo/a.ts",
            altText: "details",
            title: "",
            placement: "inline",
            eligible: false,
          },
          {
            id: "second",
            kind: "link",
            url: "/repo/a.ts",
            altText: "details",
            title: "",
            placement: "inline",
            eligible: false,
          },
        ],
      }),
    );
    expect(harness.props!.linkPillContent?.["/repo/a.ts"]?.label).toBeUndefined();
    expect(harness.props!.markdownStyle?.linkVariants?.["^/repo/a\\.ts$"]).toBeUndefined();
  });

  it("retains repeated context references and payload metadata alongside canonical Skill copy", () => {
    const record = {
      version: 1 as const,
      kind: "image" as const,
      contextId: ComposerContextId.make("shot"),
      label: "Screenshot",
      attachmentId: "uploaded",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 5,
    };
    const fragment = encodeComposerContextFragment({
      version: 1,
      source: { environmentId: EnvironmentId.make("remote") },
      records: [record],
    })!;
    const href = "t3-context://v1/image/shot";
    const props = render({
      markdown: `😀 ![Screenshot](${href}) then ![Screenshot](${href}) and €ui`,
      contextClipboardFragment: fragment,
      skills: [{ name: "ui", displayName: "UI" }],
    });
    expect(props.selectionClipboard?.linkTextByUrl).toEqual({
      [href]: `![Screenshot](${href})`,
      "€ui": "$ui",
    });
    expect(JSON.parse(props.selectionClipboard!.contextFragment!)).toEqual(JSON.parse(fragment));
    expect(props.selectionClipboard?.mimeTypes).toBeUndefined();
    expect(props.selectionClipboard?.htmlAttributes).toBeUndefined();
  });

  it("keeps filename pills while retaining descriptive child formatting for a shared URL", () => {
    render({ markdown: "[a.ts](/repo/a.ts)" });
    const assets = [
      {
        id: "file",
        kind: "link" as const,
        url: "/repo/a.ts",
        altText: "a.ts",
        title: "",
        placement: "inline" as const,
        eligible: false as const,
      },
    ];
    act(() => harness.props!.onDocumentAssets?.({ revision: 1, assets }));
    expect(harness.props!.linkPillContent?.["/repo/a.ts"]?.label).toBe("a.ts");
    expect(harness.props!.markdownStyle?.linkVariants?.["^/repo/a\\.ts$"]?.pill).toBeDefined();

    render({ markdown: "[a.ts](/repo/a.ts) [validates **the input**](/repo/a.ts)" });
    act(() =>
      harness.props!.onDocumentAssets?.({
        revision: 2,
        assets: [...assets, { ...assets[0]!, id: "description", altText: "validates the input" }],
      }),
    );
    expect(harness.props!.markdown).toContain("[validates **the input**](/repo/a.ts)");
    expect(harness.props!.markdownStyle?.linkVariants?.["^/repo/a\\.ts$"]).toBeUndefined();
    expect(harness.props!.selectionClipboard?.linkSources?.[1]?.source).toBe(
      "[validates **the input**](/repo/a.ts)",
    );
  });

  it("binds known digit-leading skills in quotes while leaving unknown skill text literal", () => {
    const markdown = "> Use $3d-map, then $unknown.\n\n`$3d-map`";
    const props = render({ markdown, skills: [{ name: "3d-map", displayName: "3D map" }] });
    expect(props.markdown).toBe(markdown);
    expect(props.linkRecognition?.text?.test("$3d-map")).toBe(true);
    expect(props.linkRecognition?.text?.test("$unknown")).toBe(false);
    expect(props.selectionClipboard?.linkTextByUrl).toEqual({ "$3d-map": "$3d-map" });
  });

  it("binds recognized file code spans without promoting fenced examples", () => {
    const props = render({ markdown: "`/tmp/frame.png`\n\n```text\n/tmp/example.png\n```" });
    expect(props.selectionClipboard?.recognizedLinkTextByUrl).toEqual({
      "/tmp/frame.png": "[frame.png](</tmp/frame.png>)",
    });
  });

  it("refuses unknown-version fragments before exposing clipboard metadata", () => {
    const props = render({
      markdown: "[details](/repo/a.ts)",
      contextClipboardFragment: JSON.stringify({
        version: 2,
        source: { environmentId: "remote" },
        records: [],
      }),
    });
    expect(props.selectionClipboard?.contextFragment).toBeUndefined();
  });

  it("filters malformed records through the existing fragment codec", () => {
    const props = render({
      markdown: "[details](/repo/a.ts)",
      contextClipboardFragment: JSON.stringify({
        version: 1,
        source: { environmentId: "remote" },
        records: [{ version: 1, kind: "image", contextId: "bad", label: "Missing attachment" }],
      }),
    });
    expect(JSON.parse(props.selectionClipboard!.contextFragment!).records).toEqual([]);
    expect(props.selectionClipboard?.htmlAttributes).toBeUndefined();
    expect(props.selectionClipboard?.mimeTypes).toBeUndefined();
  });

  it("forwards host-owned image resolution and unavailable fallback without inventing access", async () => {
    const resolver = vi.fn(async () => ({
      uri: "https://host/signed",
      headers: { "test-header": "synthetic" },
    }));
    const renderImage = vi.fn(() => null);
    const onImagePress = vi.fn();
    const props = render({
      markdown: "![shot](../shot.png)",
      resolveImageSource: resolver,
      renderImage,
      onImagePress,
    });
    const asset = {
      id: "shot",
      kind: "image" as const,
      url: "../shot.png",
      altText: "shot",
      title: "",
      placement: "block" as const,
      eligible: true,
    };
    expect(await props.resolveImageSource?.(asset)).toEqual({
      uri: "https://host/signed",
      headers: { "test-header": "synthetic" },
    });
    expect(resolver).toHaveBeenCalledWith({ href: "../shot.png", alt: "shot", title: null });
    expect(props.renderMedia?.(asset)).toBeNull();
    props.onImagePress?.({ url: "../shot.png", altText: "shot" });
    expect(onImagePress).toHaveBeenCalledWith("../shot.png");
  });
});
