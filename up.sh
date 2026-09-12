#!/usr/bin/env bash
# =============================================================
# up.sh —— 服务器端唯一入口(部署 + 刷新节点池)
#
#   ./up.sh             部署/更新: 建镜像 → 抓源生成节点池 → 启动 → 热重载
#   ./up.sh --refresh   只刷新节点池 + 热重载(定时任务用; 不建镜像、不动容器)
#
# 为什么只需要记一个脚本:
#   ./up.sh           = 首次部署；改完代码 / config.base.yaml 之后再跑一次
#   ./up.sh --refresh = 日常和定时刷新节点池，**设备不会断线**
#
# 部署模式:
#    0) 首次运行生成 .env(面板密码等)，之后复用
#    1) 构建 bootstrap / panel 镜像(之后走缓存)
#    2) 跑一次 bootstrap: 按 config/sources.txt 抓源生成 ./data/config.yaml
#       (若本次拉源失败但已有 config, 沿用旧配置, 不影响代理)
#    3) docker compose up -d 启动 mihomo + panel, 再热重载 mihomo
#
# 定时刷新(推荐):
#   0 */6 * * * cd /opt/mihomo-gateway && ./up.sh --refresh >> /var/log/mihomo-node-refresh.log 2>&1
#
# 管理面板: http://<服务器IP>:9091   (密码见 .env 的 PANEL_PASSWORD)
# =============================================================
set -euo pipefail
cd "$(dirname "$0")"

# ---------------- 参数 ----------------
REFRESH_ONLY=0
case "${1:-}" in
--refresh | -r | refresh) REFRESH_ONLY=1 ;;
"") ;;
-h | --help)
	sed -n '2,23p' "$0"
	exit 0
	;;
*)
	echo "[up] 未知参数: $1  (可用: --refresh)" >&2
	exit 2
	;;
esac

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

# ---------------- 刷新模式(定时任务用) ----------------
# 只做两件事: 抓源生成配置 + 让 mihomo 重新读一次。
# 不建镜像、不 docker compose up -d、不重启容器 —— 设备不会断线。
if [ "$REFRESH_ONLY" = "1" ]; then
	echo "[up] $(date '+%F %T') 刷新节点池 ..."
	if docker compose run --rm bootstrap; then
		echo "[up] 配置已更新"
	else
		echo "[up] 警告: bootstrap 未成功(源全挂或网络问题), 沿用现有配置" >&2
	fi

	if curl -fsS -m 15 -X PUT "http://127.0.0.1:9090/configs?force=true" \
		-H 'Content-Type: application/json' -d '{"path":""}' >/dev/null 2>&1; then
		echo "[up] mihomo 已热重载新配置 (容器未重启, 设备未断线)"
		exit 0
	fi

	echo "[up] 热重载接口不可用, 回退为重启 mihomo(会有短暂断档) ..." >&2
	docker compose restart mihomo
	exit 0
fi

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
# 注意：compose 里 mihomo 依赖 bootstrap「成功完成」，所以若本次抓源失败，
# up -d 会返回非 0、并拒绝启动 mihomo。这里不让它中断整个脚本 ——
# 现有容器还在跑，后面照样会拿当前配置做热重载。
if ! docker compose up -d; then
	echo "[up] 警告: docker compose up -d 未完全成功（常见原因: 本次 bootstrap 没抓到源）。" >&2
	echo "[up] 现有容器仍在运行，继续用当前配置尝试热重载。" >&2
fi

# config 刚被 bootstrap 更新过, 让 mihomo 重新读一次。
# 优先「热重载」(PUT /configs, 不重启进程/容器, 不断连接);
# 只有接口不可用时才回退为重启容器(首次部署、或 mihomo 还没起来时属于这种情况)。
if curl -fsS -m 15 -X PUT "http://127.0.0.1:9090/configs?force=true" \
	-H 'Content-Type: application/json' -d '{"path":""}' >/dev/null 2>&1; then
	echo "[up] mihomo 已热重载新配置 (容器未重启, 无断档)"
else
	echo "[up] 热重载不可用, 回退为重启 mihomo"
	docker compose restart mihomo
fi
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
