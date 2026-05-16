#!/usr/bin/env bash
# CONN-0104 — E2E PROD smoke for /v1/speech/stt/async (faster-whisper self-hosted).
#
# Submits a small fixture, polls the job until it reaches a terminal state,
# and asserts that the transcription is non-empty (and, when MC_FIXTURE_MARKER
# is set, contains the expected marker substring).
#
# Required env:
#   MC_KEY            Model Connector API key (Bearer)
# Optional env:
#   MC_BASE_URL       Default https://connector.arcanada.one
#   MC_FIXTURE_PATH   Default ./scripts/fixtures/smoke-stt.mp3
#   MC_FIXTURE_LANG   Default en
#   MC_FIXTURE_MARKER Substring required in transcription (optional)
#   MC_POLL_TIMEOUT_S Default 60
#   MC_POLL_INTERVAL_S Default 5
#
# Exit codes:
#   0   completed within timeout, transcription non-empty (+ marker match if set)
#   1   missing prerequisite (key, fixture, curl, jq)
#   2   submission failed (non-202 HTTP status)
#   3   polling timed out
#   4   job ended in failed state
#   5   transcription empty / marker missing

set -euo pipefail

: "${MC_KEY:?MC_KEY env required (Model Connector Bearer token)}"
MC_BASE_URL="${MC_BASE_URL:-https://connector.arcanada.one}"
MC_FIXTURE_PATH="${MC_FIXTURE_PATH:-./scripts/fixtures/smoke-stt.mp3}"
MC_FIXTURE_LANG="${MC_FIXTURE_LANG:-en}"
MC_FIXTURE_MARKER="${MC_FIXTURE_MARKER:-}"
MC_POLL_TIMEOUT_S="${MC_POLL_TIMEOUT_S:-60}"
MC_POLL_INTERVAL_S="${MC_POLL_INTERVAL_S:-5}"

for bin in curl jq; do
  if ! command -v "$bin" > /dev/null 2>&1; then
    echo "ERR: $bin not found in PATH" >&2
    exit 1
  fi
done

if [ ! -f "$MC_FIXTURE_PATH" ]; then
  echo "ERR: fixture not found at $MC_FIXTURE_PATH" >&2
  echo "Set MC_FIXTURE_PATH to any supported audio file (mp3, wav, m4a, …)." >&2
  exit 1
fi

echo "Submitting $MC_FIXTURE_PATH to $MC_BASE_URL/v1/speech/stt/async"

http_status_file=$(mktemp)
body_file=$(mktemp)
trap 'rm -f "$http_status_file" "$body_file"' EXIT

curl -sS -o "$body_file" -w '%{http_code}' \
  -X POST "$MC_BASE_URL/v1/speech/stt/async" \
  -H "Authorization: Bearer $MC_KEY" \
  -F "file=@$MC_FIXTURE_PATH" \
  -F "language=$MC_FIXTURE_LANG" \
  > "$http_status_file"

http_status=$(cat "$http_status_file")
if [ "$http_status" != "202" ]; then
  echo "ERR: submission expected HTTP 202, got $http_status" >&2
  cat "$body_file" >&2
  exit 2
fi

job_id=$(jq -r '.job_id // empty' < "$body_file")
status_url=$(jq -r '.status_url // empty' < "$body_file")
if [ -z "$job_id" ] || [ -z "$status_url" ]; then
  echo "ERR: response missing job_id/status_url" >&2
  cat "$body_file" >&2
  exit 2
fi
echo "Submitted: job_id=$job_id"

deadline=$(( $(date +%s) + MC_POLL_TIMEOUT_S ))
final_body=""
final_status=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  poll_body=$(curl -sS -H "Authorization: Bearer $MC_KEY" "$status_url")
  poll_status=$(echo "$poll_body" | jq -r '.status // empty')
  echo "  status=$poll_status"
  if [ "$poll_status" = "completed" ] || [ "$poll_status" = "failed" ]; then
    final_body=$poll_body
    final_status=$poll_status
    break
  fi
  sleep "$MC_POLL_INTERVAL_S"
done

if [ -z "$final_status" ]; then
  echo "ERR: polling timed out after ${MC_POLL_TIMEOUT_S}s" >&2
  exit 3
fi

if [ "$final_status" = "failed" ]; then
  echo "ERR: job failed" >&2
  echo "$final_body" | jq . >&2
  exit 4
fi

transcription=$(echo "$final_body" | jq -r '.result.transcription // empty')
if [ -z "$transcription" ]; then
  echo "ERR: transcription empty" >&2
  echo "$final_body" | jq . >&2
  exit 5
fi

if [ -n "$MC_FIXTURE_MARKER" ]; then
  case "$transcription" in
    *"$MC_FIXTURE_MARKER"*) ;;
    *)
      echo "ERR: transcription missing marker '$MC_FIXTURE_MARKER'" >&2
      echo "$transcription" >&2
      exit 5
      ;;
  esac
fi

provider=$(echo "$final_body" | jq -r '.result.provider // "?"')
duration=$(echo "$final_body" | jq -r '.result.duration_seconds // "?"')
echo "OK: provider=$provider duration=${duration}s"
echo "Transcription preview: ${transcription:0:120}"
