"""Require self-hosted npm publish via NPM_TOKEN for publish-sdks.yml.

Operator decision 2026-11-18: npm packages publish from our self-hosted runners
with an automation token held as secrets.NPM_TOKEN. Trusted Publishing / OIDC
is GitHub-hosted-only, so publish-ts must not use ubuntu-*/macos-*/windows-*,
must drop id-token: write, must not pass --provenance, and must keep the
existing dry-run path that needs no secret.
"""

from __future__ import annotations

import pathlib
import sys
import unittest

try:
    import yaml
except ImportError:  # pragma: no cover - host may lack PyYAML
    yaml = None

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "publish-sdks.yml"
HOSTED_PREFIXES = ("ubuntu-", "macos-", "windows-")
# Match build-ts labels already used in this workflow.
REQUIRED_LABELS = {"self-hosted", "Linux", "ci-general"}


def _runs_on_values(raw: object) -> list[str]:
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, list):
        return [str(item) for item in raw]
    raise AssertionError(f"unexpected runs-on shape: {raw!r}")


@unittest.skipUnless(yaml is not None, "PyYAML required")
class PublishSdksNpmTokenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        raw = WORKFLOW.read_text(encoding="utf-8")
        cls.raw = raw
        cls.doc = yaml.safe_load(raw)

    def test_publish_ts_refuses_github_hosted_runners(self) -> None:
        publish = self.doc["jobs"]["publish-ts"]
        labels = _runs_on_values(publish["runs-on"])
        for label in labels:
            self.assertFalse(
                label.startswith(HOSTED_PREFIXES),
                f"publish-ts runs-on includes GitHub-hosted label {label!r}",
            )
        self.assertEqual(set(labels), REQUIRED_LABELS)

    def test_publish_ts_uses_token_not_oidc(self) -> None:
        publish = self.doc["jobs"]["publish-ts"]
        self.assertEqual(publish.get("environment"), "npm")
        perms = publish.get("permissions") or {}
        self.assertNotIn("id-token", perms)
        dumped = yaml.dump(publish)
        self.assertNotIn("--provenance", dumped)
        self.assertIn("NODE_AUTH_TOKEN", dumped)
        self.assertIn("secrets.NPM_TOKEN", dumped)

    def test_npm_token_is_only_in_npm_environment_publish_job(self) -> None:
        jobs = self.doc["jobs"]
        jobs_with_npm_token = [
            name
            for name, job in jobs.items()
            if "secrets.NPM_TOKEN" in yaml.dump(job)
            or "NODE_AUTH_TOKEN" in yaml.dump(job)
        ]
        self.assertEqual(jobs_with_npm_token, ["publish-ts"])
        self.assertEqual(jobs["publish-ts"].get("environment"), "npm")

    def test_publish_ts_tag_only(self) -> None:
        publish_if = str(self.doc["jobs"]["publish-ts"].get("if") or "")
        self.assertIn("github.event_name == 'push'", publish_if)
        self.assertIn("refs/tags/sdk-v", publish_if)
        self.assertNotIn("pull_request", publish_if)
        on = self.doc.get("on") or self.doc.get(True) or {}
        self.assertNotIn("workflow_dispatch", on)

    def test_publishing_jobs_check_out_event_sha(self) -> None:
        jobs = self.doc["jobs"]
        for job_name in ("build-ts", "tag-ancestor-gate", "publish-ts"):
            with self.subTest(job=job_name):
                checkouts = [
                    step
                    for step in jobs[job_name]["steps"]
                    if str(step.get("uses", "")).startswith("actions/checkout@")
                ]
                self.assertTrue(checkouts)
                for checkout in checkouts:
                    self.assertEqual(
                        checkout.get("with", {}).get("ref"), "${{ github.sha }}"
                    )

    def test_publish_ts_requires_tokenless_tag_ancestor_gate(self) -> None:
        jobs = self.doc["jobs"]
        gate = jobs["tag-ancestor-gate"]
        gate_if = str(gate.get("if") or "")
        self.assertIn("github.event_name == 'push'", gate_if)
        self.assertIn("refs/tags/sdk-v", gate_if)

        checkout = next(
            step for step in gate["steps"]
            if str(step.get("uses", "")).startswith("actions/checkout@")
        )
        self.assertEqual(checkout.get("with", {}).get("fetch-depth"), 0)
        gate_script = "\n".join(
            step["run"] for step in gate["steps"] if isinstance(step.get("run"), str)
        )
        self.assertIn(
            "git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main",
            gate_script,
        )
        self.assertIn(
            'git merge-base --is-ancestor "$GH_SHA" refs/remotes/origin/main',
            gate_script,
        )
        self.assertIn("exit 1", gate_script)
        gate_dump = yaml.dump(gate)
        self.assertNotIn("secrets.NPM_TOKEN", gate_dump)
        self.assertNotIn("NODE_AUTH_TOKEN", gate_dump)

        needs = jobs["publish-ts"].get("needs") or []
        self.assertIn("build-ts", needs)
        self.assertIn("tag-ancestor-gate", needs)

    def test_build_ts_dry_run_needs_no_secret(self) -> None:
        build = self.doc["jobs"]["build-ts"]
        dumped = yaml.dump(build)
        self.assertIn("--dry-run", dumped)
        self.assertIn("github.event.pull_request.head.repo.full_name", str(build.get("if")))
        self.assertIn("github.repository", str(build.get("if")))
        self.assertNotIn("secrets.NPM_TOKEN", dumped)
        self.assertNotIn("NODE_AUTH_TOKEN", dumped)

    def test_red_control_detects_ubuntu_latest(self) -> None:
        fake = {"jobs": {"publish-ts": {"runs-on": "ubuntu-latest"}}}
        labels = _runs_on_values(fake["jobs"]["publish-ts"]["runs-on"])
        hosted = [label for label in labels if label.startswith(HOSTED_PREFIXES)]
        self.assertEqual(hosted, ["ubuntu-latest"])


if __name__ == "__main__":
    # Fail closed if the contract file is missing when invoked directly.
    if not WORKFLOW.is_file():
        print(f"MISSING {WORKFLOW}", file=sys.stderr)
        sys.exit(2)
    unittest.main()
