#!/usr/bin/env bash
# =============================================================
# merge-sources.sh —— 抓源 -> 解析节点 -> 合并去重 -> 生成 config
#
# 【和旧版的区别 —— 这是"源里几百个节点只用得上 1~2 个"的根因】
#   旧版是"按字段硬抠":
#       awk '/type:[[:space:]]*"?hysteria"?[[:space:]]*$/'
#     ^ 正则末尾是 $ 锚定的, 所以只有"字段值精确等于 hysteria"才认,
#       hysteria2 / vmess / vless / ss / trojan 一律被静默丢弃;
#       而且只读 server / port / auth-str 三个字段, sni / alpn / ws-opts
#       / reality-opts / uuid / password 全部丢失。
#
#   新版改成"按块保留":
#       从 `- name:` 到下一个节点之间的原始 YAML 原样搬过来, 只把 name 改写成 autoN。
#     好处:
#       - 支持 hysteria / hysteria2 / vmess / vless / trojan / ss / ssr /
#         socks5 / http / tuic / anytls / snell / mieru / wireguard
#       - 所有字段原样保留, 不会丢 sni / ws-opts / reality-opts / alpn ...
#       - 以后再出新协议也不用改代码
#
# 用法(服务器上):
#   ./merge-sources.sh <当前config.yaml> [输出文件]
#     不写输出文件时打印到 stdout
#
# 需要: curl(拉源) + 能访问这些源。单个源失败会跳过, 不中断。
# =============================================================
set -uo pipefail

BASE="${1:?用法: merge-sources.sh <当前config.yaml> [输出文件]}"
OUT="${2:-}"

# ---------------- 可调参数 ----------------
# 支持的节点协议(白名单)。不在列表里的会被跳过并计数。
SUPPORTED_TYPES=" hysteria hysteria2 vmess vless trojan ss ssr socks5 http tuic anytls snell mieru wireguard "

# url-test 测活间隔(秒)。
#   免费源通常只有 1~3 个节点 -> 60 秒, 掉线后切得快
#   接了订阅(几十~几百个节点) -> 建议 300, 否则内核会一直在测速
TEST_INTERVAL="${TEST_INTERVAL:-60}"

# 对 hysteria / hysteria2 节点: 源里没写 sni / skip-cert-verify 时是否补默认值。
#   免费源(ChromeGo 等)的节点多是自签证书, 不补就握手失败 -> 默认补
#   自己搭的节点有正式证书时, 补 skip-cert-verify 反而降低安全性 -> 改成 0
FILL_HYSTERIA_DEFAULTS="${FILL_HYSTERIA_DEFAULTS:-1}"

# ---------------- 节点源列表 ----------------
SOURCES_FILE="${SOURCES_FILE:-/app/config/sources.txt}"
if [ ! -f "$SOURCES_FILE" ]; then
	SOURCES_FILE="$(cd "$(dirname "$0")" && pwd)/config/sources.txt"
fi

SOURCES=()
if [ -f "$SOURCES_FILE" ]; then
	while IFS= read -r raw || [ -n "$raw" ]; do
		line="$(printf '%s' "$raw" | sed 's/[[:space:]]*#.*$//' | tr -d '[:space:]')"
		[ -z "$line" ] && continue
		if printf '%s' "$line" | grep -q '{i}'; then
			for i in 1 2 3 4 5 6; do
				SOURCES+=("$(printf '%s' "$line" | sed "s/{i}/$i/g")")
			done
		else
			SOURCES+=("$line")
		fi
	done <"$SOURCES_FILE"
	echo "源列表: $SOURCES_FILE -> 展开为 ${#SOURCES[@]} 个 URL" >&2
else
	echo "警告: 未找到源列表文件 $SOURCES_FILE" >&2
fi

# 兜底: 文件缺失或一行都没解析出来时, 回退到内置默认源
if [ "${#SOURCES[@]}" -eq 0 ]; then
	GITLAB="https://gitlab.com/free9999/ipupdate/-/raw/master/backup/img/1/2/ipp/clash.meta2"
	MIRROR="https://www.67867867.xyz/Alvin9999/PAC/refs/heads/master/backup/img/1/2/ipp/clash.meta2"
	for i in 1 2 3 4 5 6; do
		SOURCES+=("$GITLAB/$i/config.yaml")
		SOURCES+=("$MIRROR/$i/config.yaml")
	done
	echo "已回退到内置默认源: ${#SOURCES[@]} 个 URL" >&2
