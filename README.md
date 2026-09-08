# mihomo-linux-gateway

把 Windows 上现成的 Clash.Meta 配置（例如 ChromeGo 便携包）改造成 **Linux 服务器代理网关**的一键落地包。ZeroTier 网段里的所有设备（Windows / Linux / 手机 / 平板）只要把代理指向这台服务器，就全都有了出口。

> 相关博客：
> - [《全局代理折腾记：从"只有 Chrome 能用"到 Windows 临时当网关》](https://tblog.bagoet.cn/posts/chromego-clash-meta-global-proxy/)（问题排查与临时网关方案）
> - [《把代理装进服务器：ZeroTier 全网共用一台出口》](https://tblog.bagoet.cn/posts/mihomo-server-zerotier-gateway/)（本文档对应的教程）

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
├─ README.md            # 本文档
├─ migrate-config.sh    # 读 Windows 配置 → 生成服务器版 config.yaml（+复制规则资源）
├─ install.sh           # 服务器上：下载内核、放配置、注册 systemd
├─ patch-lan.sh         # config 被覆盖后一键恢复 allow-lan/bind-address
├─ mihomo.service       # systemd 单元
├─ docker-compose.yml   # （可选）Docker Compose 方式
└─ .gitignore           # 迁移产物与规则资源不入库
```

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

## 方式二：Docker Compose（可选，替代上面的 install.sh）

不想在宿主机装 systemd 服务时用 Compose。目录已经带了 `docker-compose.yml`：

```bash
# 前提：已用 migrate-config.sh 生成好 config.yaml 与规则资源
docker compose up -d
docker compose ps            # 健康状态
docker compose logs -f       # 看日志
```

几个设计点：

- **`network_mode: host`**：容器复用宿主机网络栈，能直接看到 ZeroTier 虚拟网卡——网关场景基本必须 host 网络，别用默认 bridge（那会看不到 ZT 网卡，还要绕端口映射）
- **挂载 `./` 到 `/etc/mihomo`**：容器用的就是宿主机上那份 migrate 产物；更新节点后 `docker compose restart` 即生效
- **`cap_add` 的 `NET_ADMIN`/`NET_RAW` 默认注释意义**：纯网关共享用不上；哪天开 TUN 再放开
- **文件权限**：mihomo 官方镜像默认非 root 运行；若容器报读配置权限错误，给 `config.yaml` 等挂载文件 `chmod 644`（单用户服务器可接受，介意就把镜像换成 root 运行的构建）
- 防火墙照旧在**宿主机**配（第五步的 ufw 规则），host 网络下容器不受 docker 自身 iptables 影响

日常运维对照：

| 操作 | systemd 方式 | Docker 方式 |
| --- | --- | --- |
| 启动/开机自启 | `sudo systemctl enable --now mihomo` | `docker compose up -d` |
| 看日志 | `journalctl -u mihomo -o cat -f` | `docker compose logs -f` |
| 重载配置 | `sudo systemctl reload mihomo` | 先 `patch-lan.sh` 或换 config，再 `docker compose restart` |
| config 被覆盖 | `sudo ./patch-lan.sh && sudo systemctl restart mihomo` | `sudo ./patch-lan.sh && docker compose restart` |

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

## 安全与合规

- 仓库内不要提交 `config.yaml`、`Country.mmdb`、`GeoSite.dat`、`ruleset/`（已在 `.gitignore`）
- 给 ZeroTier 网内设备提供出口前，先想清楚信任边界
- 使用请遵守所在网络环境的管理规定，本项目只负责自有设备之间的流量转发
