#!/bin/sh
# Builds the app, installs it on the TV and (re)launches it.
#   tools/deploy.sh          release build (signs in on the TV with a plex.tv/link code)
#   tools/deploy.sh --dev    also embeds the token from ~/.secrets/plex.env (dev-config.js)
#   tools/deploy.sh --no-launch
# Dev builds hold a token, so they are built outside ~/projects (Syncthing): ~/.cache/plexlite.
set -eu

HERE=$(cd "$(dirname "$0")/.." && pwd)
APP_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$HERE/appinfo.json")
BUILD="${PLEXLITE_BUILD:-$HOME/.cache/plexlite}"
DEV=0
LAUNCH=1
for a in "$@"; do
    case "$a" in
        --dev) DEV=1 ;;
        --no-launch) LAUNCH=0 ;;
        *) echo "unknown option $a" >&2; exit 2 ;;
    esac
done

mkdir -p "$BUILD"
chmod 700 "$BUILD"
STAMP=$(date +%Y%m%d%H%M%S)
printf '%s\n' "$STAMP" > "$BUILD/build.txt"
EXTRA="build.txt=$BUILD/build.txt"

if [ "$DEV" = 1 ]; then
    python3 - "$BUILD/dev-config.js" <<'EOF'
import json, os, sys
env = dict(l.strip().split("=", 1) for l in open(os.path.expanduser("~/.secrets/plex.env")) if "=" in l)
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, ("window.PL_DEV = " + json.dumps({"token": env["PLEX_TOKEN"], "clientId": env["PLEX_CLIENT_ID"]}) + ";\n").encode())
os.close(fd)
EOF
    EXTRA="$EXTRA js/dev-config.js=$BUILD/dev-config.js"
fi

# shellcheck disable=SC2086
python3 "$HERE/tools/build-ipk.py" "$BUILD/$APP_ID.ipk" --extra $EXTRA

ssh lgtv "cat > /tmp/$APP_ID.ipk" < "$BUILD/$APP_ID.ipk"
ssh lgtv sh -s "$APP_ID" "$STAMP" "$LAUNCH" <<'EOF'
APP_ID=$1; STAMP=$2; LAUNCH=$3
DIR=/media/developer/apps/usr/palm/applications/$APP_ID
# dev packages carry the token: never leave one behind, even when the install fails
trap 'rm -f /tmp/$APP_ID.ipk' EXIT
luna-send -n 1 luna://com.webos.applicationManager/close "{\"id\":\"$APP_ID\"}" </dev/null >/dev/null 2>&1
luna-send -n 6 -w 30000 luna://com.webos.appInstallService/dev/install \
    "{\"id\":\"$APP_ID\",\"ipkUrl\":\"/tmp/$APP_ID.ipk\",\"subscribe\":true}" </dev/null > /tmp/$APP_ID.install.log 2>&1 &
i=0
while [ "$(cat "$DIR/build.txt" 2>/dev/null)" != "$STAMP" ]; do
    i=$((i + 1))
    if [ $i -gt 60 ]; then
        echo "install did not finish in 30s:"; cat /tmp/$APP_ID.install.log; exit 1
    fi
    usleep 500000
done
kill %1 2>/dev/null
rm -f /tmp/$APP_ID.ipk
echo "installed build $STAMP"
if [ "$LAUNCH" = 1 ]; then
    sleep 1
    luna-send -n 1 luna://com.webos.applicationManager/launch "{\"id\":\"$APP_ID\"}" </dev/null > /tmp/$APP_ID.launch.log 2>&1
    grep -q '"returnValue":true' /tmp/$APP_ID.launch.log && echo "launched" || { echo "launch failed:"; cat /tmp/$APP_ID.launch.log; }
fi
EOF
