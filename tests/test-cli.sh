#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${ROOT_DIR}/bin/jit-runner"
CONTROLLER="${ROOT_DIR}/bin/jit-runner-controller"
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

help_output="$($CLI --help)"
[[ "$help_output" == *"jit-runner provision"* ]]
[[ "$help_output" == *"jit-runner destroy"* ]]
[[ "$help_output" == *"jit-runner sweep"* ]]

controller_help="$($CONTROLLER --help)"
[[ "$controller_help" == *"jit-runner-controller --config"* ]]

set +e
invalid_output="$($CLI provision --repository 'not a repository' 2>&1)"
invalid_status=$?
set -e
[[ $invalid_status -ne 0 ]]
[[ "$invalid_output" == *"invalid GitHub repository"* ]]

mkdir -p "$TEST_TMP/bin"
cat >"$TEST_TMP/bin/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
url="${*: -1}"
case "$url" in
  */servers)
    printf '{"servers":[{"id":101,"labels":{"expires_at":"1"}},{"id":102,"labels":{"expires_at":"4102444800"}},{"id":103,"labels":{}}]}'
    ;;
  */firewalls) printf '{"firewalls":[]}' ;;
  */primary_ips) printf '{"primary_ips":[]}' ;;
  */ssh_keys) printf '{"ssh_keys":[]}' ;;
  */actions/runs\?status=queued\&per_page=20)
    printf '{"workflow_runs":[{"id":55}]}'
    ;;
  */actions/runs\?status=in_progress\&per_page=20)
    printf '{"workflow_runs":[]}'
    ;;
  */actions/runs/55/jobs\?filter=latest\&per_page=100)
    printf '{"jobs":[{"id":999,"status":"queued","labels":["self-hosted","linux","x64","jit-runner"]}]}'
    ;;
  *) printf 'unexpected mock URL: %s\n' "$url" >&2; exit 1 ;;
esac
MOCK_CURL
chmod +x "$TEST_TMP/bin/curl"

sweep_output="$(PATH="$TEST_TMP/bin:$PATH" GITHUB_ACTIONS='' HCLOUD_TOKEN=test "$CLI" sweep --dry-run)"
[[ "$sweep_output" == "would-delete servers/101" ]]
[[ "$sweep_output" != *"102"* ]]
[[ "$sweep_output" != *"103"* ]]

cat >"$TEST_TMP/controller.json" <<EOF
{
  "repositories": ["owner/repository"],
  "state_root": "$TEST_TMP/controller-state"
}
EOF
controller_output="$(PATH="$TEST_TMP/bin:$PATH" GITHUB_ACTIONS='' JIT_RUNNER_GITHUB_TOKEN=test \
  "$CONTROLLER" --config "$TEST_TMP/controller.json" --once --dry-run)"
[[ "$controller_output" == "would-provision repository=owner/repository job=999 label=jit-runner" ]]

if grep -RniE 'atlasrepo|reposearchengine' \
  --exclude-dir=.git \
  --exclude=test-cli.sh \
  "$ROOT_DIR" >/dev/null; then
  printf 'application-specific content found in generic runner toolkit\n' >&2
  exit 1
fi

printf 'CLI tests passed\n'
