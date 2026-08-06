#!/bin/sh
# Install the Loom CLI on a machine with no GUI.
#
# Run from a checkout:  ./scripts/install.sh
#
# Two things are deliberate here.
#
# **It brings its own Node if the machine has none.** The whole point of a server
# install is that the server is someone else's, or shared, or locked down. An
# installer whose first instruction is "ask an administrator for Node 22" is one
# that does not work where it is most needed, so a private runtime goes under
# ~/.loom/node — nothing system-wide, no sudo, and removable with `rm -rf`. This
# is the same pinned version and the same location the app's own remote bootstrap
# uses, so a machine set up either way ends up identical.
#
# **It never writes outside $HOME.** No /usr/local, no package manager, no
# service registration. Everything it does is undone by deleting two directories,
# which is the property that makes it safe to run on a machine you do not own.
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
    die 'neither curl nor wget is available'
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

# ------------------------------------------------------------------- build here
# Built rather than downloaded because there is no published release: the
# repository is private, so a `curl | sh` one-liner would need a token in the URL,
# which is a worse thing to put in someone's shell history than a git clone.
SRC=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ -f "$SRC/package.json" ] || die "run this from a Loom checkout (looked in $SRC)"

say 'building'
cd "$SRC"

# The runtime goes on PATH for the build, not just used by path. npm is a script
# with `#!/usr/bin/env node`, and so are half the build's binaries -- calling
# `$LOOM_HOME/node/bin/npm` directly on a machine with no system Node fails with
#
#   /usr/bin/env: 'node': No such file or directory
#
# which reads as "Node was not installed" immediately after installing it.
PATH="$(dirname "$NODE"):$PATH"
export PATH
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM=npm
# Electron is a devDependency the build tools sit beside, but its ~100 MB binary
# is downloaded by a postinstall hook and is pure waste on a machine that will
# never open a window. Skipping the binary leaves the package present, which is
# all the build needs.
ELECTRON_SKIP_BINARY_DOWNLOAD=1 "$NPM" install --silent --no-audit --no-fund
"$NPM" run build --silent

# ------------------------------------------------------------------- lay it out
# Mirrors the `dist/` layout rather than flattening it, because the CLI finds the
# session host relative to itself. Copying the two files somewhere tidier is
# exactly how that lookup breaks.
mkdir -p "$APP_DIR" "$BIN_DIR"
rm -rf "$APP_DIR/cli" "$APP_DIR/main"
cp -R "$SRC/dist/cli" "$APP_DIR/cli"
cp -R "$SRC/dist/main" "$APP_DIR/main"

cat > "$BIN_DIR/loom" <<EOF
#!/bin/sh
# Written by Loom's installer. Pins the runtime so a later PATH change, or a
# different Node becoming first, cannot alter which one runs the CLI.
exec "$NODE" "$APP_DIR/cli/loom.js" "\$@"
EOF
chmod +x "$BIN_DIR/loom"

say ''
say "installed: $BIN_DIR/loom"
case ":$PATH:" in
  *":$BIN_DIR:"*) say 'already on your PATH' ;;
  *)
    # Printed rather than appended to a dotfile. Editing someone's shell
    # configuration without asking is the kind of thing an installer gets
    # remembered for, and the line is one they can read before running.
    say 'add it to your PATH:'
    say ""
    say "  echo 'export PATH=\"\$HOME/.loom/bin:\$PATH\"' >> ~/.profile"
    ;;
esac
say ''
say 'then:  loom run . "what does this repo do?"     one turn, exit code, no GUI'
say '       loom /path/to/repo                       drive a session at the terminal'
say '       loom --help'
say ''
say "remove everything with:  rm -rf $LOOM_HOME"
