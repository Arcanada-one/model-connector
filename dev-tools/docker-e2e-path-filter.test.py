#!/usr/bin/env python3
"""Focused, offline workflow-control matrix for Docker e2e path selection."""
from __future__ import annotations

import importlib.util
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILTER_PATH = ROOT / "dev-tools/docker-e2e-path-filter.py"
SPEC = importlib.util.spec_from_file_location("docker_e2e_path_filter", FILTER_PATH)
FILTER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(FILTER)
WORKFLOW_TEXT = (ROOT / ".github/workflows/ci.yml").read_text()
EVENT = {
    "ref": "refs/heads/main",
    "pull_request": {
        "base": {"sha": "a" * 40, "repo": {"full_name": "Arcanada-one/model-connector"}},
        "head": {"sha": "b" * 40, "repo": {"full_name": "Arcanada-one/model-connector"}},
    },
}
REPO = "Arcanada-one/model-connector"
IGNORE = FILTER.dockerignore_contract((ROOT / ".dockerignore").read_text())


class DecisionMatrix(unittest.TestCase):
    def test_main_push_keeps_full_e2e(self):
        self.assertEqual(FILTER.decide("push", EVENT, REPO, ["README.md"], IGNORE),
                         (True, "main_full_qualification"))

    def test_docs_only_same_repo_pr_skips_docker_context(self):
        self.assertEqual(FILTER.decide("pull_request", EVENT, REPO,
                                       ["README.md", "docs/operations.md"], IGNORE),
                         (False, "ignored_context_only"))

    def test_template_only_same_repo_pr_skips_docker_context(self):
        self.assertEqual(FILTER.decide("pull_request", EVENT, REPO,
                                       ["templates/sample.yml"], IGNORE),
                         (False, "ignored_context_only"))

    def test_runtime_source_change_runs_e2e(self):
        self.assertEqual(FILTER.decide("pull_request", EVENT, REPO, ["src/main.ts"], IGNORE),
                         (True, "docker_context_input_changed"))

    def test_image_and_dependency_inputs_run_e2e(self):
        for path in ("Dockerfile", ".dockerignore", "package.json", "pnpm-lock.yaml",
                     "prisma/schema.prisma", "src/auth/rate-limit.integration.spec.ts",
                     "dev-tools/first-dispatch-observation-db-contract.mjs", "entrypoint.sh",
                     "deploy/bench-receiving-package.py", ".github/workflows/ci.yml"):
            with self.subTest(path=path):
                self.assertTrue(FILTER.decide("pull_request", EVENT, REPO, [path], IGNORE)[0])

    def test_selector_and_its_control_test_are_not_docker_context_inputs(self):
        for path in ("dev-tools/docker-e2e-path-filter.py", "dev-tools/docker-e2e-path-filter.test.py"):
            with self.subTest(path=path):
                self.assertFalse(FILTER.decide("pull_request", EVENT, REPO, [path], IGNORE)[0])

    def test_unknown_dockerignore_contract_fails_open(self):
        self.assertTrue(FILTER.decide("pull_request", EVENT, REPO, ["README.md"], None)[0])
        self.assertTrue(FILTER.decide("pull_request", EVENT, REPO, ["README.md"],
                                      (*IGNORE, "new-pattern"))[0])

    def test_fork_pr_runs_full_e2e_even_when_docs_only(self):
        fork = {**EVENT, "pull_request": {**EVENT["pull_request"],
                "head": {"sha": "b" * 40, "repo": {"full_name": "contributor/model-connector"}}}}
        self.assertTrue(FILTER.decide("pull_request", fork, REPO, ["README.md"], IGNORE)[0])

    def test_missing_empty_or_unknown_event_fails_open(self):
        self.assertTrue(FILTER.decide("pull_request", EVENT, REPO, None, IGNORE)[0])
        self.assertTrue(FILTER.decide("pull_request", EVENT, REPO, [], IGNORE)[0])
        self.assertTrue(FILTER.decide("workflow_dispatch", EVENT, REPO, ["README.md"], IGNORE)[0])

    def test_only_root_env_and_known_ignored_paths_are_skipped(self):
        self.assertTrue(FILTER.context_ignored(".env", IGNORE))
        self.assertFalse(FILTER.context_ignored("nested/.env", IGNORE))
        self.assertFalse(FILTER.context_ignored("src/.env.schema", IGNORE))
        self.assertTrue(FILTER.context_ignored(".github/workflows/other.yml", IGNORE))
        self.assertTrue(FILTER.decide("pull_request", EVENT, REPO,
                                     [".github/workflows/ci.yml"], IGNORE)[0])

    def test_unrelated_workflow_change_skips_docker_e2e(self):
        self.assertFalse(FILTER.decide("pull_request", EVENT, REPO,
                                      [".github/workflows/public-surface.yml"], IGNORE)[0])


class WorkflowContract(unittest.TestCase):
    def test_workflow_still_runs_for_main_and_pr_without_trigger_paths(self):
        self.assertRegex(WORKFLOW_TEXT, r"(?m)^on:\n  push:\n    branches: \[main\]\n  pull_request:\n    branches: \[main\]$")
        self.assertNotRegex(WORKFLOW_TEXT, r"(?m)^    paths:")

    def test_selector_is_fail_open_and_only_controls_docker_job(self):
        self.assertIn("docker_e2e_required: ${{ steps.docker_e2e_filter.outputs.required }}", WORKFLOW_TEXT)
        self.assertIn("id: docker_e2e_filter\n        continue-on-error: true\n        run: python3 -B dev-tools/docker-e2e-path-filter.py", WORKFLOW_TEXT)
        self.assertIn("if: needs.lint-and-test.outputs.docker_e2e_required != 'false'", WORKFLOW_TEXT)
        self.assertRegex(WORKFLOW_TEXT, r"(?ms)^  docker-e2e:\n.*?^    runs-on: \[self-hosted, Linux, ci-general\]$")

    def test_pr_supersession_and_deploy_serialization_are_preserved(self):
        self.assertIn("group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}", WORKFLOW_TEXT)
        self.assertIn("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", WORKFLOW_TEXT)
        deploy = re.search(r"(?ms)^  deploy:\n(.*?)(?=^  [a-zA-Z0-9_-]+:|\Z)", WORKFLOW_TEXT)
        self.assertIsNotNone(deploy)
        deploy_text = deploy.group(1)
        self.assertIn("needs: lint-and-test", deploy_text)
        self.assertIn("if: github.ref == 'refs/heads/main' && github.event_name == 'push'", deploy_text)
        self.assertIn("group: deploy-model-connector", deploy_text)
        self.assertIn("cancel-in-progress: false", deploy_text)

    def test_e2e_image_builds_remain_present(self):
        docker_job = re.search(r"(?ms)^  docker-e2e:\n(.*?)(?=^  [a-zA-Z0-9_-]+:|\Z)", WORKFLOW_TEXT)
        self.assertIsNotNone(docker_job)
        docker_text = docker_job.group(1)
        self.assertIn("docker buildx build --target build --load", docker_text)
        self.assertIn("docker buildx build --load --build-arg MC_BUILD_SHA", docker_text)
        self.assertIn("name: Smoke tests", docker_text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
