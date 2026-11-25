import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { FolderIcon, PackageIcon } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "~/components/CommandPalette.logic";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { useStableCallback } from "~/hooks/useStableCallback";
import { computeEnvironment } from "~/state/compute";

import { ScientTooltip } from "~/scient/presentation/ScientTooltip";

import { ExportResultPackageButton } from "./ExportResultPackageButton";
import { VerifyResultPackageDialog } from "./VerifyResultPackageDialog";

type VerifyTarget = { readonly environmentId: EnvironmentId; readonly cwd: string | null };
const OpenVerification = createContext<((target: VerifyTarget) => void) | null>(null);

export function ResultPackagePalette({ children }: { readonly children: ReactNode }) {
  const [target, setTarget] = useState<VerifyTarget | null>(null);
  const [visible, setVisible] = useState(false);
  const reopen = useStableCallback(() => setVisible(true));
  const start = (next: VerifyTarget) => {
    setTarget((current) => current ?? next);
    setVisible(true);
  };
  return (
    <OpenVerification value={start}>
      {children}
      {target === null ? null : (
        <VerifyResultPackageDialog
          {...target}
          open={visible}
          onReopen={reopen}
          onClose={(keepMounted) => {
            if (!keepMounted) setTarget(null);
            setVisible(false);
          }}
        />
      )}
    </OpenVerification>
  );
}

export function VerifyResultPackageButton(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly size?: "sm" | "xs";
}) {
  const openVerification = useContext(OpenVerification);
  const canVerify = useAtomValue(
    computeEnvironment.resultsVerify.permissionAtom(props.environmentId),
  );
  if (!canVerify || openVerification === null) return null;
  return (
    <Button
      size={props.size ?? "xs"}
      type="button"
      variant="ghost-muted"
      onClick={() => openVerification(props)}
    >
      <T>Verify a result package…</T>
    </Button>
  );
}

export function ResultPackageMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}) {
  const gt = useGT();
  const openVerification = useContext(OpenVerification);
  const canVerify = useAtomValue(
    computeEnvironment.resultsVerify.permissionAtom(props.environmentId),
  );
  const verify = canVerify && openVerification !== null ? () => openVerification(props) : undefined;
  const label = gt("Result packages");
  return (
    <ExportResultPackageButton
      {...props}
      renderTrigger={(startExport) =>
        startExport === undefined && verify === undefined ? null : (
          <Menu>
            <ScientTooltip content={label}>
              <MenuTrigger render={<Button size="sm" variant="ghost-muted" />} aria-label={label}>
                <PackageIcon aria-hidden />
                <span className="@max-[479px]:hidden">{label}</span>
              </MenuTrigger>
            </ScientTooltip>
            <MenuPopup align="end">
              {startExport === undefined ? null : (
                <MenuItem onClick={startExport}>
                  <T>Export for rerun…</T>
                </MenuItem>
              )}
              {verify === undefined ? null : (
                <MenuItem onClick={verify}>
                  <T>Verify a result package…</T>
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
        )
      }
    />
  );
}

export function useResultPackagePaletteItem(
  environmentId: EnvironmentId | null,
  cwd: string | null,
): CommandPaletteActionItem | null {
  const gt = useGT();
  const openVerification = useContext(OpenVerification);
  const canVerify = useAtomValue(computeEnvironment.resultsVerify.permissionAtom(environmentId));
  if (environmentId === null || !canVerify || openVerification === null) return null;

  return {
    kind: "action",
    value: "action:verify-result-package",
    title: gt("Verify a result package…"),
    searchTerms: ["compute", "rerun", "reproduce", "verification"],
    icon: <FolderIcon className={ITEM_ICON_CLASS} />,
    run: async () => openVerification({ environmentId, cwd }),
  };
}
