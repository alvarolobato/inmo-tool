#!/usr/bin/env bash
# PowerShop Analytics — production installer
#
# Installs the stack under /opt/powershop (configurable) using the `beta`
# channel by default. Ports bind to 0.0.0.0 so the host is reachable from
# the LAN; a Cloudflare Tunnel / reverse proxy is expected to gate any
# public exposure.
#
# Usage (run as a user in the `docker` group, or with sudo if the install
# dir is not writable):
#
#   curl -fsSL https://raw.githubusercontent.com/alvarolobato/powershop-analytics/main/deploy/install-prod.sh | bash
#
# Environment overrides:
#   PS_PROD_HOME      — installation directory. Default: $HOME/powershop on
#                       macOS (Docker Desktop, no sudo), /opt/powershop on
#                       Linux (FHS, requires sudo for the parent dir).
#   VERSION           — release tag to pin (default: latest prerelease for beta
#                       channel, latest stable release for stable channel)
#   CHANNEL           — 'beta' (default) or 'stable'. Sets ETL_VERSION /
#                       DASHBOARD_VERSION to `beta` or `latest` in .env
#                       (docker-compose.prod.yml prepends the `:` at image-pull time).
#   NONINTERACTIVE    — '1' to skip .env prompts (you must write .env yourself)
#
# The script NEVER writes IPs or credentials into the repo or any committed
# file — all secrets live only on the host in `$PS_PROD_HOME/.env`.

set -euo pipefail

# Minimum supported versions — bump here when raising the floor.
MIN_MACOS_MAJOR=14        # Sonoma
MIN_DOCKER_MAJOR=25       # Engine 25.0
MIN_COMPOSE_MAJOR=2
MIN_COMPOSE_MINOR=20      # Compose 2.20
MIN_FREE_GB=50

REPO="alvarolobato/powershop-analytics"
RELEASE_BASE="https://github.com/${REPO}/releases/download"
API_BASE="https://api.github.com/repos/${REPO}"
CHANNEL="${CHANNEL:-beta}"

# Default install dir is platform-specific. On Linux we use /opt/powershop
# (FHS-conventional, requires sudo). On macOS /opt isn't a standard spot
# for user-installed apps and Docker Desktop runs as the logged-in user —
# default to $HOME/powershop so the install needs no sudo.
OS_NAME="$(uname -s)"
if [ -n "${PS_PROD_HOME:-}" ]; then
  PROJECT_DIR="$PS_PROD_HOME"
elif [ "$OS_NAME" = "Darwin" ]; then
  PROJECT_DIR="${HOME}/powershop"
else
  PROJECT_DIR="/opt/powershop"
fi

info()    { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
success() { printf '\033[1;32m[OK]\033[0m    %s\n' "$*"; }
warn()    { printf '\033[1;33m[WARN]\033[0m  %s\n' "$*"; }
die()     { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

# sudo wrapper — only escalates if we can't write the target directory.
maybe_sudo() {
  if [ -w "$(dirname "$PROJECT_DIR")" ] || [ -w "$PROJECT_DIR" ] 2>/dev/null; then
    "$@"
  else
    sudo "$@"
  fi
}

prompt_required() {
  local label="$1" value=""
  while [ -z "$value" ]; do
    read -rp "  ${label}: " value
  done
  printf '%s' "$value"
}

# Silent prompt for secrets — never echoes to the terminal.
prompt_required_secret() {
  local label="$1" value=""
  while [ -z "$value" ]; do
    read -rsp "  ${label}: " value
    printf '\n' >&2
  done
  printf '%s' "$value"
}

prompt_default() {
  local label="$1" default="$2" value=""
  read -rp "  ${label} [${default}]: " value
  printf '%s' "${value:-$default}"
}

random_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 24
  else
    tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24
  fi
}

# Single-quote a value for safe inclusion in a dotenv file. Docker Compose's
# env-file parser treats everything after an unquoted `#` as a comment and
# splits on whitespace; single-quoted values are taken literally. The parser
# does NOT support escaping a single quote inside a single-quoted value, so
# reject inputs that contain a single quote (or a newline) rather than write
# a value that would be mis-parsed at runtime.
dotenv_quote() {
  local label="$1" v="$2"
  case "$v" in
    *\'*) die "${label} contains a single quote (') — not supported in .env values. Please pick a different value." ;;
  esac
  case "$v" in
    *$'\n'*) die "${label} contains a newline — not supported in .env values." ;;
  esac
  printf "'%s'" "$v"
}

