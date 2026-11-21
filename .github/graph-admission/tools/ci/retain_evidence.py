#!/usr/bin/env python3
"""Retain CI evidence without GitHub Actions artifact storage (DEC-AUP-0191).

Evidence retention used to call actions/upload-artifact. On the Free plan private
repos that step fails when the monthly GB-hour allowance is exhausted; the job
verdict is already computed before the upload, so the upload was retention only.

This tool:

1. Resolves only the paths the caller declared (never walks the workspace).
2. Prints path, size and sha256 for every resolved file.
3. Prints JSON content inside a collapsed log group, bounded; never dumps a file
   that was not declared; never dumps binary / excluded trees (node_modules, .git,
   credential-shaped names).
4. Copies files under <root>/<owner>/<repo>/<run_id>-<attempt>/<name>/ when a
   persistent writable root is available (env AUP_CI_EVIDENCE_ROOT, else probed
   well-known host paths). A container-local path is not retention.
5. Always exits 0. Copy or probe failures are warnings + a step-summary line;
   they never turn a red gate green and never silence a red gate.

Secrets: the declared evidence producers (SelfCheckResult/v1, DecisionIdCheck/v1,
BundleDriftReport/v1, graph-admission-result JSON) do not write tokens. Directory
trees under stage-userpath/ and current-candidate/ are inventoried; JSON is dumped
under --max-log-bytes; small text evidence (*.exit, *.log, *.txt) is also printed
under a per-file and a total byte bound with the same key-redaction rules where a
line looks like key=value. Binary and other extensions stay inventory-only.
Without a host retention root, bytes beyond those bounds remain lost after the job.
"""
from __future__ import annotations

import argparse
import glob as globmod
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

TOOL = "tools/ci/retain_evidence.py"
VERSION = "1.1.0"
DEFAULT_MAX_LOG_BYTES = 65536
DEFAULT_MAX_TEXT_FILE_BYTES = 4096
DEFAULT_MAX_TEXT_TOTAL_BYTES = 65536
DEFAULT_ROOT_ENV = "AUP_CI_EVIDENCE_ROOT"
TEXT_EVIDENCE_SUFFIXES = {".exit", ".log", ".txt"}

# Well-known candidates Root may mount later. Never create them; only use if they
# already exist, are directories, and are writable by this process.
PROBE_ROOTS = (
    "/var/lib/aup-ci-evidence",
    "/opt/aup/ci-evidence",
    "/srv/ci-evidence",
)

# Paths that die with the job — never treat as retention.
EPHEMERAL_MARKERS = (
    "/_work/",
    "/actions-runner/_work/",
    "/runner/_work/",
)

SKIP_DIR_NAMES = {
    "node_modules",
    ".git",
    ".venv",
    "__pycache__",
    ".pnpm-store",
    ".turbo",
    "dist",
    "build",
    ".next",
    "target",
    "coverage",
}

SKIP_NAME_RE = re.compile(
    r"(^|\.)(env|pem|key|p12|pfx|credentials?|secret|token|password|passwd|auth)(\.|$)"
    r"|\.(env|pem|key|p12|pfx|credentials?)$",
    re.IGNORECASE,
)

