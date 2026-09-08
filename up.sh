#!/usr/bin/env bash
# =============================================================
# up.sh —— 服务器端一键部署/启动(纯 Docker 自举)
#
#   ./up.sh
#    1) 首次先构建 bootstrap 镜像(之后跳过)
#    2) 跑一次 bootstrap: 抓公开源生成 ./data/config.yaml
#       (若本次拉源失败但已有 config, 沿用旧配置, 不影响代理)
#    3) docker compose up -d 启动 mihomo(官方镜像)
#
# 之后刷新节点池(可选, 与 systemd timer 效果相同):
#   docker compose run --rm bootstrap
# =============================================================
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p data

# 首次才构建(bootstrap 很小, 只装 curl/bash)
if ! docker image inspect mihomo-gateway-bootstrap:local >/dev/null 2>&1; then
  echo "[up] 首次运行, 构建 bootstrap 镜像 ..."
  docker compose build bootstrap
fi

echo "[up] 生成/刷新节点池 ..."
if ! docker compose run --rm bootstrap; then
  echo "[up] bootstrap 未能生成新配置; 若 data/config.yaml 已存在将沿用旧配置继续启动。"
fi

echo "[up] 启动 mihomo ..."
docker compose up -d
docker compose ps
echo
echo "验证(服务器本机): curl -x http://127.0.0.1:7890 -sS -o /dev/null -w '%{http_code}\n' https://www.gstatic.com/generate_204"