preflight_check() {
  local check_only="${1:-0}"
  local errors=0

  info "Running preflight checks..."

  # 1. macOS only
  local os
  os="$(uname -s)"
  if [ "$os" != "Darwin" ]; then
    die "This installer is for macOS only. See https://github.com/alvarolobato/powershop-analytics/blob/main/docs/deployment/production.md"
  fi
  success "OS: macOS (Darwin)"

  # 2. macOS version floor
  local macos_ver macos_major
  macos_ver="$(sw_vers -productVersion 2>/dev/null || true)"
  macos_major="${macos_ver%%.*}"
  if [ -z "$macos_major" ]; then
    printf '\033[1;31m[ERROR]\033[0m Cannot determine macOS version. See https://github.com/alvarolobato/powershop-analytics/blob/main/docs/deployment/production.md#macos-version\n' >&2
    errors=$((errors + 1))
  elif [ "$macos_major" -lt "$MIN_MACOS_MAJOR" ] 2>/dev/null; then
    printf '\033[1;31m[ERROR]\033[0m macOS %s is below the minimum supported version (macOS %s). See https://github.com/alvarolobato/powershop-analytics/blob/main/docs/deployment/production.md#macos-version\n' "$macos_ver" "$MIN_MACOS_MAJOR" >&2
    errors=$((errors + 1))
  else
    success "macOS version: ${macos_ver}"
  fi

  # 3. Architecture — Apple Silicon is fully supported; Intel is a warning
  local arch
  arch="$(uname -m)"
  if [ "$arch" = "arm64" ]; then
    success "Architecture: Apple Silicon (arm64)"
  else
    warn "Architecture: ${arch} (Intel). Intel is not tested — proceed with caution. See https://github.com/alvarolobato/powershop-analytics/blob/main/docs/deployment/production.md#apple-silicon-vs-intel"
    # Not a hard failure — Intel may work; the operator has been warned.
  fi

  # 4. Docker Desktop on macOS ships its CLI under /Applications but doesn't
  #    put it on non-login-shell PATH. If `docker` isn't found, look there
  #    before failing.
  if ! command -v docker >/dev/null 2>&1; then
    local mac_docker="/Applications/Docker.app/Contents/Resources/bin"
    if [ -x "${mac_docker}/docker" ]; then
      export PATH="${mac_docker}:$PATH"
      info "Using Docker Desktop CLI at ${mac_docker}"
    else
      printf '\033[1;31m[ERROR]\033[0m Docker is not installed. Install from https://www.docker.com/products/docker-desktop/ (minimum Docker Desktop 4.28 / engine %s)\n' "$MIN_DOCKER_MAJOR" >&2
      errors=$((errors + 1))
    fi
  fi

  if command -v docker >/dev/null 2>&1; then
    # 4b. Docker engine version
    local docker_ver docker_major
    docker_ver="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
    docker_major="${docker_ver%%.*}"
    if [ -z "$docker_major" ]; then
      printf '\033[1;31m[ERROR]\033[0m Cannot reach the Docker daemon. Start Docker Desktop and retry.\n' >&2
      errors=$((errors + 1))
    elif [ "$docker_major" -lt "$MIN_DOCKER_MAJOR" ] 2>/dev/null; then
      printf '\033[1;31m[ERROR]\033[0m Docker engine %s is below the minimum (%s). Upgrade Docker Desktop. See https://github.com/alvarolobato/powershop-analytics/blob/main/docs/deployment/production.md#docker-desktop\n' "$docker_ver" "$MIN_DOCKER_MAJOR" >&2
      errors=$((errors + 1))
    else
      success "Docker engine: ${docker_ver}"
    fi

    # 5. Docker Compose v2
    local compose_ver compose_maj compose_min
    compose_ver="$(docker compose version --short 2>/dev/null || true)"
    compose_ver="${compose_ver#v}"
    compose_maj="${compose_ver%%.*}"
    compose_min="${compose_ver#*.}"; compose_min="${compose_min%%.*}"
    if [ -z "$compose_ver" ]; then
      printf '\033[1;31m[ERROR]\033[0m docker compose v2 plugin not found. Upgrade Docker Desktop.\n' >&2
      errors=$((errors + 1))
    elif [ "$compose_maj" -lt "$MIN_COMPOSE_MAJOR" ] 2>/dev/null || \
         { [ "$compose_maj" -eq "$MIN_COMPOSE_MAJOR" ] && [ "$compose_min" -lt "$MIN_COMPOSE_MINOR" ] 2>/dev/null; }; then
      printf '\033[1;31m[ERROR]\033[0m docker compose %s is below the minimum (%s.%s). Upgrade Docker Desktop.\n' "$compose_ver" "$MIN_COMPOSE_MAJOR" "$MIN_COMPOSE_MINOR" >&2
      errors=$((errors + 1))
    else
      success "Docker Compose: ${compose_ver}"
    fi
  fi

  # 6. Disk space — free bytes on the install directory's filesystem
  local install_base free_gb
  install_base="$(dirname "${PS_PROD_HOME:-$HOME/powershop}")"
  # `df -k` prints 1K-blocks; field 4 is Available
  free_gb="$(df -k "$install_base" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024/1024}')"
  if [ -z "$free_gb" ]; then
    warn "Could not determine free disk space on ${install_base} — ensure at least ${MIN_FREE_GB} GB is available."
  elif [ "$free_gb" -lt "$MIN_FREE_GB" ]; then
    warn "Only ${free_gb} GB free on ${install_base}. At least ${MIN_FREE_GB} GB is recommended for data growth. See https://github.com/alvarolobato/powershop-analytics/blob/main/docs/deployment/production.md#disk-space"
    # Warn only — not a hard failure; operator may know what they're doing.
  else
    success "Disk space: ${free_gb} GB free (≥ ${MIN_FREE_GB} GB required)"
  fi

  # 7. SSH server (Remote Login) — best-effort check on macOS
  if launchctl print system/com.openssh.sshd >/dev/null 2>&1; then
    success "SSH server: Remote Login is enabled"
  else
    warn "Remote Login (SSH) does not appear to be enabled. Enable it in System Settings → General → Sharing → Remote Login so 'ps prod *' commands can connect from developer machines."
    # Warn only — the install may still complete; ops will be broken until SSH is on.
  fi

  # Summary
  if [ "$errors" -gt 0 ]; then
    printf '\033[1;31m[ERROR]\033[0m %d preflight check(s) failed. Fix the issues above before retrying.\n' "$errors" >&2
    exit 1
  fi

  if [ "$check_only" = "1" ]; then
    success "Preflight checks passed — this Mac is ready for installation."
    exit 0
  fi
}