SECRET_KEY_RE = re.compile(
    r"(token|secret|password|passwd|authorization|api[_-]?key|private[_-]?key|bearer)",
    re.IGNORECASE,
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            block = fh.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def is_ephemeral(path: Path) -> bool:
    text = str(path)
    if any(marker in text for marker in EPHEMERAL_MARKERS):
        return True
    # GitHub Actions runner.temp is always job-scoped.
    runner_temp = os.environ.get("RUNNER_TEMP") or os.environ.get("TMPDIR") or ""
    if runner_temp and text.startswith(str(Path(runner_temp).resolve()) + os.sep):
        return True
    return False


def resolve_retention_root(explicit: str | None) -> tuple[Path | None, str]:
    """Return (root, reason). root is None when only the job log retains evidence."""
    candidates: list[str] = []
    if explicit:
        candidates.append(explicit)
    env_root = os.environ.get(DEFAULT_ROOT_ENV, "").strip()
    if env_root and env_root not in candidates:
        candidates.append(env_root)
    for probe in PROBE_ROOTS:
        if probe not in candidates:
            candidates.append(probe)

    for raw in candidates:
        path = Path(raw)
        try:
            if not path.exists() or not path.is_dir():
                continue
            resolved = path.resolve()
            if is_ephemeral(resolved):
                continue
            probe = resolved / f".aup-retain-probe-{os.getpid()}"
            try:
                probe.write_text("ok\n", encoding="utf-8")
                probe.unlink(missing_ok=True)
            except OSError as exc:
                return None, f"root {resolved} exists but is not writable: {exc}"
            return resolved, f"writable root {resolved}"
        except OSError:
            continue
    return None, (
        "no persistent writable retention root "
        f"(set {DEFAULT_ROOT_ENV} to a host mount such as /var/lib/aup-ci-evidence)"
    )


def expand_declared(patterns: list[str]) -> list[Path]:
    """Expand only caller-declared globs/paths (stdlib glob; absolute patterns allowed)."""
    found: list[Path] = []
    seen: set[Path] = set()
    for pattern in patterns:
        if not pattern or "\x00" in pattern:
            raise ValueError(f"invalid evidence path pattern: {pattern!r}")
        if any(ch in pattern for ch in "*?[]"):
            matches = [Path(item) for item in sorted(globmod.glob(pattern, recursive=True))]
        else:
            p = Path(pattern)
            matches = [p] if p.exists() else []

        for match in matches:
            if match.is_dir():
                for child in walk_evidence_files(match):
                    resolved = child.resolve()
                    if resolved not in seen:
                        seen.add(resolved)
                        found.append(resolved)
            elif match.is_file() and not match.is_symlink():
                resolved = match.resolve()
                if resolved not in seen:
                    seen.add(resolved)
                    found.append(resolved)
    return found


def walk_evidence_files(root: Path) -> list[Path]:
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_NAMES and not SKIP_NAME_RE.search(d)]
        for name in filenames:
            if SKIP_NAME_RE.search(name):
                continue
            path = Path(dirpath) / name
            if path.is_symlink():
                continue
            if path.is_file():
                out.append(path)
    return sorted(out)


def redact_json(value):
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if SECRET_KEY_RE.search(str(key)):
                out[key] = "<redacted>"
            else:
                out[key] = redact_json(item)
        return out
    if isinstance(value, list):
        return [redact_json(item) for item in value]
    return value


