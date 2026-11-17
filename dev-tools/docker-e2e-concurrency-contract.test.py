#!/usr/bin/env python3
"""Workflow contract: docker-e2e concurrency must not let a PR displace main.

GitHub cancels previously PENDING jobs in a concurrency group when a newer job
joins, even with cancel-in-progress: false. A shared static group therefore lets
a pull_request docker-e2e cancel a pending push-to-main docker-e2e (incident:
main run 44160477798, 2026-11-17). This control reads the committed workflow
file in the checkout (not a moving git ref).
"""
from __future__ import annotations

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github/workflows/ci.yml").read_text()


def docker_e2e_job(text: str) -> str:
    match = re.search(r"(?ms)^  docker-e2e:\n(.*?)(?=^  [a-zA-Z0-9_-]+:|\Z)", text)
    assert match is not None, "docker-e2e job missing"
    return match.group(1)


class DockerE2EConcurrencyContract(unittest.TestCase):
    def setUp(self) -> None:
        self.job = docker_e2e_job(WORKFLOW)

    def _concurrency_group_line(self) -> str:
        lines = self.job.splitlines()
        try:
            idx = lines.index("    concurrency:")
        except ValueError as exc:
            raise AssertionError("docker-e2e concurrency block missing") from exc
        group_line = lines[idx + 1]
        cancel_line = lines[idx + 2]
        self.assertTrue(group_line.startswith("      group: "), group_line)
        self.assertEqual(cancel_line.strip(), "cancel-in-progress: false")
        return group_line[len("      group: "):].strip()

    def test_job_keeps_cancel_in_progress_false(self) -> None:
        self._concurrency_group_line()

    def test_no_static_shared_group_for_all_events(self) -> None:
        # The defect: one literal group name shared by main and PR.
        self.assertNotEqual(self._concurrency_group_line(), "docker-e2e-arcana-prod")

    def test_push_to_main_group_is_unique_per_run(self) -> None:
        expression = self._concurrency_group_line()
        self.assertIn("github.run_id", expression)
        self.assertIn("refs/heads/main", expression)
        self.assertIn("github.event_name", expression)
        # Main branch of the expression must isolate push-to-main by run_id.
        self.assertRegex(
            expression,
            r"format\('docker-e2e-arcana-prod-main-\{0\}',\s*github\.run_id\)",
        )

    def test_pull_request_still_shares_one_lock_group(self) -> None:
        expression = self._concurrency_group_line()
        # PR side keeps the historical shared resource lock name.
        self.assertIn("'docker-e2e-arcana-prod'", expression)

    def test_workflow_still_wires_the_contract_test(self) -> None:
        self.assertIn(
            "PYTHONDONTWRITEBYTECODE=1 python3 -B dev-tools/docker-e2e-concurrency-contract.test.py",
            WORKFLOW,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
