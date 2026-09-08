#!/usr/bin/env bash
# =============================================================
# merge-sources.sh —— 把 ChromeGo 的"多镜像源 IP 更新"做成自动闭环
#
# 做什么：
#   1) 依次抓取全部 ip 更新源(多 host x 1..6)里的配置
#   2) 解析出各源的 hysteria 节点(server/port/auth-str)，按 server:port 去重
#   3) 重建 config：
#        - proxies  = 合并后的全部节点
#        - ♻️ 自动切换 = url-test(每 60s 测活) —— 坏 IP 自动摘除、自动用活 IP
#        - 🚀 节点选择 = select [♻️ 自动切换, DIRECT, ...] 顶层默认走自动
#        - 其余原规则引用的策略组全部保留、语义无损
#   4) 头部(dns/allow-lan/mixed-port…)与 rules 原样保留
#
# 用法(服务器上)：
#   ./merge-sources.sh <当前config.yaml> [输出文件]
#     不写输出文件时打印到 stdout
#   ./merge-sources.sh /etc/mihomo/config.yaml /etc/mihomo/config.new.yaml
#     校验无问题后替换并重启：sudo systemctl restart mihomo
#
# 需要：curl(拉源) + 能够访问这些源。单个源失败会跳过，不中断。
# =============================================================
set -euo pipefail

BASE="${1:?用法: merge-sources.sh <当前config.yaml> [输出文件]}"
OUT="${2:-}"

# ---------------- ChromeGo 的 IP 更新源(与 ip_N.bat 同一批) ----------------
GITLAB="https://gitlab.com/free9999/ipupdate/-/raw/master/backup/img/1/2/ipp/clash.meta2"
MIRROR="https://www.67867867.xyz/Alvin9999/PAC/refs/heads/master/backup/img/1/2/ipp/clash.meta2"
SOURCES=()
for i in 1 2 3 4 5 6; do
  SOURCES+=("$GITLAB/$i/config.yaml")
  SOURCES+=("$MIRROR/$i/config.yaml")
done

