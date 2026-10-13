import { beforeEach, expect, it, vi } from "vite-plus/test";
import { parseScientNewThreadLink } from "@t3tools/shared/scientPromptLinks";
import { promptLinkSearchFromParams } from "./prompt-link-model";

const native = vi.hoisted(() => ({ scheme: "", copy: vi.fn(), createURL: vi.fn() }));
vi.mock("expo-linking", () => ({ createURL: native.createURL }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: native.copy }));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  setComposerDraftText: vi.fn(),
  waitForComposerDraftsLoaded: vi.fn(),
}));
import { copyPromptLink } from "./prompt-link-actions";

beforeEach(() => {
  native.copy.mockReset().mockResolvedValue(true);
  native.createURL
    .mockReset()
    .mockImplementation(
      (path, { queryParams }) => `${native.scheme}://${path}?${new URLSearchParams(queryParams)}`,
    );
});

it.each(["t3code", "t3code-dev", "t3code-preview"])(
  "copies an encoded draft for the registered %s binary, with no hosted prompt authority",
  async (scheme) => {
    native.scheme = scheme;
    const prompt = "Review β & results = ready?\nRead before Send";
    await copyPromptLink(prompt);
    const link = native.copy.mock.calls[0]![0];
    expect(link.startsWith(`${scheme}://new?`)).toBe(true);
    expect(native.createURL).toHaveBeenCalledWith("new", { queryParams: { prompt } });
    const params = Object.fromEntries(new URL(link).searchParams);
    expect(parseScientNewThreadLink(promptLinkSearchFromParams(params)!)).toEqual({
      ok: true,
      value: {
        kind: "new",
        prompt: { text: prompt, hiddenCharacters: 0 },
        repository: null,
        provider: null,
        model: null,
      },
    });
  },
);
