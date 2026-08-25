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
[[ "$help_output" == *"jit-runner inventory"* ]]

controller_help="$($CONTROLLER --help)"
[[ "$controller_help" == *"jit-runner-controller --config"* ]]

set +e
invalid_output="$($CLI provision --repository 'not a repository' 2>&1)"
invalid_status=$?
set -e
[[ $invalid_status -ne 0 ]]
[[ "$invalid_output" == *"invalid GitHub repository"* ]]

mkdir -p "$TEST_TMP/bin"
export MOCK_CURL_LOG="$TEST_TMP/curl.log"
cat >"$TEST_TMP/bin/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
url="${*: -1}"
printf '%s\n' "$url" >>"$MOCK_CURL_LOG"
if [[ "$*" == *"--request GET"* && "$url" =~ /(servers|firewalls|primary_ips|ssh_keys)/[0-9]+$ ]]; then
  exit 22
fi
case "$url" in
  https://api.ipify.org) printf '192.0.2.10' ;;
  */repos/actions/runner/releases/latest)
    printf '{"assets":[{"name":"actions-runner-linux-x64-test.tar.gz","browser_download_url":"https://example.invalid/runner.tar.gz","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}'
    ;;
  */generate-jitconfig)
    printf '{"encoded_jit_config":"test-jit-config","runner":{"id":888}}\n201'
    ;;
  */servers)
    printf '{"servers":[{"id":101,"labels":{"expires_at":"1"}},{"id":102,"labels":{"expires_at":"4102444800"}},{"id":103,"labels":{}}]}'
    ;;
  */firewalls) printf '{"firewalls":[]}' ;;
  */primary_ips) printf '{"primary_ips":[]}' ;;
  */ssh_keys) printf '{"ssh_keys":[]}' ;;
  */repos/owner/repository/actions/runners/[0-9]*) printf '204' ;;
  */servers/[0-9]*|*/firewalls/[0-9]*|*/primary_ips/[0-9]*|*/ssh_keys/[0-9]*) ;;
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
cat >"$TEST_TMP/bin/tofu" <<'MOCK_TOFU'
#!/usr/bin/env bash
if [[ -n "${MOCK_TOFU_LOG:-}" ]]; then
  printf '%s\n' "$*" >>"$MOCK_TOFU_LOG"
fi
for argument in "$@"; do
  case "$argument" in
    -state=*) state_file="${argument#-state=}" ;;
  esac
done
case " $* " in
  *" apply "*)
    if [[ -n "${MOCK_TOFU_FAIL_ONCE:-}" && ! -e "${MOCK_TOFU_FAIL_ONCE}.failed" ]]; then
      : >"${MOCK_TOFU_FAIL_ONCE}.failed"
      printf 'Error: error during placement (resource_unavailable)\n' >&2
      exit 1
    fi
    : >"$state_file"
    ;;
  *" output "*" public_ipv4 "*) printf '192.0.2.20' ;;
  *" output "*" server_id "*) printf '123' ;;
esac
exit 0
MOCK_TOFU
chmod +x "$TEST_TMP/bin/tofu"
cat >"$TEST_TMP/bin/ssh-keygen" <<'MOCK_SSH_KEYGEN'
#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == -f ]]; then
    key_file="$2"
    break
  fi
  shift
done
: >"$key_file"
printf 'ssh-ed25519 test-key test@runner\n' >"${key_file}.pub"
MOCK_SSH_KEYGEN
chmod +x "$TEST_TMP/bin/ssh-keygen"
printf '#!/usr/bin/env bash\nexit 255\n' >"$TEST_TMP/bin/ssh"
chmod +x "$TEST_TMP/bin/ssh"
printf '#!/usr/bin/env bash\nexit 0\n' >"$TEST_TMP/bin/sleep"
chmod +x "$TEST_TMP/bin/sleep"

sweep_output="$(PATH="$TEST_TMP/bin:$PATH" GITHUB_ACTIONS='' HCLOUD_TOKEN=test "$CLI" sweep --dry-run)"
[[ "$sweep_output" == "would-delete servers/101" ]]
[[ "$sweep_output" != *"102"* ]]
[[ "$sweep_output" != *"103"* ]]

inventory_output="$(PATH="$TEST_TMP/bin:$PATH" GITHUB_ACTIONS='' HCLOUD_TOKEN=test "$CLI" inventory)"
[[ "$inventory_output" == *$'servers=3\n'* ]]
[[ "$inventory_output" == *$'total=3'* ]]
set +e
PATH="$TEST_TMP/bin:$PATH" GITHUB_ACTIONS='' HCLOUD_TOKEN=test "$CLI" inventory --require-empty >/dev/null 2>&1
inventory_status=$?
set -e
[[ $inventory_status -ne 0 ]]

mkdir -p "$TEST_TMP/destroy-state"
PATH="$TEST_TMP/bin:$PATH" GITHUB_ACTIONS='' HCLOUD_TOKEN=test JIT_RUNNER_GITHUB_TOKEN=test \
  "$CLI" destroy \
    --state-dir "$TEST_TMP/destroy-state" \
    --run-key test-run \
    --repository owner/repository \
    --runner-id 777 >/dev/null
grep -q '/repos/owner/repository/actions/runners/777$' "$MOCK_CURL_LOG"

set +e
provision_output="$(PATH="$TEST_TMP/bin:$PATH" GITHUB_ACTIONS='' HCLOUD_TOKEN=test \
  MOCK_TOFU_FAIL_ONCE="$TEST_TMP/tofu-apply" \
  MOCK_TOFU_LOG="$TEST_TMP/tofu.log" \
  JIT_RUNNER_GITHUB_TOKEN=test "$CLI" provision --repository owner/repository \
  --run-id 123 --state-dir "$TEST_TMP/failed-provision-state" \
  --fallback-locations nbg1,hel1 2>&1)"
provision_status=$?
set -e
[[ $provision_status -ne 0 ]]
[[ "$provision_output" == *"provisioning failed; removing temporary resources"* ]]
[[ "$provision_output" == *"retrying apply"* ]]
[[ "$provision_output" == *"trying provider location nbg1"* ]]
[[ "$provision_output" != *"unbound variable"* ]]
grep -q -- '-var=location=fsn1' "$TEST_TMP/tofu.log"
grep -q -- '-var=location=nbg1' "$TEST_TMP/tofu.log"
grep -q '/repos/owner/repository/actions/runners/888$' "$MOCK_CURL_LOG"

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