# ---------------- 解析单个源里所有 hysteria 节点 ----------------
# 输出: "server\tport\tauth" 每节点一行
parse_nodes() {
  local url="$1"
  curl -fsSL --max-time 12 "$url" 2>/dev/null | awk '
    function flush() { if (have && server ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && port != "" && auth != "") { print server "\t" port "\t" auth } }
    /^proxy-groups:/ { flush(); exit }
    /^[[:space:]]*- name:/ { flush(); server=""; port=""; auth=""; have=0; next }
    have == 0 && /^[[:space:]]*type:[[:space:]]*"?hysteria"?[[:space:]]*$/ { have=1; next }
    have && /^[[:space:]]*server:/ { v=$0; sub(/^[[:space:]]*server:[[:space:]]*/, "", v); gsub(/["'\''\r]/, "", v); server=v; next }
    have && /^[[:space:]]*port:/ { v=$0; sub(/^[[:space:]]*port:[[:space:]]*/, "", v); gsub(/[^0-9]/, "", v); port=v; next }
    have && /^[[:space:]]*auth-str:/ { v=$0; sub(/^[[:space:]]*auth-str:[[:space:]]*/, "", v); gsub(/["'\''\r]/, "", v); auth=v; next }
    END { flush() }
  '
}

# ---------------- 收集并去重全部节点 ----------------
declare -A SEEN
NODES=()
for s in "${SOURCES[@]}"; do
  while IFS=$'\t' read -r server port auth; do
    [ -z "$server" ] && continue
    key="$server:$port"
    if [ -z "${SEEN[$key]:-}" ]; then
      SEEN[$key]=1
      NODES+=("$server|$port|$auth")
    fi
  done < <(parse_nodes "$s")
done

if [ "${#NODES[@]}" -eq 0 ]; then
  echo "错误: 所有源都抓不到可用节点(网络或源全挂)。未改动任何文件。" >&2
  exit 1
fi

echo "抓取到 ${#NODES[@]} 个去重节点:"
for n in "${NODES[@]}"; do echo "  - $n"; done

# ---------------- 从现有 config 提取"规则引用的策略组名" ----------------
groups_from_rules() {
  awk '
    /^rules:/ { s=1; next }
    s && /^[[:space:]]*- / {
      line=$0
      sub(/^[[:space:]]*-[[:space:]]*/, "", line)
      # 形如 DOMAIN,xxx 或 MATCH,组名 —— 取最后一个逗号后的部分
      idx=index(line, ","); if (idx > 0) { print substr(line, idx + 1) }
    }
  ' "$BASE"
}

# 额外兜底常用组(即便 rules 没引用也给出)
ALLNAMES="🚀 节点选择
♻️ 自动切换
🐟 漏网之鱼
🎯 全球直连
$(groups_from_rules)"
ALLNAMES=$(printf '%s\n' "$ALLNAMES" | sed '/^[[:space:]]*$/d' | sort -u)

# ---------------- 提取原头部(dns/allow-lan…) 与 rules ----------------
HEAD=$(awk '/^proxies:/ { exit } { print }' "$BASE")
RULES=$(awk '/^rules:/ { s=1 } s { print }' "$BASE")
if [ -z "$RULES" ]; then
  echo "警告: 原 config 没有 rules 段，将补一条兜底 MATCH。"
  RULES="rules:
  - MATCH,🚀 节点选择"
fi

# ---------------- 组名 -> 语义映射 ----------------
make_group() {
  local name="$1"
  case "$name" in
    *拦截*|*净化*|*广告*) printf '    proxies:\n      - REJECT\n      - DIRECT\n' ;;
    *直连*)             printf '    proxies:\n      - DIRECT\n      - 🚀 节点选择\n' ;;
    *自动*)             printf '    proxies:\n      - 🚀 节点选择\n      - DIRECT\n' ;;
    *)                  printf '    proxies:\n      - 🚀 节点选择\n      - DIRECT\n' ;;
  esac
}

# ---------------- 组装 ----------------
{
  printf '%s\n' "$HEAD"
  printf 'proxies:\n'
  i=0
  for n in "${NODES[@]}"; do
    i=$((i + 1))
    server="${n%%|*}"; rest="${n#*|}"; port="${rest%%|*}"; auth="${rest#*|}"
    printf '  - name: auto%d\n' "$i"
    printf '    type: hysteria\n'
    printf '    server: %s\n' "$server"
    printf '    port: %s\n' "$port"
    printf '    auth-str: %s\n' "$auth"
    printf '    sni: bing.com\n'
    printf '    skip-cert-verify: true\n'
    printf '    alpn:\n      - h3\n'
    printf '    protocol: udp\n'
    printf '    up: "10 Mbps"\n'
    printf '    down: "50 Mbps"\n'
  done

  printf 'proxy-groups:\n'
  # 核心: 自动切换(url-test 测活)
  printf '  - name: ♻️ 自动切换\n'
  printf '    type: url-test\n'
  printf '    url: "https://www.gstatic.com/generate_204"\n'
  printf '    interval: 60\n'
  printf '    tolerance: 150\n'
  printf '    proxies:\n'
  i=0
  for n in "${NODES[@]}"; do
    i=$((i + 1))
    printf '      - auto%d\n' "$i"
  done
  # 核心: 节点选择(顶层 select, 默认第一项 = 自动切换)
  printf '  - name: 🚀 节点选择\n'
  printf '    type: select\n'
  printf '    proxies:\n'
  printf '      - ♻️ 自动切换\n'
  printf '      - DIRECT\n'
  i=0
  for n in "${NODES[@]}"; do
    i=$((i + 1))
    printf '      - auto%d\n' "$i"
  done
  # 其余规则引用的组名
  printf '%s\n' "$ALLNAMES" | while IFS= read -r g; do
    case "$g" in
      "🚀 节点选择"|"♻️ 自动切换") continue ;;
    esac
    printf '  - name: %s\n' "$g"
    printf '    type: select\n'
    make_group "$g"
  done

  printf '%s\n' "$RULES"
} > /tmp/merge-sources.out.$$

if [ -n "$OUT" ]; then
  install -m 0644 /tmp/merge-sources.out.$$ "$OUT"
  echo "已写出: $OUT (请 diff 确认后替换并 sudo systemctl restart mihomo)"
else
  cat /tmp/merge-sources.out.$$
fi
rm -f /tmp/merge-sources.out.$$
