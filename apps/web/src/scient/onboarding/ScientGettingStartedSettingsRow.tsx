import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { ArrowRightIcon } from "lucide-react";

import { SettingsRow } from "../../components/settings/settingsLayout";

export function ScientGettingStartedSettingsRow() {
  const gt = useGT();
  return (
    <Link
      className="group -mb-3 block rounded-xl outline-none transition-colors hover:bg-foreground/[0.025] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      to="/getting-started"
    >
      <SettingsRow
        description={gt("Connect an AI and update your local preferences.")}
        title={
          <span className="inline-flex items-center gap-2.5 transition-colors group-hover:text-foreground/75">
            <T>Getting started</T>
            <ArrowRightIcon
              aria-hidden
              className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1"
            />
          </span>
        }
      />
    </Link>
  );
}
