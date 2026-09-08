#!/usr/bin/env bash
# =============================================================
# migrate-config.sh —— 把 Windows/ChromeGo 现成的 Clash.Meta 配置
# 迁移成 Linux 服务器网关版。
#
# 原理：配置文件是单一来源，不改动 proxies / proxy-groups / 规则，
# 只调整顶层字段（allow-lan / bind-address 等），避免复制一份
# 含节点信息的配置到仓库里造成泄密风险。
#
# 用法：
#   ./migrate-config.sh <Windows端config.yaml> [ChromeGo的clash.meta目录]
#
# 示例：
#   ./migrate-config.sh "D:\ChromeGo\clash.meta\config.yaml"
#   ./migrate-config.sh "D:\ChromeGo\clash.meta\config.yaml" "D:\ChromeGo\clash.meta"
#
# 第二个参数（可选）：指定后会把 Country.mmdb / GeoSite.dat / ruleset/
# 一并复制到输出目录，规则依赖的本地文件在服务器上才不会缺失。
#
# 输出：与脚本同目录下的 config.yaml（及其依赖的规则资源）。
# =============================================================
set -euo pipefail

SRC="${1:-}"
CHROME_CLASH_DIR="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SCRIPT_DIR/config.yaml"

if [[ -z "$SRC" || ! -f "$SRC" ]]; then
  echo "用法: $0 <Windows端config.yaml> [ChromeGo的clash.meta目录]"
  exit 1
fi

# 1. 复制原始配置，避免污染源文件
cp "$SRC" "$OUT"

# 2. 顶层字段修正
# allow-lan: 必须 true，否则只监听回环，ZeroTier 那头连不进来
sed -i 's/^allow-lan:[[:space:]]*false[[:space:]]*$/allow-lan: true/' "$OUT"
# 若顶层没有 bind-address，在 allow-lan 行后补一行
if ! grep -qE '^bind-address:' "$OUT"; then
  sed -i '/^allow-lan:/a bind-address: 0.0.0.0' "$OUT"
fi
# mixed-port 兜底（有些模板可能没写）
if ! grep -qE '^mixed-port:' "$OUT"; then
  sed -i '1i mixed-port: 7890' "$OUT"
fi
# 源配置顶部的 secret 常被用作无关标记（值是一串无关的外链字符串），
# 这里整行注释掉并清空值，避免以后配了 external-controller 时误把它当 API 密钥
sed -i -E 's/^secret:[[:space:]]*.*/# secret: (removed by migrate-config.sh)/' "$OUT"

# 3. 可选的规则依赖资源
if [[ -n "$CHROME_CLASH_DIR" && -d "$CHROME_CLASH_DIR" ]]; then
  for asset in Country.mmdb GeoSite.dat; do
    if [[ -f "$CHROME_CLASH_DIR/$asset" ]]; then
      cp "$CHROME_CLASH_DIR/$asset" "$SCRIPT_DIR/"
      echo "已复制: $asset"
    fi
  done
  if [[ -d "$CHROME_CLASH_DIR/ruleset" ]]; then
    mkdir -p "$SCRIPT_DIR/ruleset"
    cp -r "$CHROME_CLASH_DIR/ruleset/." "$SCRIPT_DIR/ruleset/"
    echo "已复制: ruleset/"
  fi
fi

echo "完成：生成 $OUT"
echo "以下字段已调整，其余（proxies/分组/规则）原样保留："
grep -nE '^(allow-lan|bind-address|mixed-port):' "$OUT" || true
