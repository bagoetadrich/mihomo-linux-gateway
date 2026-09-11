# mihomo-linux-gateway

把 Windows 上现成的 Clash.Meta 配置（例如 ChromeGo 便携包）改造成 **Linux 服务器代理网关**的一键落地包。ZeroTier 网段里的所有设备（Windows / Linux / 手机 / 平板）只要把代理指向这台服务器，就全都有了出口。

> 相关博客：
> - [《全局代理折腾记：从"只有 Chrome 能用"到 Windows 临时当网关》](https://tblog.bagoet.cn/posts/network-proxy/chromego-clash-meta-global-proxy/)（问题排查与临时网关方案）
> - [《把代理装进服务器：ZeroTier 全网共用一台出口》](https://tblog.bagoet.cn/posts/network-proxy/mihomo-server-zerotier-gateway/)（本文档对应的教程）

## 5 分钟速通

```bash
# ① Windows（Git Bash）里生成服务器版配置 —— 只改顶层字段，节点/规则原样保留
cd /d/项目外/mihomo-linux-gateway
./migrate-config.sh "/d/ChromeGo/clash.meta/config.yaml" "/d/ChromeGo/clash.meta"
ls config.yaml Country.mmdb GeoSite.dat ruleset/     # 确认生成物齐全

# ② 整目录传到服务器
scp -r /d/项目外/mihomo-linux-gateway root@<服务器>:/opt/

# ③ 服务器上：看一眼配置 → 安装（systemd 方式）
ssh root@<服务器>
cd /opt/mihomo-linux-gateway
grep -nE '^(allow-lan|bind-address|mixed-port):' config.yaml
sudo ./install.sh

# ④ 确认监听的是 0.0.0.0:7890，而不是 127.0.0.1
systemctl status mihomo && ss -lntp | grep 7890

# ⑤ 防火墙只放行 ZeroTier 网段（先保 SSH）
sudo ufw allow 22/tcp
sudo ufw allow from <你的网段>/16 to any port 7890 proto tcp
sudo ufw enable

# ⑥ 任意一台 ZT 内设备验证
curl -x http://<服务器ZT-IP>:7890 https://ipinfo.io/ip
```

> 不想装 systemd 服务？用 Docker 方式：`docker compose up -d`（见下文「方式二」）。

## 设计原则

- **配置单一来源**：不改你的 `proxies` / 策略组 / 规则，只调顶层字段。因此**不会**把含节点信息的配置复制进仓库，避免泄密面扩大。
- 节点更新时：还是更新你原来的 ChromeGo / 订阅，然后重新跑一次迁移即可。
- 只做网关（`allow-lan` 共享），TUN 作为可选进阶。

## 目录结构

```
mihomo-linux-gateway/
├─ README.md                 # 本文档
├─ config/
│  ├─ sources.txt            # ★ 节点源列表(每行一个 URL, {i} 展开为 1..6)
│  └─ devices.json           # (可选) 给设备起名: {"10.147.0.5": "我的手机"}
├─ panel/                    # ★ 管理面板(零依赖 Node, 无构建步骤)
│  ├─ server.js              #   后端: API 反代 + 运维接口 + 静态托管
│  ├─ lib/{core,stats,auth}.js
│  ├─ web/{index.html,app.js,style.css}
│  ├─ Dockerfile
│  └─ package.json
├─ migrate-config.sh         # （systemd 方式）读 Windows 配置 → 生成服务器版 config.yaml
├─ merge-sources.sh          # 读 config/sources.txt → 抓源 → 去重合并 → url-test 自动切换池
├─ config.base.yaml          # 公共基础模板(无节点)，纯 Docker 自举时作为底料
├─ bootstrap.sh              # bootstrap 容器入口：模板 + merge 生成 ./data/config.yaml
├─ Dockerfile.bootstrap      # bootstrap 轻量镜像(alpine+curl)，不含内核
├─ up.sh                     # 服务器一键：生成 .env→构建→生成节点池→docker compose up
├─ .env.example              # 环境变量示例(面板密码/监听地址等)
├─ docker-compose.yml        # Docker 方式(bootstrap + 官方 mihomo 镜像 + panel)
├─ install.sh                # （systemd 方式）服务器安装脚本
├─ patch-lan.sh              # config 被覆盖后一键恢复 allow-lan/bind-address
├─ mihomo.service            # systemd 单元
├─ mihomo-node-update.{service,timer}   # （可选）systemd 定时自动刷节点池
└─ .gitignore                # 迁移产物/节点池/数据目录/.env 不入库
```

> `config.yaml`（含节点池）、`Country.mmdb`、`GeoSite.dat`、`ruleset/`、`data/` 均已被 `.gitignore` 挡住，不会提交——仓库里永远只有工程代码与公共模板。

迁移后还会在本地生成（已 gitignore，勿提交）：`config.yaml`、`Country.mmdb`、`GeoSite.dat`、`ruleset/`。

## 快速开始（三步）

### 1. 在 Windows / 任何有 bash 的地方生成配置

```bash
# <config> 是你的 Windows 配置，<clash目录> 是 ChromeGo 的 clash.meta 目录（提供规则资源）
./migrate-config.sh "/mnt/d/ChromeGo/clash.meta/config.yaml" "/mnt/d/ChromeGo/clash.meta"
```

脚本只做这些事，其余内容原样保留：

- `allow-lan: false` → `true`
- 顶层没有 `bind-address` 就补 `bind-address: 0.0.0.0`
- 顶层没有 `mixed-port` 就补 `mixed-port: 7890`
- 顶部 `secret`（常被源配置用作无关标记）注释掉

### 2. 传到服务器并安装

```bash
# 把整个仓库（含生成的 config.yaml）传到服务器
scp -r mihomo-linux-gateway root@<server>:/opt/

ssh root@<server>
cd /opt/mihomo-linux-gateway
./install.sh                 # 自动下载最新 mihomo 内核 + 放置配置 + 启动服务
journalctl -u mihomo -o cat -f
```

### 3. 防火墙只放行 ZeroTier 网段

```bash
# 把网段换成你 ZeroTier 的实际网段
sudo ufw allow from 10.147.0.0/16 to any port 7890 proto tcp
```

> 监听是 `0.0.0.0`，但**别让公网连到 7890**。ZeroTier 网段固定，用它精确限源；不信任的网内设备再考虑 `authentication`（代价是 URL 会带密码，能不加就不加）。

## 方式二（推荐）：纯 Docker 一键自举

**不需要本地 ChromeGo、不需要 migrate、不需要手动传 config。** 服务器 `git clone` 后一条命令，节点池由镜像自己从公开源拉取生成：

```bash
# 服务器(已装 docker + compose v2)
git clone https://github.com/bagoetadrich/mihomo-linux-gateway.git /opt/mihomo-gateway
cd /opt/mihomo-gateway
./up.sh
```

`up.sh` 做了什么（以后每次启动/刷新都跑它）：

0. 首次运行生成 `.env`（含**随机面板密码**），之后复用
1. 构建 `bootstrap` / `panel` 镜像
2. 跑一次 `bootstrap`：按 `config/sources.txt` 抓源 → 去重合并 → 用内置 `config.base.yaml` 生成 `./data/config.yaml`；本次拉源全挂但已有旧 config 时**沿用旧配置不中断**
3. `docker compose up -d` 启动 mihomo（官方镜像，`0.0.0.0:7890`）与 panel（`0.0.0.0:9091`）

跑完会打印面板地址和密码。

日常运维：

| 操作 | 命令 |
| --- | --- |
| 启动 / 查看 | `./up.sh` → `docker compose ps` / `docker compose logs -f` |
| 打开管理面板 | 浏览器访问 `http://<服务器IP>:9091`（密码见 `.env`） |
| 立刻刷新一次节点池 | 面板「运维 → 刷新节点池」，或 `docker compose run --rm bootstrap && docker compose restart mihomo` |
| 改节点源 | 编辑 `config/sources.txt`，或面板「节点源」页在线改 |
| 定时自动刷新（可选） | 宿主机 cron：`0 */6 * * * cd /opt/mihomo-gateway && docker compose run --rm bootstrap && docker compose restart mihomo` |
| 更新工程代码 | `git pull && ./up.sh` |
| 看生成的节点池 | `cat data/config.yaml`（仅本机，不入 git） |

设计点：

- **`network_mode: host`**：容器直接复用宿主网络栈，看得见 ZeroTier 虚拟网卡，也免端口映射（`0.0.0.0:7890` 依旧受宿主机 ufw 约束）
- **两个服务共享 `./data`**：bootstrap 负责生成 config，mihomo 官方镜像加载它；`depends_on: service_completed_successfully` 保证配置先生成好
- **不依赖构建时访问 GitHub**：内核来自 `metacubex/mihomo:latest` 官方镜像，bootstrap 只装 curl/bash
- **`user: root`** 避免 ./data 写权限问题（单用户内网网关可接受；介意可去掉并自行 `chown`）
- 防火墙照旧在**宿主机**配 ufw，只放行 ZeroTier 网段到 7890

## 管理面板（panel）

`./up.sh` 会额外起一个 `panel` 容器。浏览器打开 **`http://<服务器IP>:9091`** 就能管理整套网关，不用再 SSH 敲命令。

**登录密码**在首次 `./up.sh` 时随机生成，写在仓库根目录的 `.env`（已 gitignore），`up.sh` 结束时会打印出来。忘了就查：

```bash
grep PANEL_PASSWORD .env
```

### 面板能做什么

| 页面 | 内容 |
| --- | --- |
| **概览** | 实时上行/下行速率、今日/本月/累计流量、速率曲线、CPU/内存/磁盘/负载、容器状态与一键重启 |
| **设备与连接** | 按来源 IP 聚合的「设备」视图 + 逐条连接明细（目标域名、命中规则、代理链路、上下行字节） |
| **节点** | 策略组切换、节点列表、单个/全部测速 |
| **日志** | mihomo 容器日志实时滚动（可暂停、清屏、重连） |
| **节点源** | 在线编辑 `config/sources.txt`，保存后一键刷新节点池 |
| **运维** | 刷新节点池、重启 mihomo、流量统计清零、容器启停 |

> **为什么流量统计要自己做？** mihomo 的 API 只给「每条活动连接当前的字节数」和「瞬时速率」；连接一关数据就没了。所以 panel 每 2 秒采样一次 `/connections`，按增量累加，并定期落盘到 `data/panel/traffic.json`，重启不丢。

**给设备起名字**：默认按 RFC1918 粗分（内网 / 局域网）。想显示成"我的手机"这种，编辑 `config/devices.json`：

```json
{
  "10.147.0.5": "我的手机",
  "10.147.0.2": "工作笔记本"
}
```

也可以在 `.env` 里设 `ZT_NETS` / `VPN_NETS`（逗号分隔的 IP 前缀），让某个网段整体显示成"ZeroTier 设备"。**这两个值不会写进仓库代码里。**

### 节点源现在是一个文件

以前源列表写死在 `merge-sources.sh` 里，现在抽到了 **`config/sources.txt`**：

```
# 每行一个 URL；含 {i} 的行会展开成 1..6（对应 ChromeGo 的 ip_1..ip_6）
https://gitlab.com/free9999/ipupdate/.../clash.meta2/{i}/config.yaml
https://www.67867867.xyz/Alvin9999/PAC/.../clash.meta2/{i}/config.yaml
```

改它有两种方式，效果完全一样：

- 直接编辑文件 → `./up.sh`
- 面板「节点源」页改 → 点「保存并刷新节点池」

保存时会自动把旧文件备份成 `config/sources.txt.bak`。**文件缺失或一行都没解析出来时，会自动回退到内置默认源**，不会把网关搞挂。

### 面板的安全边界（务必看）

面板能控制容器和整个代理链路，等于服务器上的一把钥匙：

- **不要暴露到公网。** 默认监听 `0.0.0.0:9091`，意思是**局域网 + ZeroTier 都能访问**。
- **只想让 ZeroTier 访问**：把 `.env` 里 `PANEL_LISTEN` 改成服务器的 ZeroTier IP，再 `docker compose up -d panel`。
  ```
  PANEL_LISTEN=10.146.11.235
  ```
- **配合防火墙限源**：
  ```bash
  sudo ufw allow from <你的网段>/16 to any port 9091 proto tcp
  ```
- **它挂了 `/var/run/docker.sock`** —— 这是「一键重启容器」的前提，但**等价于把宿主机 root 权限交给了这个容器**。自用可以接受；如果你介意，把 `docker-compose.yml` 里 panel 的那行 socket 挂载删掉即可 —— 代价是失去重启容器的能力，**其余功能不受影响**。
  > 注意：**不要**给它加 `:ro`。重启容器是写操作，只读挂载会让「一键重启」直接报错。
- 面板自身有**密码 + 签名 Cookie**（HttpOnly / SameSite=Strict），写操作还额外要求自定义请求头做 CSRF 防护。

### 邮件告警（面板「运维」页）

面板内置了**邮件告警**：节点全挂 / 容器宕机 / API 失联 / 磁盘快满时，主动给你发邮件。

在面板「运维 → 邮件告警」里：

1. 勾选「启用邮件告警」
2. 填 SMTP 信息（服务器 / 端口 / 用户名 / 密码 / 发信地址 / 收件人）
3. 点「发送测试邮件」验证配置
4. 点「保存设置」

行为：

- 只在**状态变化**时发信（正常→异常发一封「告警」，异常→正常发一封「恢复」）
- 一直没恢复的话，每 N 小时提醒一次（默认 6 小时）
- 最核心的检查项是「**所有节点均不可用**」：它会对策略组里每个节点做一次真实测速，一个都不通才发信

> 隐私：SMTP 密码只存在服务器上的 `data/panel/alerts.json`（已 gitignore），前端回显永远是打码的（`__SET__`），也不会写进日志。
>
> 常见端口：`465` 走 SSL/TLS（QQ 企业邮箱就是这个）；`587`/`25` 走 STARTTLS。都支持。
>
> 也可以在 `.env` 里用 `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` / `SMTP_FROM_NAME` / `ALERT_TO` / `ALERT_ENABLED` 预填（见 `.env.example`）。

### mihomo 的管理 API

面板要工作，mihomo 必须开管理 API —— `config.base.yaml` 里已经默认加好了：

```yaml
external-controller: 127.0.0.1:9090
```

**绑定回环**：只有宿主机本地进程和 host 网络的 panel 容器能访问，**不会暴露到网络**。

想把它开放给别的面板（例如自建一个 zashboard），那必须同时加 `secret`：

```yaml
external-controller: 0.0.0.0:9090
secret: "换成你自己的长密码"
```

然后在 `docker-compose.yml` 的 panel 服务里把 `MIHOMO_SECRET` 设成同一个值（面板会自动带上 `Authorization` 头）。

## 各端怎么接入

所有设备统一填**同一个地址**：`<服务器 ZeroTier IP>:7890`

| 端 | 设置 |
| --- | --- |
| Windows | 设置 → 网络 → 代理 → 手动：地址填服务器 ZeroTier IP，端口 7890 |
| 手机 / 平板 | 先连 ZeroTier App，再在 WiFi/应用代理设置里填同一个地址 |
| Linux | 桌面走系统代理；命令行 `export` / `proxyon`（见博客） |
| WSL2 | 填 Windows 主机的 ZeroTier IP（即服务器 IP） |
| docker pull | 配 `docker.service.d/proxy.conf`（dockerd 不吃 shell 变量） |
| SSH 克隆 | `~/.ssh/config` 加 `ProxyCommand nc -X connect -x <ip>:7890 %h %p` |

验证（任一台设备）：

```bash
curl -x http://<服务器ZeroTierIP>:7890 https://ipinfo.io/ip
```

## 日常运维

| 操作 | 命令 |
| --- | --- |
| 看状态 | `systemctl status mihomo` |
| 看日志 | `journalctl -u mihomo -o cat -f` |
| 重载配置 | `sudo systemctl reload mihomo` |
| 重启 | `sudo systemctl restart mihomo` |
| 更新节点后 | 重新 `migrate-config.sh` → `scp` → `sudo systemctl restart mihomo` |
| config 被覆盖后 | `sudo ./patch-lan.sh` → `sudo systemctl restart mihomo` |

## 进阶：服务器本机也要全接管（TUN）

网关模式只让**其他设备**走代理；服务器自己跑 apt / docker / cron 默认仍是直连。想让服务器本机也全部接管，把 `mihomo.service` 里注释的两行 `CapabilityBoundingSet=...` / `AmbientCapabilities=...` 放开（需要 `CAP_NET_ADMIN`），并在 config 中加 `tun` 段：

```yaml
tun:
  enable: true
  stack: mixed
  device: mihomo-tun
  auto-route: true
  auto-detect-interface: true
  strict-route: false
  dns-hijack:
    - any:53
    - tcp://any:53
```

**改远端网络配置前，务必留一条不走代理的退路**（ZeroTier IP 直连或带外管理），`strict-route` 先保持 `false`。

若走 **Docker 方式**开 TUN：在 `docker-compose.yml` 里放开 `cap_add` 的 `NET_ADMIN`/`NET_RAW`，并取消 `devices: - /dev/net/tun:/dev/net/tun` 那两行注释（宿主需存在该设备）。

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| docker 日志报 `bind: address already in use` | 宿主机已有旧 mihomo / 另一套部署占着 7890 | systemd 与 Docker **二选一**：`sudo systemctl disable --now mihomo` 或 `docker compose down`，再重启选中的那套 |
| `netstat` 只见 `127.0.0.1:7890` | 配置被更新覆盖成 `allow-lan: false` | `sudo ./patch-lan.sh` + restart |
| 设备连不上 7890 | 防火墙没放行 / 不在同一 ZeroTier 网段 | `ufw allow from <网段> ...`；确认入网 |
| 服务器 `curl` 通但 `docker pull` 不通 | dockerd 不继承 shell 变量 | 配 `docker.service.d/proxy.conf` |
| SSH 克隆不通、HTTPS 通 | SSH 无视 `http_proxy` | 配 `ProxyCommand` |
| 开了代理反而内网连不上 | 缺 `no_proxy` | Linux 侧补 `no_proxy` |
| `ping` 不通但 `curl` 正常 | ICMP 不在代理范围 | 正常现象 |
| 公网扫到 7890 | 没限源 | `ufw` 只放行 ZeroTier 网段 |

## 进阶：多源自动切换（免费漂移节点的自愈）

ChromeGo 这类免费节点 IP 会周期性漂移，单节点配置一旦 IP 失效就全断。仓库提供了 `merge-sources.sh`，把"手动跑 ip 更新"变成服务器上的自动闭环：

```bash
# 手动跑一次（抓 ChromeGo 全部镜像源 -> 合并去重 -> 生成新 config）
cd /opt/mihomo-linux-gateway
./merge-sources.sh /etc/mihomo/config.yaml /etc/mihomo/config.yaml.new
# 人工确认无异常后
sudo mv /etc/mihomo/config.yaml.new /etc/mihomo/config.yaml
sudo systemctl restart mihomo
```

它做了什么：

- 抓取 ChromeGo 的 6 个镜像源（gitlab + 备用域，单源失败自动跳过），解析各自 hysteria 节点，按 `server:port` 去重
- `proxies` 换成合并后的全部节点；新增 `♻️ 自动切换`（`url-test`，每 60s 测活，**坏 IP 自动摘除、自动用活 IP**）
- `🚀 节点选择` 顶层组默认指向自动切换；原 rules 引用的策略组全部保留
- 头部（`allow-lan`/`mixed-port`/`dns` 等）与 `rules` 原样保留，只换节点池

定时自愈（可选，推荐）：

```bash
sudo cp mihomo-node-update.service mihomo-node-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mihomo-node-update.timer   # 每天 05:30 / 17:30 自动刷新并重启 mihomo
systemctl list-timers mihomo-node-update.timer         # 确认已生效
```

> 提醒：源里的免费节点随时可能全部失效；若两三个周期后节点全红，说明需要换一套源 —— 编辑 **`config/sources.txt`**（或在管理面板的「节点源」页改），再跑一次 `./up.sh`（或点面板上的「刷新节点池」）。

## 国内直连分流

默认 `config.base.yaml` 已带"国内直连、其余走代理"分流：

```yaml
rules:
  - GEOSITE,cn,DIRECT    # 中国域名 -> 直连(不绕代理)
  - GEOIP,CN,DIRECT      # 中国 IP  -> 直连
  - MATCH,🚀 节点选择      # 其余     -> 自动切换节点
```

geo 数据（`geosite.dat` / `geoip.dat`）由 `bootstrap.sh` 启动时从 jsdelivr 多 CDN 自动下载到 `data/`：

- 下载成功：按上面规则分流（本地实测：百度/QQ 走 `DIRECT`，GitHub 走代理）
- 全部 CDN 失败：自动注释掉 `GEOSITE/GEOIP` 两条，**退化为全流量走代理**，网关仍可用，不会因缺数据启动失败
- 想调整分流：改 `config.base.yaml` 的 `rules` 段，再跑一次 `./up.sh`

## 安全与合规

- 仓库内不要提交 `config.yaml`、`Country.mmdb`、`GeoSite.dat`、`ruleset/`、`.env`、`data/`（均已在 `.gitignore`）
- 导出/下载得到的订阅配置文件（形如 `Clash_*.yaml`）含节点凭据，**已被 `.gitignore` 挡住，也不要手动 `git add -f`**
- 管理面板（9091）能控制容器与整个代理链路：**不要暴露到公网**，建议只在内网 / ZeroTier 使用并配合防火墙限源
- mihomo 管理 API（9090）默认只绑回环；若要对外监听，务必同时设置 `secret`
- 给 ZeroTier 网内设备提供出口前，先想清楚信任边界
- 使用请遵守所在网络环境的管理规定，本项目只负责自有设备之间的流量转发
