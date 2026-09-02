#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${ROOT_DIR}/bin/jit-runner"
CONTROLLER="${ROOT_DIR}/bin/jit-runner-controller"
POOL_AGENT="${ROOT_DIR}/bin/jit-runner-pool-agent"
TEST_TMP="$(mktemp -d)"
PERMISSION_TEST_VOLUME=""
cleanup() {
  if [[ -n "$PERMISSION_TEST_VOLUME" ]]; then
    docker volume rm "$PERMISSION_TEST_VOLUME" >/dev/null 2>&1 || true
  fi
  rm -rf "$TEST_TMP"
}
trap cleanup EXIT

help_output="$($CLI --help)"
[[ "$help_output" == *"jit-runner provision"* ]]
[[ "$help_output" == *"jit-runner destroy"* ]]
[[ "$help_output" == *"jit-runner sweep"* ]]
[[ "$help_output" == *"jit-runner inventory"* ]]
[[ "$help_output" == *"jit-runner pool-cleanup"* ]]

controller_help="$($CONTROLLER --help)"
[[ "$controller_help" == *"jit-runner-controller --config"* ]]

pool_help="$($POOL_AGENT --help)"
[[ "$pool_help" == *"jit-runner-pool-agent"* ]]
[[ "$pool_help" == *"Docker-in-Docker"* ]]
grep -Fxq 'ProtectSystem=strict' "${ROOT_DIR}/providers/shared-host/jit-runner-pool-agent.service"
grep -Fxq 'StateDirectory=jit-runner-kit' "${ROOT_DIR}/providers/shared-host/jit-runner-pool-agent.service"
grep -Fxq 'StateDirectoryMode=0700' "${ROOT_DIR}/providers/shared-host/jit-runner-pool-agent.service"
grep -Fq 'useradd --create-home --uid 1001 --shell /bin/bash runner' \
  "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fxq 'ARG GH_VERSION=2.98.0' "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fxq 'ARG GH_SHA256_X64=3b8ac6b30336802fc1a858d7c084e11cdf24ac1a761ca90b68022d7d729208de' \
  "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fxq 'ARG GH_SHA256_ARM64=cf689084f3a3618f7eae4a2420d335d74626d65f5e594b9828d125d69f800d86' \
  "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fxq 'ARG RUSTUP_VERSION=1.28.2' "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fxq 'ARG RUSTUP_SHA256_X64=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c' \
  "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fxq 'ARG RUSTUP_SHA256_ARM64=e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c' \
  "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fxq 'ARG RUSTUP_LICENSE_MIT_SHA256=c9a75f18b9ab2927829a208fc6aa2cf4e63b8420887ba29cdb265d6619ae82d5' \
  "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fxq 'ARG RUSTUP_LICENSE_APACHE_SHA256=8173d5c29b4f956d532781d2b86e4e30f83e6b7878dce18c919451d6ba707c90' \
  "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
EXPECTED_GH_ARCHIVE="gh_\${GH_VERSION}_linux_\${gh_arch}.tar.gz"
EXPECTED_GH_CHECKSUM="echo \"\${gh_sha}  /tmp/gh.tar.gz\" | sha256sum --check --strict"
EXPECTED_GH_BINARY="--strip-components=2 \"gh_\${GH_VERSION}_linux_\${gh_arch}/bin/gh\""
EXPECTED_GH_LICENSE="--strip-components=1 \"gh_\${GH_VERSION}_linux_\${gh_arch}/LICENSE\""
grep -Fq "$EXPECTED_GH_ARCHIVE" \
  "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fq "$EXPECTED_GH_CHECKSUM" \
  "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fq -- "$EXPECTED_GH_BINARY" \
  "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fq 'chmod 0555 /usr/local/bin/gh' "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fq -- "$EXPECTED_GH_LICENSE" \
  "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fq 'chmod 0444 /usr/share/doc/gh/LICENSE' "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fq '&& gh --version' "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
