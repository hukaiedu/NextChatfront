#!/usr/bin/env bash
set -Eeuo pipefail
: "${FRONTEND_DEPLOY_HOST:?}" "${FRONTEND_DEPLOY_USER:?}" "${FRONTEND_SSH_KEY:?}" "${FRONTEND_KNOWN_HOSTS:?}" "${GITHUB_SHA:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${RUNNER_TEMP:?}"
ssh_port=${FRONTEND_SSH_PORT:-22}
root=${FRONTEND_DEPLOY_ROOT:-/opt/personchat-front}
port=${FRONTEND_PORT:-3000}
service=${FRONTEND_SERVICE:-personchat-front}
[[ $FRONTEND_DEPLOY_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ && $FRONTEND_DEPLOY_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || exit 2
[[ $root =~ ^/[a-zA-Z0-9/_-]+$ && $root != / && $root != *//* && $service =~ ^[a-zA-Z0-9_-]+$ ]] || exit 2
[[ $GITHUB_SHA =~ ^[a-f0-9]{40}$ && $GITHUB_RUN_ID =~ ^[0-9]+$ && $GITHUB_RUN_ATTEMPT =~ ^[0-9]+$ ]] || exit 2
[[ $ssh_port =~ ^[0-9]{1,5}$ && $port =~ ^[0-9]{1,5}$ ]] || exit 2
(( 10#$port > 0 && 10#$port < 65536 && 10#$ssh_port > 0 && 10#$ssh_port < 65536 )) || exit 2
# The private key is written before ssh/scp use it. Do not expose it through
# the runner's default umask, even briefly.
umask 077
keys=$(mktemp -d "$RUNNER_TEMP/frontend-ssh-XXXXXX")
trap 'rm -rf -- "$keys"' EXIT
chmod 700 "$keys"
printf '%s\n' "$FRONTEND_SSH_KEY" > "$keys/key"
printf '%s\n' "$FRONTEND_KNOWN_HOSTS" > "$keys/known_hosts"
chmod 600 "$keys/key" "$keys/known_hosts"
lookup=$FRONTEND_DEPLOY_HOST
if [[ $ssh_port != 22 ]]; then lookup="[$lookup]:$ssh_port"; fi
ssh-keygen -F "$lookup" -f "$keys/known_hosts" >/dev/null
options=(-F /dev/null -i "$keys/key" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$keys/known_hosts" -o ConnectTimeout=15)
target="$FRONTEND_DEPLOY_USER@$FRONTEND_DEPLOY_HOST"
upload_id="$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
incoming="$root/incoming/$GITHUB_SHA-$upload_id"
ssh "${options[@]}" -p "$ssh_port" "$target" "mkdir -p '$incoming'"
scp "${options[@]}" -P "$ssh_port" "$RUNNER_TEMP/frontend-release/release.tgz" "$RUNNER_TEMP/frontend-release/release.tgz.sha256" "$target:$incoming/"
ssh "${options[@]}" -p "$ssh_port" "$target" "bash -s -- '$root' '$GITHUB_SHA' '$port' '$service' '$upload_id'" < scripts/cd/deploy.sh
