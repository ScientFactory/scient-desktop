import { ExternalLinkIcon } from "lucide-react";

const PROVIDER_ACCOUNT_URLS = {
  antigravity: "https://one.google.com/settings",
  claude: "https://claude.ai/settings/billing",
  codex: "https://chatgpt.com/#settings/Subscription",
} as const;

export function ProviderAccountManagementLink(props: {
  readonly provider: keyof typeof PROVIDER_ACCOUNT_URLS;
  readonly children: string;
}) {
  return (
    <a
      aria-label={`${props.children} settings (opens in browser)`}
      className="inline-flex items-center gap-0.5 text-foreground/80 underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
      href={PROVIDER_ACCOUNT_URLS[props.provider]}
      rel="noreferrer noopener"
      target="_blank"
    >
      <span>{props.children}</span>
      <ExternalLinkIcon aria-hidden className="size-2.5 shrink-0" />
    </a>
  );
}
