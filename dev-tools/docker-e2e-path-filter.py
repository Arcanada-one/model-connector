#!/usr/bin/env python3
"""Fail-open selector for the existing Docker e2e job; never prints changed paths."""
from __future__ import annotations

import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import subprocess
import sys
import time


EXPECTED_DOCKERIGNORE = (
    "node_modules",
    "dist",
    ".env",
    ".git",
    "coverage",
    "*.md",
    "templates",
    ".github",
    "dev-tools/docker-e2e-path-filter.py",
    "dev-tools/docker-e2e-path-filter.test.py",
)
MAX_DIFF_BYTES = 2 * 1024 * 1024
DIFF_TIMEOUT_SECONDS = 20
FETCH_TIMEOUT_SECONDS = 45
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
QUALIFICATION_PATHS = {
    ".github/workflows/ci.yml",
    "dev-tools/docker-e2e-path-filter.py",
    "dev-tools/docker-e2e-path-filter.test.py",
}


def dockerignore_contract(raw: str) -> tuple[str, ...] | None:
    rows = tuple(
        line.strip()
        for line in raw.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )
    return rows if rows == EXPECTED_DOCKERIGNORE else None


def context_ignored(path: str, patterns: tuple[str, ...]) -> bool:
    """Recognize only the current simple ignore rules; unknowns always trigger e2e."""
    if not path or path.startswith("/") or "\\" in path or "\x00" in path:
        return False
    parts = PurePosixPath(path).parts
    if "*.md" in patterns and parts and parts[-1].endswith(".md"):
        return True
    for directory in ("node_modules", "dist", ".git", "coverage", "templates", ".github"):
        if directory in patterns and (path == directory or path.startswith(directory + "/")):
            return True
    if path in patterns and path.startswith("dev-tools/"):
        return True
    return ".env" in patterns and path == ".env"


def decide(event_name: str, event: dict, repository: str, paths: list[str] | None,
           dockerignore: tuple[str, ...] | None) -> tuple[bool, str]:
    """Return whether Docker e2e must run; only fully qualified ignored-only PRs skip."""
    if event_name == "push" and event.get("ref") == "refs/heads/main":
        return True, "main_full_qualification"
    if event_name != "pull_request":
        return True, "unknown_event_fail_open"

    pr = event.get("pull_request")
    if not isinstance(pr, dict):
        return True, "missing_pull_request_fail_open"
    base = pr.get("base") if isinstance(pr.get("base"), dict) else {}
    head = pr.get("head") if isinstance(pr.get("head"), dict) else {}
    base_repo = base.get("repo") if isinstance(base.get("repo"), dict) else {}
    head_repo = head.get("repo") if isinstance(head.get("repo"), dict) else {}
    if not repository or base_repo.get("full_name") != repository or head_repo.get("full_name") != repository:
        return True, "fork_or_repo_mismatch_fail_open"
    if dockerignore != EXPECTED_DOCKERIGNORE:
        return True, "unknown_dockerignore_fail_open"
    if not paths:
        return True, "missing_or_empty_diff_fail_open"
    if any(path in QUALIFICATION_PATHS for path in paths):
        return True, "qualification_source_changed"
    if any(not context_ignored(path, dockerignore) for path in paths):
        return True, "docker_context_input_changed"
    return False, "ignored_context_only"


def _git_env() -> dict[str, str]:
    env = os.environ.copy()
    env.update({
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "/bin/false",
        "GIT_TRACE": "0",
        "GIT_CURL_VERBOSE": "0",
    })
    return env


def _git(repo: Path, args: list[str], timeout: int) -> bool:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=_git_env(),
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _has_commit(repo: Path, sha: str) -> bool:
    return bool(SHA_RE.fullmatch(sha)) and _git(repo, ["cat-file", "-e", f"{sha}^{{commit}}"], 5)


