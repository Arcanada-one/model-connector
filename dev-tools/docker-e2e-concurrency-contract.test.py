#!/usr/bin/env python3
"""Workflow contract: docker-e2e must be concurrency-safe on a shared Docker host.

ci-general runners share one Docker daemon (measured: Machine name / Docker Name
arcana-prd across arcana-prd-general-*). Fixed host ports and fixed container
names therefore collide when two docker-e2e jobs overlap. GitHub also cancels
previously PENDING jobs in a shared concurrency group when a newer job joins
(even with cancel-in-progress: false; incident main run 44160477798).

This control reads the committed workflow file in the checkout (not a moving
git ref). It fails on fixed host ports, fixed e2e container names, and any
shared/static concurrency group that can cancel a pending peer.
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
        return group_line[len("      group: ") :].strip()

    def test_job_keeps_cancel_in_progress_false(self) -> None:
        self._concurrency_group_line()

    def test_concurrency_group_is_unique_per_run_for_every_event(self) -> None:
        expression = self._concurrency_group_line()
        # Every event (push main and pull_request) must isolate by run_id so a
        # newer pending job never joins a shared group and cancels a peer.
        self.assertIn("github.run_id", expression)
        self.assertNotIn("github.event_name", expression)
        self.assertNotIn("refs/heads/main", expression)
        # No static shared lock name that all PRs (or all events) join.
        self.assertNotEqual(expression, "docker-e2e-arcana-prod")
        self.assertNotIn("'docker-e2e-arcana-prod'", expression)
        self.assertNotIn('"docker-e2e-arcana-prod"', expression)

    def test_no_fixed_host_ports_for_postgres_or_redis(self) -> None:
        # Host:container form with a fixed host port collides on the shared
        # Docker host when two docker-e2e jobs overlap.
        self.assertNotRegex(self.job, r"(?m)^\s*-\s*15432\s*:\s*5432\s*$")
        self.assertNotRegex(self.job, r"(?m)^\s*-\s*16379\s*:\s*6379\s*$")
        self.assertNotIn("localhost:15432", self.job)
        self.assertNotIn("REDIS_PORT=16379", self.job)
        # Ephemeral service mapping: publish container port only; host port
        # comes from job.services.*.ports at runtime.
        self.assertRegex(self.job, r"(?ms)postgres:.*?ports:\n(?:\s*-\s*.*\n)*?\s*-\s*5432(?:/tcp)?\s*$")
        self.assertRegex(self.job, r"(?ms)redis:.*?ports:\n(?:\s*-\s*.*\n)*?\s*-\s*6379(?:/tcp)?\s*$")
        self.assertIn("job.services.postgres.ports", self.job)
        self.assertIn("job.services.redis.ports", self.job)

    def test_e2e_container_name_is_unique_per_run(self) -> None:
        # Fixed --name mc-e2e collides when two jobs share the Docker host.
        self.assertNotRegex(self.job, r"""--name\s+mc-e2e(?:\s|\\|$)""")
        self.assertNotRegex(self.job, r"""docker\s+rm\s+-f\s+mc-e2e(?:\s|\\|$)""")
        self.assertIn("GITHUB_RUN_ID", self.job)
        self.assertRegex(
            self.job,
            r"mc-e2e-\$\{?GITHUB_RUN_ID\}?-\$\{?GITHUB_RUN_ATTEMPT\}?",
        )

    def test_app_listen_port_is_not_fixed_3900_on_host_network(self) -> None:
        # --network=host + PORT=3900 collides the same way as fixed DB ports.
        self.assertNotRegex(self.job, r"(?m)^\s*-e\s+PORT=3900\s*$")
        self.assertNotIn("http://localhost:3900/", self.job)

    def test_workflow_still_wires_the_contract_test(self) -> None:
        self.assertIn(
            "PYTHONDONTWRITEBYTECODE=1 python3 -B dev-tools/docker-e2e-concurrency-contract.test.py",
            WORKFLOW,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
