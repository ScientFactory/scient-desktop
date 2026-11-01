import { Secret, TOTP, URI } from "otpauth";

export function parseTotp(value: string): TOTP {
  try {
    const parsed = value.startsWith("otpauth://")
      ? URI.parse(value)
      : new TOTP({ secret: Secret.fromBase32(value.replace(/\s/g, "")) });
    if (
      !(parsed instanceof TOTP) ||
      parsed.secret.bytes.length === 0 ||
      !Number.isFinite(parsed.period) ||
      parsed.period <= 0 ||
      parsed.digits < 6 ||
      parsed.digits > 8
    )
      throw new Error();
    return parsed;
  } catch {
    throw new Error("The account's two-factor setup is invalid.");
  }
}

export function accountOtp(value: string, timestamp: number): string {
  return /^\d{6,8}$/.test(value) ? value : parseTotp(value).generate({ timestamp });
}
