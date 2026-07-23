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

# yimsg-agent：客服 demo_kf_1~3 自动回复常驻进程，见 agent/README.md、
# docs/deployment/部署方案.md 第 13 节。server 走公网域名（wss://yimsg.im/ws），
# 跟浏览器客户端走同一条 Cloudflare 代理链路，避免直连本机 IP 时 Origin CA 证书
# 校验不过的问题。demo_kf_1~3 密码固定为 server/tools/cmd/seed-demo 里已公开的
# demoPassword，不是需要保密的凭证，因此直接写在 agent.toml 里；DeepSeek API Key
# 是真正的密钥，只放在 agent.env（不进版本库），由部署 workflow 用 GitHub Secret
# 写入，这里只保证文件存在、权限正确。
mkdir -p /opt/yimsg/agent_data
chown -R yimsg:yimsg /opt/yimsg/agent_data
chmod 700 /opt/yimsg/agent_data

cat > /opt/yimsg/agent.toml <<'EOF'
[deepseek]
base_url = "https://api.deepseek.com"
model = "deepseek-chat"
api_key_env = "DEEPSEEK_API_KEY"

[agent]
server = "wss://yimsg.im/ws"
data_dir = "/opt/yimsg/agent_data"
poll_interval_seconds = 2
max_pull = 30

[[accounts]]
username = "demo_kf_1"
password = "Demo@123456"

[[accounts]]
username = "demo_kf_2"
password = "Demo@123456"

[[accounts]]
username = "demo_kf_3"
password = "Demo@123456"
EOF

chown yimsg:yimsg /opt/yimsg/agent.toml
chmod 640 /opt/yimsg/agent.toml

if [[ ! -f /opt/yimsg/agent.env ]]; then
  printf 'DEEPSEEK_API_KEY=\n' > /opt/yimsg/agent.env
fi
chown yimsg:yimsg /opt/yimsg/agent.env
chmod 600 /opt/yimsg/agent.env

cat > /etc/systemd/system/yimsg-agent.service <<'EOF'
[Unit]
Description=Yimsg Agent (demo_kf_1~3 customer-service auto-reply)
After=network.target yimsg.service

[Service]
Type=simple
User=yimsg
Group=yimsg
WorkingDirectory=/opt/yimsg
EnvironmentFile=/opt/yimsg/agent.env
ExecStart=/opt/yimsg/agent -config /opt/yimsg/agent.toml
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable yimsg-agent

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
if [[ -f /opt/yimsg/agent ]]; then
  chmod 755 /opt/yimsg/agent
  chown yimsg:yimsg /opt/yimsg/agent
fi

echo "Yimsg server environment initialized."
id yimsg
getent passwd yimsg
getent group yimsg
ls -ld /opt/yimsg /opt/yimsg/web /opt/yimsg/website /opt/yimsg/data /opt/yimsg/data/media /opt/yimsg/agent_data
ls -l /opt/yimsg/config.toml /opt/yimsg/agent.toml /opt/yimsg/agent.env /etc/ssl/certs/yimsg.pem /etc/ssl/certs/yimsg.key
systemctl is-enabled yimsg
systemctl is-enabled yimsg-agent
REMOTE
