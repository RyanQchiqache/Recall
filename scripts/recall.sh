#!/bin/sh
# Start Recall from a terminal on Linux or macOS (or from a desktop shortcut).
#   scripts/recall.sh            start Recall, or open the running one
#   scripts/recall.sh --stop     stop Recall
# Other options: --port N, --data-dir DIR, --no-open
cd "$(dirname "$0")/.." || exit 1

node_ok() {
  "$1" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' 2>/dev/null
}

NODE=""
OLD=""
for c in "$(command -v node 2>/dev/null)" \
  /opt/homebrew/opt/node@24/bin/node /opt/homebrew/bin/node /usr/local/opt/node@24/bin/node /usr/local/bin/node /usr/bin/node \
  "$HOME/.volta/bin/node" "$HOME/.local/share/fnm/aliases/default/bin/node" "$HOME/Library/Application Support/fnm/aliases/default/bin/node" \
  "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -n "$c" ] && [ -x "$c" ] || continue
  if node_ok "$c"; then NODE="$c"; break; fi
  [ -z "$OLD" ] && OLD="$("$c" -v 2>/dev/null)"
done

if [ -z "$NODE" ]; then
  if [ -n "$OLD" ]; then
    echo "Recall needs Node.js 24 to run. This computer has Node.js ${OLD#v}, which is too old." >&2
  else
    echo "Recall needs Node.js 24 to run, and it is not installed." >&2
  fi
  echo "Install Node.js 24 LTS from https://nodejs.org (on macOS with Homebrew: brew install node@24), then try again." >&2
  exit 1
fi

exec "$NODE" server/launcher.ts "$@"
