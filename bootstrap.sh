#!/usr/bin/env bash
# =============================================================
# bootstrap.sh —— 在 bootstrap 容器里执行一次:
#   用内置 config.base.yaml 作底 + merge-sources.sh 抓公开源
#   生成/刷新 /work/config.yaml(即宿主机 ./data/config.yaml)
#
# 源全挂时的策略:
#   - 已有 config.yaml -> 保留旧配置, 不中断代理(exit 0)
#   - 完全没有配置    -> 退出失败, 便于上层判断(exit 1)
# =============================================================
set -euo pipefail
cd /work

echo "[bootstrap] 开始从公开源拉取并合并节点 ..."
if ! merge-sources.sh /app/config.base.yaml config.new.yaml; then
  echo "[bootstrap] 本次拉源失败(网络或源全挂)。"
  if [ -f config.yaml ]; then
    echo "[bootstrap] 保留现有 config.yaml, 代理不受影响。"
    exit 0
  fi
  echo "[bootstrap] 尚无任何配置, 请检查服务器出网后重试: docker compose run --rm bootstrap"
  exit 1
fi

chmod 644 config.new.yaml
mv -f config.new.yaml config.yaml
echo "[bootstrap] config.yaml 已就绪。"
