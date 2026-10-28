#!/usr/bin/env bash
#
# Install livereel as a systemd service on Ubuntu.
#
# Idempotent: safe to re-run after a code change. It does not start the service, so the
# operator can look at the config first.

set -euo pipefail

PREFIX="${PREFIX:-/opt/livereel}"
CONFIG_DIR="${CONFIG_DIR:-/etc/livereel}"
SERVICE_USER="${SERVICE_USER:-livereel}"
UNIT_FILE="/etc/systemd/system/livereel.service"

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "this script needs root (it writes to /opt, /etc and the systemd unit directory)" >&2
  exit 1
fi

echo "==> checking prerequisites"
command -v node >/dev/null || { echo "node is not installed" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is not installed: apt install ffmpeg" >&2; exit 1; }

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 20 )); then
  echo "node 20 or newer is required, found $(node -v)" >&2
  exit 1
fi

if ! command -v gst-launch-1.0 >/dev/null; then
  echo "    note: gstreamer is not installed; the GStreamer pipelines will be unavailable."
  echo "          apt install gstreamer1.0-tools gstreamer1.0-plugins-{base,good,bad,ugly}"
fi

echo "==> creating service user ${SERVICE_USER}"
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

# Capture devices are group-owned. Without these the service can open neither a webcam nor a
# VAAPI render node, which looks exactly like "the encoder is not supported".
for group in video render; do
  if getent group "${group}" >/dev/null; then
    usermod -aG "${group}" "${SERVICE_USER}"
    echo "    added ${SERVICE_USER} to ${group}"
  fi
done

echo "==> installing to ${PREFIX}"
mkdir -p "${PREFIX}"
# node_modules is deliberately included: the service host is not assumed to have a working
# npm registry route, and a production install should not depend on one.
for item in src package.json node_modules; do
  if [[ -e "${SOURCE_DIR}/${item}" ]]; then
    rm -rf "${PREFIX:?}/${item}"
    cp -r "${SOURCE_DIR}/${item}" "${PREFIX}/"
  fi
done
chown -R root:root "${PREFIX}"
chmod -R go-w "${PREFIX}"

echo "==> configuration in ${CONFIG_DIR}"
mkdir -p "${CONFIG_DIR}"
if [[ ! -f "${CONFIG_DIR}/livereel.json" ]]; then
  cp "${SOURCE_DIR}/config/livereel.example.json" "${CONFIG_DIR}/livereel.json"
  echo "    wrote ${CONFIG_DIR}/livereel.json (review it before starting)"
else
  echo "    ${CONFIG_DIR}/livereel.json exists, left alone"
fi

if [[ ! -f "${CONFIG_DIR}/livereel.env" ]]; then
  umask 077
  cat > "${CONFIG_DIR}/livereel.env" <<EOF
# Secrets for livereel. Read by systemd, never world-readable.
# LIVEREEL_CONTROL_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
# LIVEREEL_MONGO_URI=mongodb://127.0.0.1:27017
# LIVEREEL_OBS_PASSWORD=
EOF
  chmod 600 "${CONFIG_DIR}/livereel.env"
  echo "    wrote ${CONFIG_DIR}/livereel.env with a generated token, commented out"
fi
chown -R root:"${SERVICE_USER}" "${CONFIG_DIR}"
chmod 750 "${CONFIG_DIR}"

echo "==> installing the systemd unit"
# systemd does not search PATH for ExecStart, so the unit gets the node binary this host
# actually has rather than the /usr/bin/node the template assumes.
NODE_BIN="$(command -v node)"
sed "s|^ExecStart=.*|ExecStart=${NODE_BIN} ${PREFIX}/src/cli.js serve|" \
  "${SOURCE_DIR}/deploy/livereel.service" > "${UNIT_FILE}"
chmod 644 "${UNIT_FILE}"
echo "    ExecStart uses ${NODE_BIN}"
systemctl daemon-reload

echo "==> verifying the unit parses"
systemd-analyze verify "${UNIT_FILE}" || echo "    systemd-analyze reported warnings, see above"

echo
echo "installed."
echo
echo "  review config   ${CONFIG_DIR}/livereel.json"
echo "  check the host  sudo -u ${SERVICE_USER} node ${PREFIX}/src/cli.js probe"
echo "  enable at boot  systemctl enable --now livereel"
echo "  follow logs     journalctl -u livereel -f -o cat"
echo
