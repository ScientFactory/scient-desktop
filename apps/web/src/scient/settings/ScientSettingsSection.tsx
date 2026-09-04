import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { useSettingsSearchTarget } from "../../components/settings/settingsLayout";
import { cn } from "../../lib/utils";

/** Standalone Scient pages own their grouping instead of becoming one settings card. */
export function ScientSettingsSection({
  title,
  icon,
  children,
  className,
  ...sectionProps
}: ComponentPropsWithoutRef<"section"> & {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLElement>(sectionProps.id);

  return (
    <section
      {...sectionProps}
      ref={targetRef}
      tabIndex={sectionProps.id ? -1 : sectionProps.tabIndex}
      className={cn("space-y-3", className)}
    >
      <div
        data-settings-scroll-target
        className="flex min-h-8 items-center justify-between gap-4 px-3 sm:px-4"
      >
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-[-0.025em] text-foreground">
          {icon}
          {title}
        </h2>
      </div>
      <div className="relative space-y-1 overflow-visible text-foreground">{children}</div>
    </section>
  );
}
