#!/bin/zsh
# Creates /Applications/Recall.app (start + open) and "Stop Recall.app".
# Re-run this script if you move the project folder.
set -e
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="/Applications"

make_icon() { # app path — builds AppIcon.icns from public/favicon.svg
  local tmp="$(mktemp -d)"; local set="$tmp/AppIcon.iconset"
  mkdir -p "$set" "$1/Contents/Resources"
  # Shrink the logo inside the canvas so it matches the size of other macOS icons.
  sed 's/viewBox="0 0 64 64"/viewBox="-7.75 -7.75 79.5 79.5"/' "$PROJECT/public/favicon.svg" > "$tmp/icon.svg"
  qlmanage -t -s 1024 -o "$tmp" "$tmp/icon.svg" >/dev/null 2>&1
  for s in 16 32 128 256 512; do
    sips -z $s $s "$tmp/icon.svg.png" --out "$set/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$tmp/icon.svg.png" --out "$set/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$set" -o "$1/Contents/Resources/AppIcon.icns"
  rm -rf "$tmp"
}

make_app() { # name, body
  local app="$DEST/$1.app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS"
  cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$1</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIdentifier</key><string>local.recall.$(echo "$1" | tr -d ' ' | tr A-Z a-z)</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleIconFile</key><string>AppIcon</string>
</dict></plist>
EOF
  make_icon "$app"
  { echo '#!/bin/zsh'
    echo 'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"'
    echo "cd \"$PROJECT\" || exit 1"
    echo "$2"
  } > "$app/Contents/MacOS/launch"
  chmod +x "$app/Contents/MacOS/launch"
}

make_app "Recall" '
URL=http://127.0.0.1:4317
LOG="$HOME/Library/Logs/Recall.log"
if ! curl -s -o /dev/null "$URL"; then
  # Rebuild the frontend if it is missing or older than the source.
  if [ ! -f dist/index.html ] || [ -n "$(find src shared index.html -newer dist/index.html 2>/dev/null | head -1)" ]; then
    npm run build >> "$LOG" 2>&1 || echo "Build failed, using previous build" >> "$LOG"
  fi
  nohup node server/index.ts --no-open >> "$LOG" 2>&1 &
  for i in {1..40}; do curl -s -o /dev/null "$URL" && break; sleep 0.25; done
fi
open "$URL"
'

make_app "Stop Recall" '
pkill -f "node server/index.ts" && osascript -e "display notification \"Recall stopped\" with title \"Recall\""
'

echo "Created $DEST/Recall.app and $DEST/Stop Recall.app"
