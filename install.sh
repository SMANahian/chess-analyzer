#!/usr/bin/env bash
# Chess Analyzer — installer
# Usage: curl -sSL https://raw.githubusercontent.com/SMANahian/chess-analyzer/main/install.sh | bash

set -euo pipefail

PACKAGE_NAME="chess-analyzer"
REPO_URL="https://github.com/SMANahian/chess-analyzer"
GIT_REF="${CHESS_ANALYZER_GIT_REF:-main}"
INSTALL_SOURCE="${CHESS_ANALYZER_INSTALL_SOURCE:-git}"
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${BOLD}[chess-analyzer]${NC} $*"; }
success() { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
die()     { echo -e "${RED}✕${NC}  $*" >&2; exit 1; }

resolve_install_spec() {
  if [[ -n "${CHESS_ANALYZER_INSTALL_SPEC:-}" ]]; then
    echo "$CHESS_ANALYZER_INSTALL_SPEC"
    return
  fi
  if [[ "$INSTALL_SOURCE" == "git" ]]; then
    echo "git+${REPO_URL}.git@${GIT_REF}"
    return
  fi
  echo "$PACKAGE_NAME"
}

# ── Check Python ─────────────────────────────────────────────────────────

info "Checking Python..."
PYTHON=""
for cmd in python3 python; do
  if command -v "$cmd" &>/dev/null; then
    version=$("$cmd" -c 'import sys; print(sys.version_info[:2] >= (3,8))' 2>/dev/null)
    if [[ "$version" == "True" ]]; then
      PYTHON="$cmd"
      break
    fi
  fi
done
[[ -n "$PYTHON" ]] || die "Python 3.8+ is required. Install it from https://python.org"
success "Found $($PYTHON --version)"

# ── Install package ───────────────────────────────────────────────────────

info "Installing chess-analyzer..."
INSTALL_SPEC="$(resolve_install_spec)"

USE_PIPX=false
if command -v pipx &>/dev/null; then
  USE_PIPX=true
fi

if $USE_PIPX; then
  info "Installing via pipx (isolated environment)..."
  pipx install "$INSTALL_SPEC" --force
  pipx ensurepath >/dev/null 2>&1 || true
else
  info "Installing via pip (user install)..."
  "$PYTHON" -m pip install --user --upgrade "$INSTALL_SPEC"
fi

# ── Ensure the command is in PATH ─────────────────────────────────────────

INSTALL_DIR=""
if $USE_PIPX; then
  # pipx handles PATH via ~/.local/bin on most systems
  INSTALL_DIR="$HOME/.local/bin"
else
  # Find where pip --user puts scripts
  INSTALL_DIR=$("$PYTHON" -m site --user-scripts 2>/dev/null || echo "$HOME/.local/bin")
fi

add_to_path() {
  local dir="$1"
  local profile="$2"
  if [[ -f "$profile" ]]; then
    if ! grep -q "$dir" "$profile" 2>/dev/null; then
      echo '' >> "$profile"
      echo "# Added by chess-analyzer installer" >> "$profile"
      echo "export PATH=\"\$PATH:$dir\"" >> "$profile"
      warn "Added $dir to PATH in $profile — restart your terminal or run: source $profile"
    fi
  fi
}

if ! command -v chess-analyzer &>/dev/null; then
  warn "$INSTALL_DIR is not in your PATH."
  add_to_path "$INSTALL_DIR" "$HOME/.zshrc"
  add_to_path "$INSTALL_DIR" "$HOME/.bashrc"
  add_to_path "$INSTALL_DIR" "$HOME/.bash_profile"
  # Try to make it available now
  export PATH="$PATH:$INSTALL_DIR"
fi

# ── Verify installation ───────────────────────────────────────────────────

if command -v chess-analyzer &>/dev/null; then
  success "chess-analyzer installed successfully!"
else
  warn "chess-analyzer was installed but is not yet in your PATH."
  warn "You can run it directly with:"
  warn "  $INSTALL_DIR/chess-analyzer"
  warn "Or restart your terminal and run: chess-analyzer"
fi

# ── Check Stockfish ───────────────────────────────────────────────────────

info "Checking for Stockfish..."
if [[ -n "${STOCKFISH_PATH:-}" ]]; then
  success "Using STOCKFISH_PATH=$STOCKFISH_PATH"
elif command -v stockfish &>/dev/null; then
  success "Stockfish found: $(command -v stockfish)"
else
  warn "Stockfish not found. The chess engine is required for analysis."
  echo ""
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo -e "  Install with Homebrew:  ${BOLD}brew install stockfish${NC}"
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo -e "  Install with apt:       ${BOLD}sudo apt install stockfish${NC}"
    echo -e "  Or with snap:           ${BOLD}sudo snap install stockfish${NC}"
  else
    echo -e "  Download from: https://stockfishchess.org/download/"
  fi
  echo ""
fi

# ── Done ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}All done!${NC} Run the app with:"
echo ""
echo -e "  ${GREEN}chess-analyzer${NC}"
echo ""
echo -e "This will start a local server and open ${BOLD}http://127.0.0.1:8765${NC} in your browser."
echo ""
