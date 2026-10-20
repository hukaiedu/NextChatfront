#!/usr/bin/env bash
# Executed over SSH as the unprivileged deployment user. No server-side npm/build.
set -Eeuo pipefail
umask 022
[[ $# == 5 ]] || { echo "usage: deploy.sh ROOT SHA PORT SERVICE UPLOAD_ID" >&2; exit 2; }
root=$1 sha=$2 port=$3 service=$4 upload_id=$5
[[ $root =~ ^/[a-zA-Z0-9/_-]+$ && $root != / && $root != *//* ]] || exit 2
[[ $sha =~ ^[a-f0-9]{40}$ && $port =~ ^[0-9]{1,5}$ && $service =~ ^[a-zA-Z0-9_-]+$ && $upload_id =~ ^[0-9]+-[0-9]+$ ]] || exit 2
(( 10#$port > 0 && 10#$port < 65536 )) || exit 2
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo "Linux x86_64 is required" >&2; exit 2; }
for command in python3 flock curl tar sudo systemctl sha256sum chmod; do command -v "$command" >/dev/null; done
mkdir -p "$root/releases"
exec 9>"$root/.deploy.lock"
flock -n 9 || { echo "Another deployment holds the server lock" >&2; exit 1; }
incoming="$root/incoming/$sha-$upload_id"
release="$root/releases/$sha-$upload_id"
[[ -d $incoming && ! -e $release && ! -L $release ]] || exit 2
(cd "$incoming" && sha256sum -c release.tgz.sha256)
# Reject archive path/link escapes before extracting. Node modules may contain safe relative links.
python3 - "$incoming/release.tgz" <<'ARCHIVE'
import sys,tarfile,posixpath
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for member in archive.getmembers():
        name=posixpath.normpath(member.name)
        if name.startswith('/') or name == '..' or name.startswith('../'):
            raise SystemExit('Unsafe archive path')
        if member.isdev() or member.isfifo(): raise SystemExit('Unsupported archive entry')
        if member.issym() or member.islnk():
            target=posixpath.normpath(posixpath.join(posixpath.dirname(name) if member.issym() else '',member.linkname))
            if member.linkname.startswith('/') or target == '..' or target.startswith('../'):
                raise SystemExit('Unsafe archive link')
ARCHIVE
mkdir "$release"
tar --no-same-owner -xzf "$incoming/release.tgz" -C "$release"
# GNU tar may restore the archive root's metadata over the freshly created
# directory. The service runs as a different user than the deploy account, so
# enforce a traversable/readable release root regardless of the archive mode.
chmod 0755 "$release"
python3 - "$release" "$sha" <<'MANIFEST'
import json,sys,os
root,sha=sys.argv[1:]
manifest=json.load(open(root+'/release.json'))
if manifest.get('sha')!=sha or manifest.get('platform')!='linux' or manifest.get('arch')!='x64' or not manifest.get('node','').startswith('24.'):
    raise SystemExit('Release identity/runtime mismatch')
if not all(os.path.isfile(root+'/'+p) for p in ['server.js','runtime/node','public/personchat-release.json']):
    raise SystemExit('Incomplete release')
if json.load(open(root+'/public/personchat-release.json')) != {'sha':sha}: raise SystemExit('Release marker mismatch')
MANIFEST
[[ $("$release/runtime/node" --version) == v24.* ]] || { echo "Bundled Node 24 is unavailable" >&2; exit 1; }
previous="" previous_sha=""
if [[ -L $root/current ]]; then
  previous=$(readlink "$root/current")
  [[ $previous == "$root/releases/"* && -d $previous ]] || { echo "Invalid current release" >&2; exit 1; }
  python3 - "$root/releases" "$previous" <<'PREVIOUS'
import os,sys
base,target=map(os.path.realpath,sys.argv[1:])
if target == base or os.path.commonpath([base,target]) != base:
    raise SystemExit('Previous release escapes the managed directory')
PREVIOUS
  previous_sha=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha"])' "$previous/release.json")
elif [[ -e $root/current ]]; then
  echo "current must be a managed symlink" >&2; exit 1
fi
# Next runtime cache is writable without allowing the service to rewrite application files.
rm -rf -- "$release/.next/cache"
ln -s /var/cache/personchat-front "$release/.next/cache"
restart_attempted=0
committed=0
switch_to() {
  local target=$1
  ln -s "$target" "$root/.current-$upload_id"
  mv -Tf "$root/.current-$upload_id" "$root/current"
}
# Local process checks: homepage, release marker, and the Next runtime proxy's
# anonymous session. Public /backend-api/ traffic goes Nginx -> backend directly;
# this loopback check does not validate that Nginx/TLS/public path.
healthy() {
  local expected=$1 attempt
  for attempt in {1..20}; do
    if systemctl is-active --quiet "$service" &&
      [[ $(curl -fsS --max-time 3 "http://127.0.0.1:$port/personchat-release.json" 2>/dev/null) == "{\"sha\":\"$expected\"}" ]] &&
      curl -fsS --max-time 3 "http://127.0.0.1:$port/" >/dev/null 2>&1 &&
      curl -fsS --compressed --max-time 3 "http://127.0.0.1:$port/backend-api/auth/session" 2>/dev/null |
        python3 -c 'import json,sys; value=json.load(sys.stdin); sys.exit(0 if isinstance(value.get("data",{}).get("authenticated"),bool) else 1)' 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
rollback_to_previous() {
  if switch_to "$previous" && sudo -n systemctl restart "$service" && healthy "$previous_sha"; then
    echo "Previous release restored" >&2
    return 0
  fi
  echo "ROLLBACK FAILED; operator intervention required" >&2
  return 1
}
on_exit() {
  local status=$?
  local current_target=""
  trap - EXIT
  # Do not let a second signal interrupt a rollback that restores consistency.
  trap '' INT TERM HUP
  if (( status != 0 && committed == 0 )); then
    if [[ -L $root/current ]]; then
      current_target=$(readlink "$root/current" 2>/dev/null || true)
    fi
    if [[ $current_target == "$release" ]]; then
      echo "Deployment failed; restoring previous release" >&2
      if [[ -n $previous ]]; then
        rollback_to_previous || true
      else
        # First deployment has no previous version. Stop the failed service and
        # remove current only if the stop actually succeeded.
        if sudo -n systemctl stop "$service"; then
          if [[ $(readlink "$root/current" 2>/dev/null || true) == "$release" ]]; then
            if ! rm "$root/current"; then
              echo "WARNING: failed to remove current after stopping the first deployment" >&2
            fi
          fi
          echo "No previous release; failed first deployment stopped" >&2
          echo "If the unit was enabled, run: sudo systemctl disable $service (see deploy/frontend-cd.md)" >&2
        else
          echo "ROLLBACK FAILED; could not stop the failed first deployment; operator intervention required" >&2
        fi
      fi
    elif [[ -n $previous && $current_target == "$previous" ]]; then
      if (( restart_attempted == 1 )); then
        # A restart may already have started another release before current was
        # changed back. Reconcile the service with the release current points to.
        if sudo -n systemctl restart "$service" && healthy "$previous_sha"; then
          echo "Service reconciled to the previous release" >&2
        else
          echo "ROLLBACK FAILED; operator intervention required" >&2
        fi
      else
        echo "Current still points to the previous release; nothing to roll back" >&2
      fi
    elif [[ -z $current_target && -z $previous ]]; then
      if (( restart_attempted == 1 )); then
        if sudo -n systemctl stop "$service"; then
          echo "No previous release and current is absent; stopped the service for consistency" >&2
        else
          echo "ROLLBACK FAILED; could not stop the service" >&2
        fi
      else
        echo "No previous release and current is not switched; nothing to roll back" >&2
      fi
    else
      echo "Current points to an unexpected release; automatic rollback refused; operator intervention required" >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
switch_to "$release"
restart_attempted=1
sudo -n systemctl restart "$service"
healthy "$sha"
# The new release has passed its local health checks. A later SSH/output
# failure must not roll back a verified deployment.
committed=1
# Test seam for release.test.mjs; never set in production.
if [[ ${TEST_FAIL_AFTER_COMMIT:-0} == 1 ]]; then
  echo "simulated post-commit failure" >&2
  false
fi
echo "Deployed $sha"
