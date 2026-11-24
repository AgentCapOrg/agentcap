#!/bin/sh
# Build and install AgentCap on a connected iPhone with a personal (free) or
# paid Apple team, without committing that team to the project.
#
#   ./run-on-device.sh <TEAM_ID> [bundle id]
#
# Personal-team builds default to dev.agentcap.app.dev so the real
# dev.agentcap.app stays free for the paid team. That identifier is also
# allowed on the agentcap-ios Privy client, so X sign-in works on the phone.
set -eu
team="${1:?usage: ./run-on-device.sh <TEAM_ID> [bundle id]}"
bundle="${2:-dev.agentcap.app.dev}"
cd "$(dirname "$0")"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

device=$(xcrun devicectl list devices 2>/dev/null | awk '/connected/ && !/simulated/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F-]{25,}$/) { print $i; exit } }')
[ -n "$device" ] || { echo "No iPhone connected. Plug it in, unlock it, tap Trust and turn on Developer Mode." >&2; exit 1; }

xcodegen generate >/dev/null
xcodebuild build -project AgentCap.xcodeproj -scheme AgentCap -configuration Debug \
  -destination "id=$device" -derivedDataPath build/Device -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Automatic PRODUCT_BUNDLE_IDENTIFIER="$bundle"
xcrun devicectl device install app --device "$device" build/Device/Build/Products/Debug-iphoneos/AgentCap.app
xcrun devicectl device process launch --device "$device" "$bundle"