check_prerequisites() {
  info "Checking prerequisites..."
  # Docker Desktop on macOS ships its CLI under /Applications but doesn't
  # put it on non-login-shell PATH. If `docker` isn't found, look there
  # before failing.
  if ! command -v docker >/dev/null 2>&1; then
    local mac_docker="/Applications/Docker.app/Contents/Resources/bin"
    if [ -x "${mac_docker}/docker" ]; then
      export PATH="${mac_docker}:$PATH"
      info "Using Docker Desktop CLI at ${mac_docker}"
    else
      die "Docker is not installed. See https://docs.docker.com/engine/install/"
    fi
  fi
  docker compose version >/dev/null 2>&1 || die "'docker compose' v2 is not available."
  # docker daemon must be up — on macOS this means Docker Desktop is running.
  docker info >/dev/null 2>&1 || die "Cannot reach the Docker daemon. Start Docker Desktop (macOS) or the docker service (Linux) and retry."
  command -v curl >/dev/null 2>&1 || die "curl is required."
  success "Prerequisites OK"
}

resolve_version() {
  if [ -n "${VERSION:-}" ]; then
    echo "$VERSION"
    return
  fi
  local tag=""
  if [ "$CHANNEL" = "beta" ]; then
    # /releases/latest only returns stable releases, and /releases?per_page=1
    # returns the most recent release regardless of prerelease status — which
    # can be a stable tag even when the user asked for beta. Walk the first
    # page of releases and pick the most recent prerelease explicitly.
    tag=$(curl -fsSL "${API_BASE}/releases?per_page=30" \
      | awk '
          BEGIN { RS="},"; }
          /"prerelease"[[:space:]]*:[[:space:]]*true/ {
            if (match($0, /"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"/)) {
              tag = substr($0, RSTART, RLENGTH)
              sub(/.*"tag_name"[[:space:]]*:[[:space:]]*"/, "", tag)
              sub(/".*/, "", tag)
              print tag
              exit
            }
          }
        ')
  else
    tag=$(curl -fsSL "${API_BASE}/releases/latest" \
      | grep -m1 '"tag_name"' \
      | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
  fi
  [ -n "$tag" ] || die "Could not determine latest ${CHANNEL} release. Set VERSION=<tag> to override."
  echo "$tag"
}

download_asset() {
  local version="$1" filename="$2" dest="$3"
  local url="${RELEASE_BASE}/${version}/${filename}"
  info "Downloading ${filename} (${version})..."
  curl -fsSL "$url" -o "$dest" || die "Failed to download ${url}"
}

create_env() {
  local env_file="$1"
  local resolved_version="$2"
  if [ "${NONINTERACTIVE:-0}" = "1" ]; then
    warn "NONINTERACTIVE=1 — skipping .env generation. You MUST write ${env_file} before starting the stack."
    return
  fi

  # When the user pinned a specific VERSION, write that exact tag into .env
  # so the rolling :beta / :latest tag doesn't drift out of sync with the
  # compose file that was downloaded for this release.
  local etl_tag dash_tag
  if [ -n "${VERSION:-}" ]; then
    etl_tag="$resolved_version"; dash_tag="$resolved_version"
  elif [ "$CHANNEL" = "beta" ]; then
    etl_tag="beta"; dash_tag="beta"
  else
    etl_tag="latest"; dash_tag="latest"
  fi

  echo ""
  info "Configuring .env — press Enter to accept defaults."
  echo ""
  local p4d_host p4d_user p4d_password postgres_password openrouter_key pg_pass admin_key
  pg_pass=$(random_password)
  admin_key=$(random_password)
  p4d_host=$(prompt_required "4D server hostname or IP (LAN)")
  p4d_user=$(prompt_required "4D SQL username")
  p4d_password=$(prompt_required_secret "4D SQL password")
  postgres_password=$(prompt_default "PostgreSQL password" "$pg_pass")
  openrouter_key=$(prompt_required_secret "OpenRouter API key")

  # Admin panel
  local admin_api_key
  admin_api_key=$(prompt_default "Admin panel password/token" "$admin_key")

  # Public URLs (for reverse proxy / custom domain)
  local dashboard_port wren_port app_public_url wren_public_url
  dashboard_port=$(prompt_default "Dashboard App port" "4000")
  wren_port=$(prompt_default "WrenAI UI port" "3000")
  app_public_url=$(prompt_default "Dashboard public URL (blank = http://localhost:${dashboard_port})" "http://localhost:${dashboard_port}")
  wren_public_url=$(prompt_default "WrenAI public URL (blank = http://localhost:${wren_port})" "http://localhost:${wren_port}")

  # HTTPS cookie flag (auto-set when URL is https://)
  local cookie_secure=""
  [[ "$app_public_url" == https://* ]] && cookie_secure="true"

  # Host interface binding
  local bind_addr
  bind_addr=$(prompt_default "Bind address for host ports" "0.0.0.0")

  # Quote all user-supplied values before writing them into .env
  local p4d_host_q p4d_user_q p4d_password_q postgres_password_q openrouter_key_q bind_addr_q soap_url_q soap_wsdl_q admin_key_q app_url_q wren_url_q
  p4d_host_q=$(dotenv_quote "P4D_HOST" "$p4d_host")
  p4d_user_q=$(dotenv_quote "P4D_USER" "$p4d_user")
  p4d_password_q=$(dotenv_quote "P4D_PASSWORD" "$p4d_password")
  postgres_password_q=$(dotenv_quote "POSTGRES_PASSWORD" "$postgres_password")
  openrouter_key_q=$(dotenv_quote "OPENROUTER_API_KEY" "$openrouter_key")
  bind_addr_q=$(dotenv_quote "HOST_BIND" "$bind_addr")
  soap_url_q=$(dotenv_quote "SOAP_URL" "http://${p4d_host}:8080/4DSOAP/")
  soap_wsdl_q=$(dotenv_quote "SOAP_WSDL" "http://${p4d_host}:8080/4DSOAP/?wsdl")
  admin_key_q=$(dotenv_quote "ADMIN_API_KEY" "$admin_api_key")
  app_url_q=$(dotenv_quote "APP_PUBLIC_URL" "$app_public_url")
  wren_url_q=$(dotenv_quote "WREN_PUBLIC_URL" "$wren_public_url")

  # Write to a secure temp file in the invoking user's space (never the
  # project dir — which may be sudo-owned under /opt). Create with 0600
  # before writing any secret, and clean up on any exit path.
  local tmp_env
  tmp_env=$(mktemp) || die "Failed to create temporary file for ${env_file}"
  chmod 600 "$tmp_env" || { rm -f "$tmp_env"; die "Failed to secure temporary .env file"; }
  trap 'rm -f "$tmp_env"' EXIT

  cat >"$tmp_env" <<EOF
# PowerShop Analytics — production environment
# Generated by install-prod.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Channel: ${CHANNEL}
#
# Do not commit this file. Secrets live only on the host.

# --- Release channel ---
# Images are pulled from Docker Hub using these tags. For beta use 'beta'.
# For stable use 'latest' or pin to a specific tag (e.g. 'v0.1.0').
ETL_VERSION=${etl_tag}
DASHBOARD_VERSION=${dash_tag}

# --- Docker Hub namespace ---
# DOCKERHUB_NAMESPACE=alobato

# --- 4D source database ---
P4D_HOST=${p4d_host_q}
P4D_PORT=19812
P4D_USER=${p4d_user_q}
P4D_PASSWORD=${p4d_password_q}
SOAP_URL=${soap_url_q}
SOAP_WSDL=${soap_wsdl_q}

# --- PostgreSQL mirror ---
POSTGRES_USER=postgres
POSTGRES_PASSWORD=${postgres_password_q}
POSTGRES_DB=powershop

# --- ETL scheduler ---
ETL_CRON_HOUR=2

# --- WrenAI / LLM ---
OPENROUTER_API_KEY=${openrouter_key_q}
WREN_LLM_MODEL=openrouter/anthropic/claude-sonnet-4-20250514

# --- Host port bindings ---
HOST_BIND=${bind_addr_q}
HOST_PORT=${wren_port}
DASHBOARD_PORT=${dashboard_port}
AI_SERVICE_FORWARD_PORT=5555

# --- Dashboard security and URLs ---
ADMIN_API_KEY=${admin_key_q}
$([ -n "$cookie_secure" ] && echo "ADMIN_COOKIE_SECURE=${cookie_secure}" || echo "# ADMIN_COOKIE_SECURE=true  # uncomment when serving over HTTPS")
APP_PUBLIC_URL=${app_url_q}
WREN_PUBLIC_URL=${wren_url_q}
# Dashboard LLM settings (provider, model, etc.) are configured via /admin/config
# and saved to ~/.config/powershop-analytics/config.yaml — not set as env vars here
# to keep them editable from the UI.

# --- WrenAI service versions (upstream, change on explicit upgrade) ---
WREN_BOOTSTRAP_VERSION=0.1.5
WREN_ENGINE_VERSION=0.22.0
IBIS_SERVER_VERSION=0.22.0
WREN_AI_SERVICE_VERSION=0.29.0
WREN_UI_VERSION=0.32.2
WREN_PRODUCT_VERSION=0.29.1
WREN_ENGINE_PORT=8080
WREN_ENGINE_SQL_PORT=7432
IBIS_SERVER_PORT=8000
WREN_AI_SERVICE_PORT=5555
PLATFORM=linux/amd64
TELEMETRY_ENABLED=true
EOF

  maybe_sudo install -m 0600 "$tmp_env" "$env_file"
  rm -f "$tmp_env"
  trap - EXIT
  success ".env written with 0600 permissions"
}

main() {
  local check_only=0
  for arg in "$@"; do
    case "$arg" in
      --check-only) check_only=1 ;;
      --*) die "Unknown flag: $arg" ;;
    esac
  done

  echo ""
  echo "=================================================="
  echo "  PowerShop Analytics — production installer"
  echo "  Channel: ${CHANNEL}"
  echo "  Project dir: ${PROJECT_DIR}"
  [ "$check_only" = "1" ] && echo "  Mode: preflight check only (--check-only)"
  echo "=================================================="
  echo ""

  preflight_check "$check_only"

  check_prerequisites

  local version
  version=$(resolve_version)
  info "Installing version: ${version}"

  maybe_sudo mkdir -p \
    "${PROJECT_DIR}" \
    "${PROJECT_DIR}/data/postgres" \
    "${PROJECT_DIR}/data/qdrant" \
    "${PROJECT_DIR}/data/wren"

  # Config dir: stores dashboard settings (config.yaml written by /admin/config UI).
  # Must exist on the host and be :rw-mounted into the dashboard container.
  local config_dir="${POWERSHOP_CONFIG_DIR:-$HOME/.config/powershop-analytics}"
  mkdir -p "${config_dir}"
  chmod 700 "${config_dir}"
  success "Config directory ready: ${config_dir}"

  # Make the project dir tree writable by the invoking user so subsequent
  # `docker compose` commands don't need sudo. This includes data subdirs,
  # which containers will re-own on first start.
  if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
    maybe_sudo chown -R "${SUDO_USER}:${SUDO_USER}" "${PROJECT_DIR}" 2>/dev/null || true
  fi
  success "Directories ready: ${PROJECT_DIR}"

  local compose="${PROJECT_DIR}/docker-compose.yml"
  local wren_cfg="${PROJECT_DIR}/wren-config.yaml"
  local tmp_compose tmp_wren
  tmp_compose=$(mktemp) && download_asset "$version" "docker-compose.prod.yml" "$tmp_compose"
  tmp_wren=$(mktemp)    && download_asset "$version" "wren-config.yaml"        "$tmp_wren"
  maybe_sudo install -m 0644 "$tmp_compose" "$compose"
  maybe_sudo install -m 0644 "$tmp_wren"    "$wren_cfg"
  rm -f "$tmp_compose" "$tmp_wren"
  success "Stack files installed"

  local env_file="${PROJECT_DIR}/.env"
  if [ -f "$env_file" ]; then
    warn ".env already exists — leaving it alone. Delete it to reconfigure."
  else
    create_env "$env_file" "$version"
  fi

  # Record installed version
  echo "$version" | maybe_sudo tee "${PROJECT_DIR}/.version" >/dev/null

  echo ""
  echo "=================================================="
  success "Installation complete."
  echo
  echo "  Next steps (from ${PROJECT_DIR}):"
  echo "    cd ${PROJECT_DIR}"
  echo "    docker compose pull    # fetch the ${CHANNEL} images"
  echo "    docker compose up -d"
  echo
  echo "  Reachable on the LAN once up:"
  echo "    WrenAI UI     http://<host-ip>:\${HOST_PORT:-3000}"
  echo "    Dashboard     http://<host-ip>:\${DASHBOARD_PORT:-4000}"
  echo "    PostgreSQL    <host-ip>:5432"
  echo
  echo "  Update to the latest ${CHANNEL} build:"
  echo "    cd ${PROJECT_DIR} && docker compose pull && docker compose up -d"
  echo "=================================================="
}

main "$@"