fi

# ---------------- 工具函数 ----------------

# 从一段节点 YAML 里取字段值(忽略缩进, 支持 "- key: v" 形式)
yaml_field() {
awk -v want="$1" '
	{
		line = $0
		sub(/^[[:space:]]+/, "", line)      # 先去掉缩进
		sub(/^-[[:space:]]*/, "", line)     # 再去掉列表标记 "- "
		if (line ~ ("^" want ":[[:space:]]*")) {
			v = line
			sub(("^" want ":[[:space:]]*"), "", v)
			# 去掉首尾引号 / 行尾注释 / 空白
			gsub(/^["\047]|["\047]$/, "", v)
			sub(/[[:space:]]+#.*$/, "", v)
			gsub(/[[:space:]]+$/, "", v)
			print v
			exit
		}
	}'
}

# 把 proxies: 段切成"一块一个节点", 块之间用 ASCII 0x1E 分隔。
# 只在行首为 "- name:" 时开新块 -> 嵌套的 "- h3"(alpn) 之类不会被误切。
# 注意: 行内流式写法("- {name: ...}")不支持, 会被跳过。
extract_blocks() {
	awk '
		BEGIN { ins = 0; buf = "" }
		/^proxies:[[:space:]]*(\[\])?[[:space:]]*$/ { ins = 1; next }
		ins && /^[^[:space:]#]/ {
			if (buf != "") { printf "%s\036", buf; buf = "" }
			ins = 0; next
		}
		ins {
			if ($0 ~ /^[[:space:]]*-[[:space:]]*\{/) {
				# 流式写法("- {name: ...}")不支持: 结束当前块并丢掉这一行,
				# 否则它会被当成上一个节点的续行, 污染那个节点
				if (buf != "") { printf "%s\036", buf; buf = "" }
				next
			}
			if ($0 ~ /^[[:space:]]*-[[:space:]]*name[[:space:]]*:/) {
				if (buf != "") printf "%s\036", buf
				buf = $0
			} else if (buf != "") {
				buf = buf "\n" $0
			}
		}
		END { if (buf != "") printf "%s\036", buf }
	'
}

# 输出一个节点块(把 name 改写成 autoN, 并按需补 hysteria 默认字段)
emit_node() {
	local idx="$1" blk="$2"
	printf '%s\n' "$blk" | awk -v n="$idx" -v fill="$FILL_HYSTERIA_DEFAULTS" '
		NR == 1 {
			match($0, /^[[:space:]]*/)
			lead = substr($0, 1, RLENGTH)   # "- name:" 前面的缩进
			fld = lead "  "                 # 字段缩进(比 name 再深一级)
			printf "%s- name: auto%d\n", lead, n
			next
		}
		{
			printf "%s\n", $0
			line = $0
			sub(/^[[:space:]]+/, "", line)
			if (line ~ /^sni:/) has_sni = 1
			if (line ~ /^skip-cert-verify:/) has_skip = 1
			if (line ~ /^up:/) has_up = 1
			if (line ~ /^down:/) has_down = 1
			if (line ~ /^type:[[:space:]]*"?hysteria2?"?[[:space:]]*$/) is_hys = 1
		}
		END {
			if (fill == "1" && is_hys) {
				# hysteria(v1) 的 up/down 是「必填」—— 不写 mihomo 启动直接报
				#   proxy 0: has unset fields: down, up
				# 免费源(ChromeGo)的节点不带这两个字段, 所以必须补。
				if (!has_up)   printf "%sup: \"10 Mbps\"\n", fld
				if (!has_down) printf "%sdown: \"50 Mbps\"\n", fld
				if (!has_sni)  printf "%ssni: bing.com\n", fld
				if (!has_skip) printf "%sskip-cert-verify: true\n", fld
			}
		}'
}

# 明显无效的 server: 空 / 本机 / 私有网段(公开源里有把 server 指向 127.0.0.53 的假节点)
is_bad_server() {
	local s="$1"
	[ -z "$s" ] && return 0
	case "$s" in
	*/* | *" "* | *"://"*) return 0 ;;
	localhost | localhost.localdomain | ::1 | "[::1]") return 0 ;;
	127.* | 0.* | 10.* | 192.168.* | 169.254.* | 100.6[4-9].* | 100.[7-9][0-9].* | 100.1[0-2][0-9].*) return 0 ;;
	172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) return 0 ;;
	esac
	return 1
}

is_supported_type() {
	case "$SUPPORTED_TYPES" in
	*" $1 "*) return 0 ;;
	esac
	return 1
}

# ---------------- 收集并去重全部节点 ----------------
declare -A SEEN
NODES=()
STAT_TYPES=()   # 不支持的协议名(去重后用于提示)
SEEN_BADTYPE=" "
n_dup=0
n_badaddr=0
n_badtype=0
n_nonclash=0
n_fail=0

for s in "${SOURCES[@]}"; do
	tmp="$(mktemp)"
	if ! curl -fsSL --max-time 15 "$s" -o "$tmp" 2>/dev/null; then
		echo "[源] 抓取失败, 跳过: $s" >&2
		n_fail=$((n_fail + 1))
		rm -f "$tmp"
		continue
	fi

	if ! grep -q '^proxies:' "$tmp"; then
		echo "[源] 不是 Clash YAML 格式(可能是 base64 / v2ray 订阅), 跳过: $s" >&2
		n_nonclash=$((n_nonclash + 1))
		rm -f "$tmp"
		continue
	fi

	n_this=0
	while IFS= read -r -d $'\036' blk; do
		[ -z "$blk" ] && continue

		type="$(printf '%s\n' "$blk" | yaml_field type)"
		if ! is_supported_type "$type"; then
			n_badtype=$((n_badtype + 1))
			if [ -n "$type" ] && [ "${SEEN_BADTYPE#* $type }" = "$SEEN_BADTYPE" ]; then
				SEEN_BADTYPE="$SEEN_BADTYPE$type "
				STAT_TYPES+=("$type")
			fi
			continue
		fi

		server="$(printf '%s\n' "$blk" | yaml_field server)"
		port="$(printf '%s\n' "$blk" | yaml_field port)"
		if is_bad_server "$server" || ! printf '%s' "$port" | grep -Eq '^[0-9]{1,5}$'; then
			n_badaddr=$((n_badaddr + 1))
			continue
		fi

		# 去重键: 协议 + 地址 + 端口 + 凭据(凭据只用于比较, 不打印)
		auth="$(printf '%s\n' "$blk" | yaml_field uuid)"
		[ -z "$auth" ] && auth="$(printf '%s\n' "$blk" | yaml_field password)"
		[ -z "$auth" ] && auth="$(printf '%s\n' "$blk" | yaml_field auth-str)"
		key="$type|$server|$port|$auth"
		if [ -n "${SEEN[$key]:-}" ]; then
			n_dup=$((n_dup + 1))
			continue
		fi
		SEEN[$key]=1
		NODES+=("$blk")
		n_this=$((n_this + 1))
	done < <(extract_blocks <"$tmp")

	echo "[源] $s -> $n_this 个可用节点" >&2
	rm -f "$tmp"
done

if [ "${#NODES[@]}" -eq 0 ]; then
	echo "错误: 所有源都抓不到可用节点。未改动任何文件。" >&2
	echo "  抓取失败源: $n_fail | 非 Clash 格式: $n_nonclash | 不支持的协议: $n_badtype | 地址无效: $n_badaddr" >&2
	exit 1
fi

{
	echo "抓到 ${#NODES[@]} 个去重节点(重复跳过 $n_dup, 地址无效 $n_badaddr, 不支持协议 $n_badtype):"
	i=0
	for blk in "${NODES[@]}"; do
		i=$((i + 1))
		t="$(printf '%s\n' "$blk" | yaml_field type)"
		sv="$(printf '%s\n' "$blk" | yaml_field server)"
		pt="$(printf '%s\n' "$blk" | yaml_field port)"
		printf '  auto%-3d %-10s %s:%s\n' "$i" "$t" "$sv" "$pt"
	done
	if [ "${#STAT_TYPES[@]}" -gt 0 ]; then
		echo "  (跳过的协议: ${STAT_TYPES[*]})"
	fi
} >&2

# ---------------- 从现有 config 提取"规则引用的策略组名" ----------------
groups_from_rules() {
	awk '
		/^rules:/ { s=1; next }
		s && /^[[:space:]]*- / {
			line=$0
			sub(/^[[:space:]]*-[[:space:]]*/, "", line)
			sub(/[[:space:]]*#.*$/, "", line)
			# 取「最后一个」逗号后的部分 —— 规则格式是 TYPE,ARG,目标组,
			# 目标组永远在末尾。取第一个逗号会把 DOMAIN-SUFFIX,google.com,🚀 节点选择
			# 解析成 "google.com,🚀 节点选择", 生成一堆垃圾策略组。
			n = split(line, a, ",")
			if (n >= 2) {
				g = a[n]
				gsub(/^[[:space:]]+|[[:space:]]+$/, "", g)
				if (g != "") print g
			}
		}
	' "$BASE"
}

ALLNAMES="🚀 节点选择
♻️ 自动切换
🐟 漏网之鱼
🎯 全球直连
$(groups_from_rules)"
# 去掉空行、重复项, 以及内置目标(DIRECT/REJECT 等 —— 它们不是策略组, 不需要生成)
ALLNAMES=$(printf '%s\n' "$ALLNAMES" |
	sed '/^[[:space:]]*$/d' |
	sort -u |
	grep -vxE 'DIRECT|REJECT|REJECT-DROP|PASS|COMPATIBLE|GLOBAL|DIRECT-[A-Za-z]*')

# ---------------- 提取原头部(dns/allow-lan…) 与 rules ----------------
HEAD=$(awk '/^proxies:/ { exit } { print }' "$BASE")
RULES=$(awk '/^rules:/ { s=1 } s { print }' "$BASE")
if [ -z "$RULES" ]; then
	echo "警告: 原 config 没有 rules 段, 将补一条兜底 MATCH。" >&2
	RULES="rules:
  - MATCH,🚀 节点选择"
fi

# ---------------- 组名 -> 语义映射 ----------------
make_group() {
	local name="$1"
	case "$name" in
	*拦截* | *净化* | *广告*) printf '    proxies:\n      - REJECT\n      - DIRECT\n' ;;
	*直连*) printf '    proxies:\n      - DIRECT\n      - 🚀 节点选择\n' ;;
	*自动*) printf '    proxies:\n      - 🚀 节点选择\n      - DIRECT\n' ;;
	*) printf '    proxies:\n      - 🚀 节点选择\n      - DIRECT\n' ;;
	esac
}

