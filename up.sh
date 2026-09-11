#!/usr/bin/env bash
# =============================================================
# up.sh —— 服务器端一键部署/启动(纯 Docker 自举)
#
#   ./up.sh
#    0) 首次运行生成 .env(面板密码等)，之后复用
#    1) 构建 bootstrap 镜像(之后走缓存)
#    2) 跑一次 bootstrap: 按 config/sources.txt 抓源生成 ./data/config.yaml
#       (若本次拉源失败但已有 config, 沿用旧配置, 不影响代理)
#    3) 构建 panel 镜像并启动 mihomo + panel
#
# 之后刷新节点池(可选, 与 systemd timer / 面板上的按钮效果相同):
#   docker compose run --rm bootstrap
#
# 管理面板: http://<服务器IP>:9091   (密码见 .env 的 PANEL_PASSWORD)
# =============================================================
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p data data/panel

# ---------------- 0. .env（面板密码） ----------------
ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
	echo "[up] 首次运行: 生成 $ENV_FILE (含面板密码)..."
	umask 077
	{
		echo "# 由 up.sh 自动生成。已在 .gitignore 中，请勿提交到 git。"
		echo "# 管理面板登录密码 —— 登录 http://<服务器IP>:9091 时使用"
		echo "PANEL_PASSWORD=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
		echo "# 面板监听地址/端口。监听 0.0.0.0 表示局域网+ZeroTier 都能访问，"
		echo "# 想只让 ZeroTier 访问可改成服务器 ZeroTier IP，例如 PANEL_LISTEN=10.146.11.235"
		echo "PANEL_LISTEN=0.0.0.0"
		echo "PANEL_PORT=9091"
	} >"$ENV_FILE"
	chmod 600 "$ENV_FILE"
fi

# 读出变量（供下面打印，不导出也没关系：compose 自己会读 .env）
set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

# ---------------- 1. 构建镜像 ----------------
# 每次构建 bootstrap/panel(bootstrap.sh / config.base.yaml / panel 源码更新
# 必须重打包)；层有缓存, 源码没变时很快。
echo "[up] 构建/更新 bootstrap 镜像 ..."
docker compose build bootstrap

echo "[up] 构建/更新 panel 镜像 ..."
docker compose build panel

# ---------------- 2. 生成/刷新节点池 ----------------
echo "[up] 生成/刷新节点池 ..."
if ! docker compose run --rm bootstrap; then
	echo "[up] bootstrap 未能生成新配置；若 data/config.yaml 已存在将沿用旧配置继续启动。"
fi

# ---------------- 3. 启动 ----------------
echo "[up] 启动/更新 mihomo + panel ..."
docker compose up -d
# config 刚被 bootstrap 更新过, 重启一次让 mihomo 加载新配置(短暂闪断可接受)
docker compose restart mihomo
docker compose ps

# ---------------- 4. 提示 ----------------
PORT="${PANEL_PORT:-9091}"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
IP="${IP:-<服务器IP>}"

echo
echo "============================================================"
echo " 代理网关 : ${IP}:7890"
echo " 管理面板 : http://${IP}:${PORT}"
echo " 面板密码 : ${PANEL_PASSWORD:-（未设置，见 .env）}"
echo "------------------------------------------------------------"
echo " ⚠ 面板可控制整个代理与容器，请勿暴露到公网。"
echo "   只想让 ZeroTier 访问？把 .env 里的 PANEL_LISTEN 改成服务器 ZT IP。"
echo "============================================================"
echo
echo "验证(服务器本机): curl -x http://127.0.0.1:7890 -sS -o /dev/null -w '%{http_code}\n' https://www.gstatic.com/generate_204"