EXPECTED_RUSTUP_URL="https://static.rust-lang.org/rustup/archive/\${RUSTUP_VERSION}/\${rustup_arch}-unknown-linux-gnu/rustup-init"
EXPECTED_RUSTUP_CHECKSUM="echo \"\${rustup_sha}  /tmp/rustup-init\" | sha256sum --check --strict"
EXPECTED_RUSTUP_PATH="PATH=/home/runner/.cargo/bin:\${PATH}"
grep -Fq "$EXPECTED_RUSTUP_URL" \
  "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fq "$EXPECTED_RUSTUP_CHECKSUM" \
  "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fq 'ENV CARGO_HOME=/home/runner/.cargo' "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fq "$EXPECTED_RUSTUP_PATH" "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fq '/home/runner/rustup-init --yes --profile minimal --default-toolchain none --no-modify-path' \
  "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fq '&& rustup --version' "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fq '/usr/share/doc/rustup/LICENSE-MIT' "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fq '/usr/share/doc/rustup/LICENSE-APACHE' "${ROOT_DIR}/providers/shared-host/Dockerfile.runner"
grep -Fq '| rustup |' "${ROOT_DIR}/THIRD_PARTY.md"
RUNNER_IMAGE_WORKFLOW="${ROOT_DIR}/.github/workflows/runner-image.yml"
grep -Fq "if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')" \
  "$RUNNER_IMAGE_WORKFLOW"
EXPECTED_RUNNER_IMAGE_LABELS="runs-on: [self-hosted, linux, x64, jit-runner, \"jit-run-\${{ github.run_id }}\"]"
grep -Fq "$EXPECTED_RUNNER_IMAGE_LABELS" \
  "$RUNNER_IMAGE_WORKFLOW"
test "$(awk '/^jobs:$/ { in_jobs=1; next } in_jobs && /^[^ ]/ { in_jobs=0 } in_jobs && /^  [a-zA-Z0-9_-]+:$/ { count++ } END { print count+0 }' "$RUNNER_IMAGE_WORKFLOW")" -eq 1
EXPECTED_JIT_CONFIG_PATH="\${job_dir}/jit-config"
grep -Fq "chmod 600 \"${EXPECTED_JIT_CONFIG_PATH}\"" "$POOL_AGENT"
grep -Fq "chown 1001:1001 \"${EXPECTED_JIT_CONFIG_PATH}\"" "$POOL_AGENT"
if grep -Fq "chmod 0644 \"${EXPECTED_JIT_CONFIG_PATH}\"" "$POOL_AGENT"; then
  printf 'pool JIT configuration must not be world-readable\n' >&2
  exit 1
fi
write_line="$(grep -nF "printf '%s' \"\$encoded_jit_config\" >\"${EXPECTED_JIT_CONFIG_PATH}\"" "$POOL_AGENT" | cut -d: -f1)"
chmod_line="$(grep -nF "chmod 600 \"${EXPECTED_JIT_CONFIG_PATH}\"" "$POOL_AGENT" | cut -d: -f1)"
chown_line="$(grep -nF "chown 1001:1001 \"${EXPECTED_JIT_CONFIG_PATH}\"" "$POOL_AGENT" | cut -d: -f1)"
((write_line < chmod_line && chmod_line < chown_line))
grep -Fq -- '--env DOCKER_TLS_CERTDIR=' "$POOL_AGENT"
grep -Fq -- '--entrypoint docker' "$POOL_AGENT"
grep -Fq -- '--host=tcp://docker:2375 info' "$POOL_AGENT"
# Match the pool agent's source literally rather than expanding its variable here.
# shellcheck disable=SC2016
if grep -Fq 'docker exec "$dind_name" docker info' "$POOL_AGENT"; then
  printf 'pool readiness must not rely on the DinD Unix socket\n' >&2
  exit 1
fi
[[ "$(grep -Fc 'docker rm --force --volumes' "$POOL_AGENT")" == 3 ]]
# Match the pool agent's source literally rather than expanding its variables here.
# shellcheck disable=SC2016
if grep -Eq 'docker rm --force (\$ids|"\$runner_name"|"\$dind_name")' "$POOL_AGENT"; then
  printf 'pool cleanup must remove anonymous container volumes\n' >&2
  exit 1
fi

