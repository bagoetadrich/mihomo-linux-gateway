#!/usr/bin/env bash
# =============================================================
# patch-lan.sh —— 给 /etc/mihomo/config.yaml 打"局域网开放"补丁
#
# 适用场景：配置被订阅/更新流程覆盖回 allow-lan: false 之后，
# 一键把它改回 allow-lan: true + bind-address: 0.0.0.0。
# （ChromeGo 的 IP 更新会用云端模板覆盖 config，本脚本就是那类问题的对策）
#
# 用法：sudo ./patch-lan.sh [/path/to/config.yaml]
# 默认目标：/etc/mihomo/config.yaml
# =============================================================
set -euo pipefail

CONF="${1:-/etc/mihomo/config.yaml}"

if [[ ! -f "$CONF" ]]; then
  echo "[错误] 找不到 $CONF"
  exit 1
fi

# 备份一次
cp "$CONF" "${CONF}.bak.$(date +%Y%m%d%H%M%S)"

sed -i 's/^allow-lan:[[:space:]]*false[[:space:]]*$/allow-lan: true/' "$CONF"
if ! grep -qE '^bind-address:' "$CONF"; then
  sed -i '/^allow-lan:/a bind-address: 0.0.0.0' "$CONF"
fi

echo "已修正，当前相关字段："
grep -nE '^(allow-lan|bind-address):' "$CONF" || true
echo "重启生效：sudo systemctl restart mihomo"
