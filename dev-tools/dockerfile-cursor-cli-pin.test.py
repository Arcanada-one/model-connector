#!/usr/bin/env python3
"""Dockerfile contract: Cursor CLI must be version-pinned with checksum + retry.

The production image used to pipe https://cursor.com/install into bash unpinned;
a transient HTTP 500 on 2026-11-17 failed publish-image (run 44168125203).
This control reads the committed Dockerfile in the checkout (not a moving git ref).
"""
from __future__ import annotations

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOCKERFILE = (ROOT / "Dockerfile").read_text()
WORKFLOW = (ROOT / ".github/workflows/ci.yml").read_text()

# Pinned package measured from downloads.cursor.com on 2026-11-17 (linux/x64).
PINNED_VERSION = "2026.11.13-eacade1"
PINNED_SHA256 = "c02e4321f20d691ee03af94d29948dc3a81c6c34e7328da7bb1afade4c75812f"


class DockerfileCursorCliPinContract(unittest.TestCase):
    def test_does_not_pipe_unpinned_install_script_into_bash(self) -> None:
        self.assertNotRegex(
            DOCKERFILE,
            r"curl[^\n]*cursor\.com/install[^\n]*\|\s*bash",
        )
        self.assertNotIn("https://cursor.com/install", DOCKERFILE)

    def test_pins_exact_version_url_and_checksum(self) -> None:
        self.assertIn(f"CURSOR_AGENT_VERSION={PINNED_VERSION}", DOCKERFILE)
        self.assertIn(PINNED_SHA256, DOCKERFILE)
        self.assertIn(
            "downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/x64/agent-cli-package.tar.gz",
            DOCKERFILE,
        )
        self.assertRegex(
            DOCKERFILE,
            r"sha256sum\s+--check\s+--strict",
        )

    def test_download_retries_transient_errors(self) -> None:
        self.assertIn("agent-cli-package.tar.gz", DOCKERFILE)
        self.assertRegex(DOCKERFILE, r"curl[^\n]*--retry\s+[1-9]")
        self.assertRegex(DOCKERFILE, r"--retry-delay\s+[0-9]+")

    def test_install_layout_keeps_cursor_agent_on_path(self) -> None:
        self.assertIn("/opt/cursor-agent", DOCKERFILE)
        self.assertIn("/usr/local/bin/cursor-agent", DOCKERFILE)
        self.assertIn("cursor-agent", DOCKERFILE)

    def test_workflow_still_wires_the_contract_test(self) -> None:
        self.assertIn(
            "PYTHONDONTWRITEBYTECODE=1 python3 -B dev-tools/dockerfile-cursor-cli-pin.test.py",
            WORKFLOW,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
