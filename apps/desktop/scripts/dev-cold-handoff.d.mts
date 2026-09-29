export interface ApprovedColdFileReceipt {
  readonly path: string;
  readonly identity: {
    readonly dev: string;
    readonly ino: string;
    readonly size: string;
    readonly mtimeNs: string;
  };
  readonly readOnly: false;
}

export function processStartToken(pid: number): string | null;
export function writeColdHandoff(input: {
  readonly stateRoot: string;
  readonly root: string;
  readonly role: "stable" | "candidate";
  readonly coldPid: number;
  readonly coldStart: string;
  readonly files: readonly ApprovedColdFileReceipt[];
  readonly now?: number;
}): { readonly path: string; readonly nonce: string };
export function takeApprovedHandoff(input: {
  readonly path: string;
  readonly stateRoot: string;
  readonly root: string;
  readonly role: "stable" | "candidate";
  readonly now?: number;
}): readonly ApprovedColdFileReceipt[];
