#!/usr/bin/env bash
# =============================================================
# bootstrap.sh —— 在 bootstrap 容器里执行一次:
#   1) 下载 geo 分流数据(geosite.dat / geoip.dat)到 /work
#      - 多 CDN 源逐个尝试(jsdelivr 边缘节点, 大陆可达)
#      - 全部失败 -> 生成配置时自动注释 GEOSITE/GEOIP 规则,
#        退化为"全流量走代理", 保证网关始终可用
#   2) 用内置 config.base.yaml 作底 + merge-sources.sh 抓公开源
#      生成/刷新 /work/config.yaml(即宿主机 ./data/config.yaml)
#
# 源全挂时的策略:
#   - 已有 config.yaml -> 保留旧配置, 不中断代理(exit 0)
#   - 完全没有配置    -> 退出失败, 便于上层判断(exit 1)
# =============================================================
set -euo pipefail
cd /work

# ---------------- 1. geo 分流数据 ----------------
GEO_CDNS=(
  "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release"
  "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release"
  "https://gcore.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release"
)

download_geo() {
  local file="$1"
  for base in "${GEO_CDNS[@]}"; do
    echo "[geo] 尝试 ${file} <- ${base}/${file}"
    if curl -fsSL --max-time 60 -o "/work/$file" "${base}/${file}"; then
      local size
      size=$(wc -c < "/work/$file" 2>/dev/null || echo 0)
      if [ "$size" -gt 100000 ]; then
        echo "[geo] 已下载 ${file} ($size bytes)"
        return 0
      fi
      rm -f "/work/$file"
    fi
  done
  return 1
}

geo_ok=1
download_geo geosite.dat || geo_ok=0
download_geo geoip.dat   || geo_ok=0

if [ "$geo_ok" = "1" ]; then
  echo "[geo] 分流数据就绪 (geosite.dat / geoip.dat)"
else
  echo "[geo] 警告: 分流数据下载失败, 本次将退化为全流量走代理。"
fi

# ---------------- 2. 抓公开源合并节点 ----------------
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

# ---------------- 3. geo 缺失则退化为全代理 ----------------
if [ "$geo_ok" != "1" ]; then
  # 没有 geo 数据却保留 GEOSITE/GEOIP 规则会导致 mihomo 启动报错
  sed -i 's/^  - GEOSITE/  # - GEOSITE/; s/^  - GEOIP/  # - GEOIP/' config.new.yaml
  echo "[geo] 已在生成配置中注释 GEOIP/GEOSITE 规则(缺少分流数据, 全流量走代理)"
fi

chmod 644 config.new.yaml
mv -f config.new.yaml config.yaml
echo "[bootstrap] config.yaml 已就绪。"
