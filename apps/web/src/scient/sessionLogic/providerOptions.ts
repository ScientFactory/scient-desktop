import { compareProviderDriverKinds, ProviderDriverKind } from "@t3tools/contracts";

export type ProviderPickerKind = ProviderDriverKind;

const PROVIDER_OPTIONS_UNORDERED: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
  /** Shown on the model picker sidebar when relevant */
  pickerSidebarBadge?: "new" | "soon";
}> = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", available: true },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", available: true },
  { value: ProviderDriverKind.make("pi"), label: "Pi", available: true, pickerSidebarBadge: "new" },
  {
    value: ProviderDriverKind.make("omp"),
    label: "Oh My Pi",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("scient"),
    label: "Scient",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("grok"),
    label: "Grok",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("droid"),
    label: "Droid",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("muse"),
    label: "Muse Code",
    available: true,
    pickerSidebarBadge: "new",
  },
];

export const PROVIDER_OPTIONS = PROVIDER_OPTIONS_UNORDERED.toSorted((left, right) =>
  compareProviderDriverKinds(left.value, right.value),
);