def _changed_paths(repo: Path, base_sha: str, head_sha: str) -> list[str] | None:
    if not SHA_RE.fullmatch(base_sha) or not SHA_RE.fullmatch(head_sha):
        return None
    for sha in (base_sha, head_sha):
        if not _has_commit(repo, sha):
            if not _git(repo, ["fetch", "--no-tags", "--quiet", "--depth=1", "origin", base_sha, head_sha], FETCH_TIMEOUT_SECONDS):
                return None
            break
    command = ["git", "-C", str(repo), "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", base_sha, head_sha]
    try:
        proc = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, env=_git_env(), close_fds=True)
    except OSError:
        return None
    assert proc.stdout is not None
    data = bytearray()
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + DIFF_TIMEOUT_SECONDS
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                proc.kill()
                proc.wait()
                return None
            if not selector.select(remaining):
                proc.kill()
                proc.wait()
                return None
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > MAX_DIFF_BYTES:
                proc.kill()
                proc.wait()
                return None
        if proc.wait(timeout=max(0.1, deadline - time.monotonic())) != 0 or not data:
            return None
    except (OSError, subprocess.SubprocessError):
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        return None
    finally:
        selector.close()
        proc.stdout.close()
    try:
        return [part.decode("utf-8", errors="strict") for part in data.split(b"\x00") if part]
    except UnicodeDecodeError:
        return None


def _write_outputs(path: str, required: bool, reason: str, count: int | None) -> bool:
    if not path:
        return False
    count_value = "unknown" if count is None else str(count)
    # Put the disabling value last: a short/failed append can never leave a
    # parseable required=false line without completing the whole payload.
    payload = f"reason={reason}\nchanged_count={count_value}\nrequired={'true' if required else 'false'}\n".encode()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
        try:
            view = memoryview(payload)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    return False
                view = view[written:]
        finally:
            os.close(fd)
        return True
    except OSError:
        return False


def main() -> int:
    workspace = Path(os.environ.get("GITHUB_WORKSPACE", ".")).resolve()
    event_name = os.environ.get("GITHUB_EVENT_NAME", "")
    event_path = os.environ.get("GITHUB_EVENT_PATH", "")
    repo_name = os.environ.get("GITHUB_REPOSITORY", "")
    event: dict = {}
    paths: list[str] | None = None
    ignore: tuple[str, ...] | None = None
    reason = "event_read_fail_open"
    try:
        event = json.loads(Path(event_path).read_text(encoding="utf-8")) if event_path else {}
        ignore = dockerignore_contract((workspace / ".dockerignore").read_text(encoding="utf-8"))
        if event_name == "pull_request":
            pr = event.get("pull_request") if isinstance(event, dict) else None
            if isinstance(pr, dict):
                base = pr.get("base") if isinstance(pr.get("base"), dict) else {}
                head = pr.get("head") if isinstance(pr.get("head"), dict) else {}
                base_repo = base.get("repo") if isinstance(base.get("repo"), dict) else {}
                head_repo = head.get("repo") if isinstance(head.get("repo"), dict) else {}
                if repo_name and base_repo.get("full_name") == repo_name and head_repo.get("full_name") == repo_name:
                    paths = _changed_paths(workspace, str(base.get("sha", "")), str(head.get("sha", "")))
    except (OSError, UnicodeError, ValueError, TypeError):
        event = {}
    required, reason = decide(event_name, event, repo_name, paths, ignore)
    count = len(paths) if paths is not None else None
    wrote = _write_outputs(os.environ.get("GITHUB_OUTPUT", ""), required, reason, count)
    # Keep logs value-free: no filenames, refs, event payload, command output or tokens.
    print(json.dumps({"docker_e2e_required": required, "reason": reason,
                      "changed_count": count, "output_written": wrote}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        # A qualification implementation error must not silently skip e2e.
        print(json.dumps({"docker_e2e_required": True, "reason": "selector_error_fail_open",
                          "changed_count": None, "output_written": False}, sort_keys=True))
        raise SystemExit(0)
