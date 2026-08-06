#!/bin/sh
# Loom, in one file.
#
# The whole product for a machine with no display is three bundled JavaScript
# files totalling ~280 KB, so this script carries them rather than fetching them.
# That is the difference between an installer and a set of instructions: nothing
# here needs git, npm, a package registry, a checkout, or a build on the target.
#
#   scp install-loom.sh server:
#   ssh server 'sh install-loom.sh'
#
# It also survives being piped — `curl … | sh` — which is why the payload lives in
# a variable rather than after a `__PAYLOAD__` marker read back from "$0". A piped
# script has no "$0" to read.
#
# What the machine must already have: a POSIX shell, and — only when it has no
# Node 22+ — curl or wget plus tar with xz to unpack one. Nothing else, and
# nothing outside $HOME is written.
#
# Undo the entire thing with: rm -rf ~/.loom
#
# POSIX sh, not bash: a minimal container or a BSD box may have no bash, and the
# shell an installer needs is the one that is definitely there.

set -eu

NODE_VERSION=v22.11.0
LOOM_HOME="${LOOM_HOME:-$HOME/.loom}"
BIN_DIR="$LOOM_HOME/bin"
APP_DIR="$LOOM_HOME/app"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------- find a runtime
# An existing Node is used when it is new enough. Installing a second copy beside
# a working one wastes 50 MB and creates two things to keep in step.
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 22 ]
}

install_node() {
  case "$(uname -s)" in
    Linux)  os=linux ;;
    Darwin) os=darwin ;;
    *) die "unsupported OS $(uname -s) — install Node 22+ yourself and rerun" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  cpu=x64 ;;
    aarch64|arm64) cpu=arm64 ;;
    *) die "unsupported CPU $(uname -m) — install Node 22+ yourself and rerun" ;;
  esac

  command -v tar >/dev/null 2>&1 || die 'tar is needed to unpack Node'
  command -v xz >/dev/null 2>&1 || die 'xz is needed to unpack Node (try: apt install xz-utils)'

  url="https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$os-$cpu.tar.xz"
  say "installing a private Node ($NODE_VERSION $os-$cpu) under $LOOM_HOME/node"
  mkdir -p "$LOOM_HOME/node"
  # --strip-components because the tarball has a versioned top directory, and
  # baking that name into every later path means a version bump breaks them all.
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" | tar -xJ -C "$LOOM_HOME/node" --strip-components=1
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$url" | tar -xJ -C "$LOOM_HOME/node" --strip-components=1
  else
    die 'neither curl nor wget is available, and Node must be downloaded'
  fi
}

if node_ok; then
  NODE=$(command -v node)
  say "using $NODE ($(node -v))"
elif [ -x "$LOOM_HOME/node/bin/node" ]; then
  NODE="$LOOM_HOME/node/bin/node"
  say "using the private Node already at $NODE"
else
  install_node
  NODE="$LOOM_HOME/node/bin/node"
fi

# ---------------------------------------------------------------- unpack it
# Decoded by Node rather than by `base64` and `gunzip`, because Node is the one
# thing guaranteed to be present by this line — we just made sure of it. `base64`
# takes -d on GNU and -D on macOS, and neither is worth a compatibility dance when
# a runtime with zlib built in is already sitting there.
say "installing to $APP_DIR"
mkdir -p "$APP_DIR" "$BIN_DIR"
printf '%s' "$PAYLOAD" | "$NODE" -e '
const { gunzipSync } = require("node:zlib");
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

let b64 = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { b64 += c; });
process.stdin.on("end", () => {
  const root = process.argv[1];
  const files = JSON.parse(gunzipSync(Buffer.from(b64, "base64")).toString("utf8"));
  for (const [rel, contents] of Object.entries(files)) {
    // Refused rather than sanitised: a payload trying to escape its directory is
    // not a path to clean up, it is a script that is not the one it claims to be.
    const target = resolve(root, rel);
    if (!target.startsWith(resolve(root))) throw new Error(`payload path escapes: ${rel}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  process.stdout.write(`${Object.keys(files).length} files\n`);
});
' "$APP_DIR"

cat > "$BIN_DIR/loom" <<EOF
#!/bin/sh
# Written by Loom's installer. Pins the runtime so a later PATH change, or a
# different Node becoming first, cannot alter which one runs the CLI.
exec "$NODE" "$APP_DIR/cli/loom.js" "\$@"
EOF
chmod +x "$BIN_DIR/loom"

# Proves the thing works before claiming it does, and catches a truncated
# download or a half-written payload here rather than at first use.
"$BIN_DIR/loom" --version >/dev/null || die 'installed, but the binary does not run'

say ''
say "installed: $BIN_DIR/loom  ($("$BIN_DIR/loom" --version))"
case ":$PATH:" in
  *":$BIN_DIR:"*) say 'already on your PATH' ;;
  *)
    # Printed rather than appended to a dotfile. Editing someone's shell
    # configuration without asking is the kind of thing an installer gets
    # remembered for, and the line is one they can read before running.
    say ''
    say 'add it to your PATH:'
    say ''
    say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile && . ~/.profile"
    ;;
esac
say ''
say 'then, in any directory you want an agent to work in:'
say ''
say '  loom run . --runtime echo "installed"    checks the wiring, needs no model'
say '  loom run . "summarise this repo"         one turn; 0 done, 1 failed, 2 try later'
say '  loom .                                   drive a session interactively'
say '  loom ls                                  what is running here'
say '  loom --help'
say ''
say 'a model other than Ollama on this machine:'
say '  LOOM_MODEL_BASE_URL=http://gpu-box:11434/v1 loom run . "..."'
say ''
say "remove everything with:  rm -rf $LOOM_HOME"
