#!/usr/bin/env bash
# =============================================================
# install.sh —— 在 Linux 服务器上安装 mihomo 网关
#
# 前置：
#   1. 已经用 migrate-config.sh 生成好 config.yaml（或手动放好）
#   2. 把本仓库整体传到服务器（比如 /opt/mihomo-linux-gateway）
#   3. root 或 sudo 权限；若本机要当出口且开 TUN，需有 /dev/net/tun
#
# 可选环境变量：
#   MIHOMO_VERSION  指定版本，如 v1.19.10；不指定则自动取 GitHub 最新版
# =============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_SRC="$SCRIPT_DIR/config.yaml"
MIHOMO_DIR="/etc/mihomo"
MIHOMO_BIN="/usr/local/bin/mihomo"
UNIT="$SCRIPT_DIR/mihomo.service"

# ---------- 0. 检查配置是否已就位 ----------
if [[ ! -f "$CONF_SRC" ]]; then
  echo "[错误] 找不到 $CONF_SRC"
  echo "先运行: ./migrate-config.sh <Windows端config.yaml> [ChromeGo目录]"
  exit 1
fi

# ---------- 1. 下载 mihomo 二进制 ----------
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) GOARCH="amd64" ;;
  aarch64|arm64) GOARCH="arm64" ;;
  *) echo "[错误] 不支持的架构: $ARCH"; exit 1 ;;
esac

if [[ -z "${MIHOMO_VERSION:-}" ]]; then
  echo "查询 mihomo 最新版本..."
  MIHOMO_VERSION="$(
    curl -fsSL --retry 2 https://api.github.com/repos/MetaCubeX/mihomo/releases/latest \
      | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p'
  )"
fi
if [[ -z "${MIHOMO_VERSION:-}" ]]; then
  echo "[错误] 无法自动获取版本号，请手动指定：MIHOMO_VERSION=vX.Y.Z ./install.sh"
  exit 1
fi

GZ_NAME="mihomo-linux-${GOARCH}-${MIHOMO_VERSION}.gz"
URL="https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${GZ_NAME}"
echo "下载内核: ${URL}"
curl -fL --retry 2 -o /tmp/mihomo.gz "$URL"
gunzip -c /tmp/mihomo.gz > /tmp/mihomo.bin
chmod 755 /tmp/mihomo.bin
install -m 755 /tmp/mihomo.bin "$MIHOMO_BIN"
rm -f /tmp/mihomo.gz /tmp/mihomo.bin
"$MIHOMO_BIN" -v

# ---------- 2. 放置配置与规则资源 ----------
mkdir -p "$MIHOMO_DIR"
install -m 600 "$CONF_SRC" "$MIHOMO_DIR/config.yaml"
for asset in Country.mmdb GeoSite.dat; do
  if [[ -f "$SCRIPT_DIR/$asset" ]]; then
    install -m 600 "$SCRIPT_DIR/$asset" "$MIHOMO_DIR/$asset"
  fi
done
if [[ -d "$SCRIPT_DIR/ruleset" ]]; then
  mkdir -p "$MIHOMO_DIR/ruleset"
  cp -r "$SCRIPT_DIR/ruleset/." "$MIHOMO_DIR/ruleset/"
  chmod -R 600 "$MIHOMO_DIR/ruleset"
fi

# ---------- 3. 注册并启动 systemd 服务 ----------
install -m 644 "$UNIT" /etc/systemd/system/mihomo.service
systemctl daemon-reload
systemctl enable --now mihomo
systemctl --no-pager status mihomo || true

echo
echo "安装完成。查看日志：journalctl -u mihomo -o cat -f"
echo "默认监听：mixed-port 7890（allow-lan: true）。"
echo "下一步：按 README 配置防火墙只放行 ZeroTier 网段，并让各设备接入。"
