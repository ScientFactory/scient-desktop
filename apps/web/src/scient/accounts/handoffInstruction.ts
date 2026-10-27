import type { AccountHandoff } from "@t3tools/contracts";

export function handoffInstruction({ kind }: Pick<AccountHandoff, "kind">) {
  switch (kind) {
    case "push":
      return "Approve the sign-in on your phone.";
    case "code":
      return "Type the code you were sent.";
    case "captcha":
      return "Complete the check.";
    case "passkey":
      return "Use your passkey or Touch ID.";
    case "other":
      return "Finish signing in.";
  }
}
