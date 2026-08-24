#!/usr/bin/env bash
set -Eeuo pipefail

: "${JIT_CONFIG:?JIT_CONFIG is required}"
: "${RUNNER_ASSET_URL:?RUNNER_ASSET_URL is required}"
: "${RUNNER_ASSET_SHA256:?RUNNER_ASSET_SHA256 is required}"

install_dir=/opt/actions-runner
archive=/tmp/actions-runner.tar.gz
log_file=/var/log/jit-runner.log

install -d -o runner -g runner "$install_dir"
curl --fail-with-body --location --silent --show-error "$RUNNER_ASSET_URL" --output "$archive"
printf '%s  %s\n' "$RUNNER_ASSET_SHA256" "$archive" | sha256sum --check --status
tar -xzf "$archive" -C "$install_dir"
chown -R runner:runner "$install_dir"
rm -f "$archive"

cd "$install_dir"
nohup runuser -u runner -- ./run.sh --jitconfig "$JIT_CONFIG" >"$log_file" 2>&1 </dev/null &
printf 'runner process started with pid %s\n' "$!"

