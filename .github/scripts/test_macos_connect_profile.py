import base64
import copy
import datetime
import importlib.util
import os
import plistlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "profile_stage", Path(__file__).with_name("stage-macos-connect-profile.py")
)
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)
NOW = datetime.datetime(2026, 11, 10, tzinfo=datetime.timezone.utc)
TEAM = "ABC1234567"
APP = "com.scientfactory.scient"
DOMAIN = "login.clerk.accounts.dev"


def profile():
    return {
        "TeamIdentifier": [TEAM],
        "Platform": ["OSX"],
        "ExpirationDate": datetime.datetime(2027, 1, 1),
        "ProvisionsAllDevices": True,
        "Entitlements": {
            "com.apple.application-identifier": f"{TEAM}.{APP}",
            "com.apple.developer.associated-domains": [f"webcredentials:{DOMAIN}"],
        },
    }


class ProfileTests(unittest.TestCase):
    def test_accepts_explicit_and_wildcard_domain_authority(self):
        for allowed in ([f"webcredentials:{DOMAIN}"], ["*"], "*"):
            with self.subTest(allowed=allowed):
                candidate = profile()
                candidate["Entitlements"]["com.apple.developer.associated-domains"] = (
                    allowed
                )
                stage.validate_profile(candidate, TEAM, APP, [DOMAIN], NOW)

    def test_rejects_wrong_team_platform_app_expiry_distribution_and_domains(self):
        cases = [
            ("TeamIdentifier", ["ZZZ1234567"]),
            ("Platform", ["iOS"]),
            ("ExpirationDate", datetime.datetime(2025, 1, 1)),
            ("ExpirationDate", None),
            ("ProvisionsAllDevices", False),
            (
                "Entitlements",
                {"com.apple.application-identifier": f"{TEAM}.another.app"},
            ),
            (
                "Entitlements",
                {
                    "com.apple.application-identifier": f"{TEAM}.{APP}",
                    "com.apple.developer.associated-domains": [
                        "webcredentials:another.example"
                    ],
                },
            ),
            (
                "Entitlements",
                {
                    "com.apple.application-identifier": f"{TEAM}.{APP}",
                    "com.apple.developer.associated-domains": "webcredentials:*.another.example",
                },
            ),
        ]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                candidate = copy.deepcopy(profile())
                candidate[field] = value
                with self.assertRaises(ValueError):
                    stage.validate_profile(candidate, TEAM, APP, [DOMAIN], NOW)
        with self.assertRaises(ValueError):
            stage.validate_profile(profile(), "invalid", APP, [DOMAIN], NOW)
        with self.assertRaises(ValueError):
            stage.validate_profile(
                profile(), TEAM, APP, [DOMAIN, "another.example"], NOW
            )

    def test_stages_verified_bytes_privately_and_exports_builder_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / "github-env"
            env = {
                "RUNNER_TEMP": directory,
                "GITHUB_ENV": str(env_file),
                "SCIENT_APPLE_TEAM_ID": TEAM,
                "SCIENT_MACOS_PROVISIONING_PROFILE_BASE64": "cHJvZmlsZQ==",
                "T3CODE_CLERK_PUBLISHABLE_KEY": "pk_test_"
                + base64.b64encode((DOMAIN + "$").encode()).decode().rstrip("="),
            }
            candidate = profile()
            candidate["ExpirationDate"] = datetime.datetime(2099, 1, 1)
            decoded = SimpleNamespace(returncode=0, stdout=plistlib.dumps(candidate))
            with (
                mock.patch.dict(os.environ, env, clear=True),
                mock.patch.object(stage.subprocess, "run", return_value=decoded),
            ):
                stage.main()
            exported = dict(
                line.split("=", 1) for line in env_file.read_text().splitlines()
            )
            staged = Path(exported["T3CODE_MACOS_PROVISIONING_PROFILE"])
            self.assertEqual(staged.read_bytes(), b"profile")
            self.assertEqual(staged.stat().st_mode & 0o777, 0o600)
            self.assertEqual(exported["T3CODE_APPLE_TEAM_ID"], TEAM)
            self.assertEqual(exported["T3CODE_CLERK_PASSKEY_RP_DOMAINS"], DOMAIN)

    def test_failed_decode_exports_no_builder_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / "github-env"
            env = {
                "RUNNER_TEMP": directory,
                "GITHUB_ENV": str(env_file),
                "SCIENT_APPLE_TEAM_ID": TEAM,
                "SCIENT_MACOS_PROVISIONING_PROFILE_BASE64": "cHJvZmlsZQ==",
                "T3CODE_CLERK_PASSKEY_RP_DOMAINS": DOMAIN,
            }
            with (
                mock.patch.dict(os.environ, env, clear=True),
                mock.patch.object(
                    stage.subprocess, "run", return_value=SimpleNamespace(returncode=1)
                ),
                self.assertRaises(ValueError),
            ):
                stage.main()
            self.assertFalse(env_file.exists())


if __name__ == "__main__":
    unittest.main()