if command -v docker >/dev/null; then
  PERMISSION_TEST_VOLUME="jit-runner-kit-permissions-$$"
  [[ "$PERMISSION_TEST_VOLUME" =~ ^jit-runner-kit-permissions-[0-9]+$ ]]
  docker volume create "$PERMISSION_TEST_VOLUME" >/dev/null
  permission_test_image="docker.io/library/alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce"
  docker run --rm --user root --mount "type=volume,src=${PERMISSION_TEST_VOLUME},dst=/state" \
    "$permission_test_image" sh -c "printf '%s' synthetic-jit-config >/state/jit-config; chmod 0600 /state/jit-config"
  docker run --rm --user 1001:1001 --mount "type=volume,src=${PERMISSION_TEST_VOLUME},dst=/state,readonly" \
    "$permission_test_image" sh -c 'test ! -r /state/jit-config'
  docker run --rm --user root --mount "type=volume,src=${PERMISSION_TEST_VOLUME},dst=/state" \
    "$permission_test_image" sh -c 'chown 1001:1001 /state/jit-config; chmod 0600 /state/jit-config'
  docker run --rm --user 1001:1001 --mount "type=volume,src=${PERMISSION_TEST_VOLUME},dst=/state,readonly" \
    "$permission_test_image" sh -c 'test -r /state/jit-config'
  docker run --rm --user 1002:1002 --mount "type=volume,src=${PERMISSION_TEST_VOLUME},dst=/state,readonly" \
    "$permission_test_image" sh -c 'test ! -r /state/jit-config'
  docker volume rm "$PERMISSION_TEST_VOLUME" >/dev/null
  PERMISSION_TEST_VOLUME=""
fi

set +e
pool_limit_output="$(JIT_POOL_CONTROLLER_URL=https://controller.example.test JIT_POOL_MAX_RUNNERS=3 "$POOL_AGENT" --once 2>&1)"
pool_limit_status=$?
set -e
[[ $pool_limit_status -ne 0 ]]
[[ "$pool_limit_output" == *"JIT_POOL_MAX_RUNNERS must not exceed 2"* ]]

mkdir -p "$TEST_TMP/pool-bin"
cat >"$TEST_TMP/pool-bin/curl" <<'MOCK_POOL_CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
output_file=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      output_file="$2"
      shift 2
      ;;
    --write-out)
      shift 2
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
[[ "$url" == */v1/pool/claim ]]
claim_count=0
if [[ -r "$MOCK_POOL_CLAIM_COUNT" ]]; then
  claim_count="$(<"$MOCK_POOL_CLAIM_COUNT")"
fi
claim_count=$((claim_count + 1))
printf '%s' "$claim_count" >"$MOCK_POOL_CLAIM_COUNT"
if [[ "$claim_count" == 1 ]]; then
  printf '{"job_key":"job-4242","encoded_jit_config":"synthetic-jit-config","expires_at":4102444800}' >"$output_file"
  printf '200'
else
  : >"$output_file"
  printf '204'
fi
MOCK_POOL_CURL
chmod +x "$TEST_TMP/pool-bin/curl"
cat >"$TEST_TMP/pool-bin/docker" <<'MOCK_POOL_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%q ' "$@" >>"$MOCK_POOL_DOCKER_LOG"
printf '\n' >>"$MOCK_POOL_DOCKER_LOG"
case "${1:-} ${2:-}" in
  "ps --all"|"network ls") exit 0 ;;
  "network create") printf 'synthetic-network\n'; exit 0 ;;
  "network rm"|"rm --force") exit 0 ;;
esac
if [[ "${1:-}" == exec ]]; then
  exit 0
fi
if [[ "${1:-}" == run ]]; then
  if [[ " $* " == *" --detach "* ]]; then
    printf 'synthetic-dind\n'
    exit 0
  fi
  if [[ " $* " == *" --entrypoint docker "* ]]; then
    [[ "$MOCK_POOL_NETWORK_READY" == true ]]
    exit
  fi
  exit 0
fi
exit 0
MOCK_POOL_DOCKER
chmod +x "$TEST_TMP/pool-bin/docker"
cat >"$TEST_TMP/pool-bin/sleep" <<'MOCK_POOL_SLEEP'
#!/usr/bin/env bash
exit 0
MOCK_POOL_SLEEP
chmod +x "$TEST_TMP/pool-bin/sleep"
cat >"$TEST_TMP/pool-bin/timeout" <<'MOCK_POOL_TIMEOUT'
#!/usr/bin/env bash
set -Eeuo pipefail
while [[ "${1:-}" == --* ]]; do
  shift
done
shift
exec "$@"
MOCK_POOL_TIMEOUT
chmod +x "$TEST_TMP/pool-bin/timeout"