# ---------------- 组装 ----------------
{
	printf '%s\n' "$HEAD"
	printf 'proxies:\n'
	i=0
	for blk in "${NODES[@]}"; do
		i=$((i + 1))
		emit_node "$i" "$blk"
	done

	printf 'proxy-groups:\n'
	# 自动切换: url-test 测活, 坏节点自动摘除、自动用活的
	printf '  - name: ♻️ 自动切换\n'
	printf '    type: url-test\n'
	printf '    url: "https://www.gstatic.com/generate_204"\n'
	printf '    interval: %s\n' "$TEST_INTERVAL"
	printf '    tolerance: 150\n'
	printf '    proxies:\n'
	i=0
	for blk in "${NODES[@]}"; do
		i=$((i + 1))
		printf '      - auto%d\n' "$i"
	done

	# 顶层选择组, 默认指向自动切换
	printf '  - name: 🚀 节点选择\n'
	printf '    type: select\n'
	printf '    proxies:\n'
	printf '      - ♻️ 自动切换\n'
	printf '      - DIRECT\n'
	i=0
	for blk in "${NODES[@]}"; do
		i=$((i + 1))
		printf '      - auto%d\n' "$i"
	done

	# 其余规则引用的组名
	printf '%s\n' "$ALLNAMES" | while IFS= read -r g; do
		case "$g" in
		"🚀 节点选择" | "♻️ 自动切换") continue ;;
		esac
		printf '  - name: %s\n' "$g"
		printf '    type: select\n'
		make_group "$g"
	done

	printf '%s\n' "$RULES"
} >/tmp/merge-sources.out.$$

if [ -n "$OUT" ]; then
	install -m 0644 /tmp/merge-sources.out.$$ "$OUT"
	echo "已写出: $OUT"
else
	cat /tmp/merge-sources.out.$$
fi
rm -f /tmp/merge-sources.out.$$
