#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  tools/scripts/init_server_env.sh <ssh-alias>

Examples:
  tools/scripts/init_server_env.sh yimsg-se

The target host must already be reachable by ssh, and the login user must be
root or have passwordless sudo for user/group, filesystem, and systemd setup.
TLS files must already exist on the target:
  /etc/ssl/certs/yimsg.pem
  /etc/ssl/certs/yimsg.key
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 2
fi

alias_name="$1"

ssh "$alias_name" 'sudo bash -s' <<'REMOTE'
set -euo pipefail

getent group yimsg >/dev/null || groupadd --system yimsg
if ! id -u yimsg >/dev/null 2>&1; then
  useradd --system --home-dir /opt/yimsg --shell /usr/sbin/nologin --gid yimsg yimsg
fi

mkdir -p /opt/yimsg/web /opt/yimsg/website /opt/yimsg/data/media
chown -R yimsg:yimsg /opt/yimsg
chmod 755 /opt/yimsg /opt/yimsg/web /opt/yimsg/website /opt/yimsg/data /opt/yimsg/data/media

cat > /opt/yimsg/config.toml <<'EOF'
[server]
host = "0.0.0.0"
port = 443
tls_cert = "/etc/ssl/certs/yimsg.pem"
tls_key = "/etc/ssl/certs/yimsg.key"

[database]
data_dir = "/opt/yimsg/data"
shard_count = 4

[frontend]
static_dir = "/opt/yimsg/web"

[website]
static_dir = "/opt/yimsg/website"
mount_path = "/"

[media]
upload_dir = "/opt/yimsg/data/media"
EOF

chown yimsg:yimsg /opt/yimsg/config.toml
chmod 644 /opt/yimsg/config.toml

cat > /etc/systemd/system/yimsg.service <<'EOF'
[Unit]
Description=Yimsg Server
After=network.target

[Service]
Type=simple
User=yimsg
Group=yimsg
WorkingDirectory=/opt/yimsg
ExecStart=/opt/yimsg/server /opt/yimsg/config.toml
Restart=on-failure
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable yimsg

test -r /etc/ssl/certs/yimsg.pem
test -r /etc/ssl/certs/yimsg.key
chown root:root /etc/ssl/certs/yimsg.pem
chown root:yimsg /etc/ssl/certs/yimsg.key
chmod 644 /etc/ssl/certs/yimsg.pem
chmod 640 /etc/ssl/certs/yimsg.key

if [[ -f /opt/yimsg/server ]]; then
  chmod 755 /opt/yimsg/server
  chown yimsg:yimsg /opt/yimsg/server
  setcap -r /opt/yimsg/server 2>/dev/null || true
fi
if [[ -f /opt/yimsg/seed-demo ]]; then
  chmod 755 /opt/yimsg/seed-demo
  chown yimsg:yimsg /opt/yimsg/seed-demo
fi

echo "Yimsg server environment initialized."
id yimsg
getent passwd yimsg
getent group yimsg
ls -ld /opt/yimsg /opt/yimsg/web /opt/yimsg/website /opt/yimsg/data /opt/yimsg/data/media
ls -l /opt/yimsg/config.toml /etc/ssl/certs/yimsg.pem /etc/ssl/certs/yimsg.key
systemctl is-enabled yimsg
REMOTE
