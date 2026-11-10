import base64
import datetime
import os
from pathlib import Path
import plistlib
import re
import subprocess
import tempfile


def validate_profile(profile, team_id, app_id, domains, now):
    if not re.fullmatch(r"[A-Z0-9]{10}", team_id):
        raise ValueError("SCIENT_APPLE_TEAM_ID must be a 10-character Apple Team ID")
    if team_id not in profile.get("TeamIdentifier", []):
        raise ValueError("The provisioning profile belongs to another Apple team")
    if "OSX" not in profile.get("Platform", []):
        raise ValueError(
            "A macOS provisioning profile is required; iOS profiles cannot be used"
        )
    entitlements = profile.get("Entitlements", {})
    identifier = entitlements.get("com.apple.application-identifier")
    if identifier != f"{team_id}.{app_id}":
        raise ValueError(
            "The provisioning profile does not match Scient's application identifier"
        )
    expiry = profile.get("ExpirationDate")
    if (
        not isinstance(expiry, datetime.datetime)
        or expiry.replace(tzinfo=datetime.timezone.utc) <= now
    ):
        raise ValueError(
            "The provisioning profile is expired or has no expiration date"
        )
    if profile.get("ProvisionsAllDevices") is not True:
        raise ValueError("A Developer ID distribution profile is required")
    allowed = entitlements.get("com.apple.developer.associated-domains", [])
    if not domains or any(
        "*" not in allowed and f"webcredentials:{domain}" not in allowed
        for domain in domains
    ):
        raise ValueError(
            "The provisioning profile does not authorize the passkey domains"
        )


def main():
    team_id = os.environ.get("SCIENT_APPLE_TEAM_ID", "").strip().upper()
    encoded = os.environ.get("SCIENT_MACOS_PROVISIONING_PROFILE_BASE64", "")
    if not encoded:
        raise ValueError(
            "SCIENT_MACOS_PROVISIONING_PROFILE_BASE64 is required for signed Connect builds"
        )
    try:
        content = base64.b64decode("".join(encoded.split()), validate=True)
    except ValueError:
        raise ValueError(
            "The provisioning-profile secret is not valid base64"
        ) from None
    override = os.environ.get("T3CODE_CLERK_PASSKEY_RP_DOMAINS", "").strip()
    if override:
        domains = [domain.strip().lower() for domain in override.split(",")]
    else:
        key = os.environ.get("T3CODE_CLERK_PUBLISHABLE_KEY", "")
        if not key.startswith(("pk_test_", "pk_live_")):
            raise ValueError(
                "A Clerk publishable key or explicit passkey domains are required"
            )
        try:
            hostname = base64.b64decode(key.split("_", 2)[2], validate=True).decode(
                "utf-8"
            )
        except (ValueError, UnicodeError):
            raise ValueError(
                "The Clerk publishable key cannot supply the passkey domain"
            ) from None
        if not hostname.endswith("$"):
            raise ValueError("The Clerk publishable key has no hostname terminator")
        domains = [hostname[:-1].lower()]
    if any(
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", domain)
        for domain in domains
    ):
        raise ValueError("Invalid passkey relying-party domain")
    with tempfile.TemporaryDirectory(
        prefix="scient-profile-check-", dir=os.environ["RUNNER_TEMP"]
    ) as directory:
        source = Path(directory) / "profile.provisionprofile"
        source.write_bytes(content)
        source.chmod(0o600)
        decoded = subprocess.run(
            ["security", "cms", "-D", "-i", str(source)], capture_output=True
        )
        if decoded.returncode:
            raise ValueError("Apple security could not decode the provisioning profile")
        try:
            profile = plistlib.loads(decoded.stdout)
        except (ValueError, plistlib.InvalidFileException):
            raise ValueError("Apple returned an invalid provisioning profile") from None
        validate_profile(
            profile,
            team_id,
            "com.scientfactory.scient",
            domains,
            datetime.datetime.now(datetime.timezone.utc),
        )
        destination = (
            Path(
                tempfile.mkdtemp(
                    prefix="scient-connect-signing-", dir=os.environ["RUNNER_TEMP"]
                )
            )
            / "embedded.provisionprofile"
        )
        destination.write_bytes(content)
        destination.chmod(0o600)
    with open(os.environ["GITHUB_ENV"], "a") as output:
        output.write(f"T3CODE_APPLE_TEAM_ID={team_id}\n")
        output.write(f"T3CODE_MACOS_PROVISIONING_PROFILE={destination}\n")
        output.write(f"T3CODE_CLERK_PASSKEY_RP_DOMAINS={','.join(domains)}\n")
    print(
        "Verified Developer ID profile for com.scientfactory.scient and its passkey domains"
    )


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error)) from None