run_pool_agent_case() {
  local case_name="$1"
  local network_ready="$2"
  local case_root="$TEST_TMP/pool-${case_name}"
  local output_file="$case_root/stdout"
  local error_file="$case_root/stderr"
  local status
  mkdir -p "$case_root/state/jobs"
  set +e
  PATH="$TEST_TMP/pool-bin:$PATH" \
    MOCK_POOL_CLAIM_COUNT="$case_root/claim-count" \
    MOCK_POOL_DOCKER_LOG="$case_root/docker.log" \
    MOCK_POOL_NETWORK_READY="$network_ready" \
    JIT_POOL_CONTROLLER_URL=https://controller.example.test \
    JIT_POOL_HOST_TOKEN=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
    JIT_POOL_MAX_RUNNERS=1 \
    JIT_POOL_STATE_ROOT="$case_root/state" \
    JIT_POOL_RUNNER_IMAGE=runner:test \
    JIT_POOL_DIND_IMAGE=dind:test \
    "$POOL_AGENT" --once >"$output_file" 2>"$error_file"
  status=$?
  set -e
  # The one-shot loop may observe the claimed background job while it is still
  # active (status 0 after wait) or after it has already finished (status 10
  # from the following no-content claim). Both outcomes are valid; the
  # assertions below verify the job result and cleanup rather than its timing.
  if [[ "$status" != 0 && "$status" != 10 ]]; then
    printf 'unexpected pool agent exit status: %s\n' "$status" >&2
    exit 1
  fi
  grep -Fq -- '--env DOCKER_TLS_CERTDIR=' "$case_root/docker.log"
  grep -Fq -- '--network jrk-4242 --entrypoint docker dind:test --host=tcp://docker:2375 info' \
    "$case_root/docker.log"
  if grep -Eq '^exec ' "$case_root/docker.log"; then
    printf 'pool readiness unexpectedly used docker exec\n' >&2
    exit 1
  fi
  grep -Fq -- 'rm --force --volumes jrk-runner-4242' "$case_root/docker.log"
  grep -Fq -- 'rm --force --volumes jrk-dind-4242' "$case_root/docker.log"
  grep -Fq -- 'network rm jrk-4242' "$case_root/docker.log"
  [[ ! -e "$case_root/state/jobs/job-4242" ]]
}

run_pool_agent_case ready true
grep -Fq -- 'runner:test' "$TEST_TMP/pool-ready/docker.log"
grep -Fq -- 'job=job-4242 phase=runner result=started' "$TEST_TMP/pool-ready/stdout"

run_pool_agent_case unreachable false
if grep -Fq -- 'runner:test' "$TEST_TMP/pool-unreachable/docker.log"; then
  printf 'runner started before network Docker readiness\n' >&2
  exit 1
fi
grep -Fq -- 'job=job-4242 phase=dind-ready result=failed' "$TEST_TMP/pool-unreachable/stderr"

set +e
invalid_output="$($CLI provision --repository 'not a repository' 2>&1)"
invalid_status=$?
set -e
[[ $invalid_status -ne 0 ]]
[[ "$invalid_output" == *"invalid GitHub repository"* ]]

mkdir -p "$TEST_TMP/bin"
export MOCK_CURL_LOG="$TEST_TMP/curl.log"
export MOCK_CURL_ARGS_LOG="$TEST_TMP/curl-args.log"
cat >"$TEST_TMP/bin/curl" <<'MOCK_CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
url="${*: -1}"
printf '%s\n' "$url" >>"$MOCK_CURL_LOG"
printf '%s\n' "$*" >>"$MOCK_CURL_ARGS_LOG"
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
    if [[ "$*" == *"managed_by=jit-runner-kit-pool"* ]]; then
      printf '{"servers":[]}'
    else
      printf '{"servers":[{"id":101,"labels":{"expires_at":"1"}},{"id":102,"labels":{"expires_at":"4102444800"}},{"id":103,"labels":{}}]}'
    fi
    ;;
  */firewalls) printf '{"firewalls":[]}' ;;
  */primary_ips) printf '{"primary_ips":[]}' ;;
  */ssh_keys) printf '{"ssh_keys":[]}' ;;
  */repos/owner/repository/actions/runners/[0-9]*) printf '204' ;;
  */servers/[0-9]*|*/firewalls/[0-9]*|*/primary_ips/[0-9]*|*/ssh_keys/[0-9]*) ;;
  */actions/runs\?status=queued\&per_page=20)
    printf '{"workflow_runs":[{"id":55,"event":"push","head_branch":"main","path":".github/workflows/ci.yml","head_repository":{"full_name":"owner/repository"}},{"id":56,"event":"pull_request","head_branch":"main","path":".github/workflows/ci.yml","head_repository":{"full_name":"fork/repository"}}]}'
    ;;
  */actions/runs\?status=in_progress\&per_page=20)
    printf '{"workflow_runs":[]}'
    ;;
  */actions/runs/55/jobs\?filter=latest\&per_page=100)
    printf '{"total_count":1,"jobs":[{"id":999,"status":"queued","labels":["self-hosted","linux","x64","jit-runner","jit-run-55"]}]}'
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
[[ "$sweep_output" == "would-delete manager=jit-runner-kit servers/101" ]]
[[ "$sweep_output" != *"102"* ]]
[[ "$sweep_output" != *"103"* ]]

