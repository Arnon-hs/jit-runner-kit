#!/usr/bin/env bash
set -Eeuo pipefail

[[ -r /run/jit-config ]] || {
  printf 'missing JIT configuration\n' >&2
  exit 1
}

encoded_jit_config="$(</run/jit-config)"
[[ -n "$encoded_jit_config" ]] || {
  printf 'empty JIT configuration\n' >&2
  exit 1
}

cd /opt/actions-runner
exec ./run.sh --jitconfig "$encoded_jit_config" --disableupdate