def dump_json_for_log(path: Path, max_bytes: int) -> tuple[str, bool]:
    """Return (text, truncated). Only for .json files."""
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return "<binary-or-non-utf8: not printed>\n", True
    try:
        doc = json.loads(text)
    except json.JSONDecodeError:
        if len(raw) > max_bytes:
            kept = raw[:max_bytes].decode("utf-8", errors="replace")
            return (
                kept
                + f"\n… truncated kept={max_bytes} total={len(raw)}\n"
            ), True
        return text if text.endswith("\n") else text + "\n", False
    redacted = redact_json(doc)
    rendered = json.dumps(redacted, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    encoded = rendered.encode("utf-8")
    if len(encoded) > max_bytes:
        return (
            encoded[:max_bytes].decode("utf-8", errors="replace")
            + f"\n… truncated kept={max_bytes} total={len(encoded)}\n"
        ), True
    return rendered, False


def looks_binary(raw: bytes) -> bool:
    if b"\x00" in raw:
        return True
    # High ratio of non-text bytes ⇒ treat as binary; never dump.
    sample = raw[:4096]
    if not sample:
        return False
    nontext = sum(1 for b in sample if b < 9 or (13 < b < 32) or b == 127)
    return (nontext / len(sample)) > 0.30


def redact_text_lines(text: str) -> str:
    """Apply key-shaped redaction to key=value / key: value lines (same SECRET_KEY_RE)."""
    out: list[str] = []
    for line in text.splitlines(keepends=True):
        m = re.match(r"^(\s*)([A-Za-z0-9_.-]+)(\s*[=:]\s*)(.*?)(\s*)$", line.rstrip("\n"))
        if m and SECRET_KEY_RE.search(m.group(2)):
            newline = "\n" if line.endswith("\n") else ""
            out.append(f"{m.group(1)}{m.group(2)}{m.group(3)}<redacted>{newline}")
        else:
            out.append(line)
    return "".join(out)


def dump_text_for_log(path: Path, max_bytes: int) -> tuple[str, bool, int]:
    """Return (text, truncated, raw_size) for small text evidence suffixes."""
    raw = path.read_bytes()
    if looks_binary(raw):
        return f"<binary: not printed size={len(raw)}>\n", True, len(raw)
    try:
        decoded = raw.decode("utf-8")
    except UnicodeDecodeError:
        return f"<binary-or-non-utf8: not printed size={len(raw)}>\n", True, len(raw)
    redacted = redact_text_lines(decoded)
    encoded = redacted.encode("utf-8")
    if len(encoded) > max_bytes:
        kept = encoded[:max_bytes].decode("utf-8", errors="replace")
        return (
            kept + f"\n… truncated kept={max_bytes} total={len(encoded)}\n",
            True,
            len(raw),
        )
    if not redacted.endswith("\n"):
        redacted += "\n"
    return redacted, False, len(raw)


def copy_tree(files: list[Path], dest_root: Path, common_base: Path | None) -> list[str]:
    warnings: list[str] = []
    for src in files:
        try:
            if common_base is not None:
                try:
                    rel = src.relative_to(common_base)
                except ValueError:
                    rel = Path(src.name)
            else:
                rel = Path(src.name)
            dest = dest_root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
        except OSError as exc:
            warnings.append(f"copy failed for {src}: {exc}")
    return warnings


def append_summary(summary_path: str | None, lines: list[str]) -> None:
    if not summary_path:
        return
    try:
        with open(summary_path, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    except OSError as exc:
        print(f"::warning::retain_evidence: could not write step summary: {exc}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--name", required=True, help="evidence set name (was the artifact name)")
    ap.add_argument(
        "--path",
        action="append",
        dest="paths",
        required=True,
        help="declared evidence file, directory or glob (repeatable)",
    )
    ap.add_argument("--max-log-bytes", type=int, default=DEFAULT_MAX_LOG_BYTES)
    ap.add_argument(
        "--max-text-file-bytes",
        type=int,
        default=DEFAULT_MAX_TEXT_FILE_BYTES,
        help="per-file bound for *.exit/*.log/*.txt job-log dumps",
    )
    ap.add_argument(
        "--max-text-total-bytes",
        type=int,
        default=DEFAULT_MAX_TEXT_TOTAL_BYTES,
        help="total bound across all text evidence dumps in one retain invocation",
    )
    ap.add_argument("--summary", default=os.environ.get("GITHUB_STEP_SUMMARY"))
    ap.add_argument("--owner", default=(os.environ.get("GITHUB_REPOSITORY_OWNER") or "unknown-owner"))
    ap.add_argument(
        "--repo",
        default=(
            (os.environ.get("GITHUB_REPOSITORY") or "unknown/unknown").split("/", 1)[-1]
        ),
    )
    ap.add_argument("--run-id", default=os.environ.get("GITHUB_RUN_ID") or "0")
    ap.add_argument("--attempt", default=os.environ.get("GITHUB_RUN_ATTEMPT") or "1")
    ap.add_argument(
        "--retention-root",
        default=None,
        help=f"override {DEFAULT_ROOT_ENV}; when absent the env and probe list are used",
    )
    args = ap.parse_args(argv)

    print(f"retain_evidence {VERSION} name={args.name}")
    try:
        files = expand_declared(args.paths)
    except ValueError as exc:
        print(f"::warning::retain_evidence: {exc}")
        append_summary(args.summary, [
            f"### retain_evidence — {args.name}",
            f"- retention warning: {exc}",
            "- retained: job-log only",
        ])
        return 0

    if not files:
        msg = f"no evidence files found for {args.name} (declared {args.paths!r})"
        print(f"::warning::{msg}")
        append_summary(args.summary, [
            f"### retain_evidence — {args.name}",
            f"- {msg}",
            "- retained: job-log only",
        ])
        return 0

    declared_set = {f.resolve() for f in files}
    print(f"files={len(files)}")
    text_total_kept = 0
    for path in files:
        try:
            size = path.stat().st_size
            digest = sha256_file(path)
        except OSError as exc:
            print(f"::warning::retain_evidence: cannot read {path}: {exc}")
            continue
        print(f"evidence path={path} size={size} sha256={digest}")
        if path.suffix == ".json" and path.resolve() in declared_set:
            print(f"::group::evidence-json:{path.name}")
            text, truncated = dump_json_for_log(path, args.max_log_bytes)
            sys.stdout.write(text)
            if truncated:
                print(f"… truncated kept={args.max_log_bytes} total={size}")
            print("::endgroup::")
        elif path.suffix in TEXT_EVIDENCE_SUFFIXES and path.resolve() in declared_set:
            remaining = max(0, args.max_text_total_bytes - text_total_kept)
            per_file = min(args.max_text_file_bytes, remaining)
            print(f"::group::evidence-text:{path.name}")
            if per_file <= 0:
                print(
                    f"… truncated kept=0 total={size} "
                    f"(text total bound {args.max_text_total_bytes} already reached)"
                )
            else:
                text, truncated, raw_size = dump_text_for_log(path, per_file)
                sys.stdout.write(text)
                text_total_kept += min(len(text.encode("utf-8")), per_file)
                if truncated:
                    print(f"… truncated kept={per_file} total={raw_size}")
            print("::endgroup::")

    root, reason = resolve_retention_root(args.retention_root)
    summary_lines = [f"### retain_evidence — {args.name}", f"- files: {len(files)}"]
    warnings: list[str] = []

    if root is None:
        print(f"retained: job-log only ({reason})")
        summary_lines.append(f"- retained: job-log only ({reason})")
        summary_lines.append(
            "- needs-root: host mount at /var/lib/aup-ci-evidence "
            f"(or set {DEFAULT_ROOT_ENV}); must persist across jobs and be writable by the runner user"
        )
    else:
        dest = root / args.owner / args.repo / f"{args.run_id}-{args.attempt}" / args.name
        try:
            dest.mkdir(parents=True, exist_ok=True)
            # Prefer a common base so directory uploads keep relative layout.
            common_base = None
            try:
                common_base = Path(os.path.commonpath([str(p) for p in files]))
                if common_base.is_file():
                    common_base = common_base.parent
            except ValueError:
                common_base = None
            warnings.extend(copy_tree(files, dest, common_base))
            manifest = {
                "schema": "CiEvidenceRetention/v1",
                "tool": TOOL,
                "version": VERSION,
                "name": args.name,
                "owner": args.owner,
                "repo": args.repo,
                "run_id": str(args.run_id),
                "attempt": str(args.attempt),
                "files": [
                    {
                        "path": str(p),
                        "size": p.stat().st_size,
                        "sha256": sha256_file(p),
                    }
                    for p in files
                ],
            }
            (dest / "RETENTION.json").write_text(
                json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            print(f"retained: host-dir {dest}")
            summary_lines.append(f"- retained: host-dir `{dest}`")
        except OSError as exc:
            warnings.append(f"host retention failed: {exc}")
            print(f"::warning::retain_evidence: host retention failed: {exc}")
            print("retained: job-log only (host copy failed)")
            summary_lines.append(f"- retained: job-log only (host copy failed: {exc})")

    for warning in warnings:
        print(f"::warning::retain_evidence: {warning}")
        summary_lines.append(f"- retention warning: {warning}")

    append_summary(args.summary, summary_lines)
    # Retention never changes the job verdict.
    return 0


if __name__ == "__main__":
    sys.exit(main())