inventory_output="$(PATH="$TEST_TMP/bin:$PATH" GITHUB_ACTIONS='' HCLOUD_TOKEN=test "$CLI" inventory)"
[[ "$inventory_output" == *$'ephemeral_servers=3\n'* ]]
[[ "$inventory_output" == *$'pool_servers=0\n'* ]]
[[ "$inventory_output" == *$'total=3'* ]]
set +e
PATH="$TEST_TMP/bin:$PATH" GITHUB_ACTIONS='' HCLOUD_TOKEN=test "$CLI" inventory --require-empty >/dev/null 2>&1
inventory_status=$?
set -e
[[ $inventory_status -ne 0 ]]

pool_preview="$(PATH="$TEST_TMP/bin:$PATH" GITHUB_ACTIONS='' HCLOUD_TOKEN=test \
  "$CLI" pool-cleanup --pool-id canary)"
[[ -z "$pool_preview" ]]
grep -Fq 'label_selector=managed_by=jit-runner-kit-pool,pool_id=canary' "$MOCK_CURL_ARGS_LOG"
set +e
pool_delete_output="$(PATH="$TEST_TMP/bin:$PATH" GITHUB_ACTIONS='' HCLOUD_TOKEN=test \
  "$CLI" pool-cleanup --pool-id canary --delete --confirmation WRONG 2>&1)"
pool_delete_status=$?
set -e
[[ $pool_delete_status -ne 0 ]]
[[ "$pool_delete_output" == *"pool cleanup requires exact confirmation: DELETE canary"* ]]

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
if grep -q 'StrictHostKeyChecking=no\|UserKnownHostsFile=/dev/null' "$CLI"; then
  printf 'credential-bearing SSH must authenticate the ephemeral host key\n' >&2
  exit 1
fi
grep -q 'StrictHostKeyChecking=yes' "$CLI"

cat >"$TEST_TMP/controller.json" <<EOF
{
  "repositories": ["owner/repository"],
  "trusted_events": ["push", "workflow_dispatch"],
  "trusted_branches": ["main"],
  "trusted_workflows": ["owner/repository/.github/workflows/ci.yml@refs/heads/main"],
  "state_root": "$TEST_TMP/controller-state"
}
EOF
controller_output="$(PATH="$TEST_TMP/bin:$PATH" GITHUB_ACTIONS='' JIT_RUNNER_GITHUB_TOKEN=test \
  "$CONTROLLER" --config "$TEST_TMP/controller.json" --once --dry-run)"
[[ "$controller_output" == "would-provision repository=owner/repository job=999 labels=jit-runner,jit-run-55" ]]

cat >"$TEST_TMP/controller-unsafe.json" <<EOF
{
  "repositories": ["owner/repository"],
  "trusted_events": ["pull_request_review"],
  "trusted_branches": ["main"],
  "trusted_workflows": ["owner/repository/.github/workflows/ci.yml@refs/heads/main"],
  "state_root": "$TEST_TMP/controller-unsafe-state"
}
EOF
set +e
unsafe_output="$(PATH="$TEST_TMP/bin:$PATH" GITHUB_ACTIONS='' JIT_RUNNER_GITHUB_TOKEN=test \
  "$CONTROLLER" --config "$TEST_TMP/controller-unsafe.json" --once --dry-run 2>&1)"
unsafe_status=$?
set -e
[[ $unsafe_status -ne 0 ]]
[[ "$unsafe_output" == *"must not include pull request events"* ]]

if grep -RniE 'atlasrepo|reposearchengine' \
  --exclude-dir=.git \
  --exclude=.git \
  --exclude=test-cli.sh \
  "$ROOT_DIR" >/dev/null; then
  printf 'application-specific content found in generic runner toolkit\n' >&2
  exit 1
fi

printf 'CLI tests passed\n'
