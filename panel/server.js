// ============================================================
// server.js —— mihomo-linux-gateway 管理面板
//
// 职责：
//   1) 反代 mihomo external-controller（解决跨域，且 mihomo API 不必对外暴露）
//   2) 补充 mihomo 做不到的运维能力：
//        重启容器 / 刷新节点池 / 增删节点源 / 累计流量 / 系统状态
//   3) 托管静态前端（无构建步骤）
//
// 全部零依赖，只用 Node 内置模块。
// ============================================================
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	MIHOMO_API,
	dockerListContainers,
	dockerLogStream,
	dockerRequest,
	dockerRestart,
	dockerStart,
	mihomo,
	sysInfo,
} from "./lib/core.js";
import { refreshNodes } from "./lib/refresh.js";
import * as scheduler from "./lib/scheduler.js";
import * as stats from "./lib/stats.js";
import * as alerts from "./lib/alerts.js";
import {
	clearCookie,
	checkPassword,
	getPassword,
	initAuth,
	isAuthed,
	issueToken,
	sessionCookie,
} from "./lib/auth.js";

// ---------------- 配置 ----------------
const LISTEN = process.env.PANEL_LISTEN || "0.0.0.0";
const PORT = Number(process.env.PANEL_PORT || 9091);
const REPO_DIR = process.env.REPO_DIR || "/repo";
// 面板运行数据目录（密码文件、流量统计、告警配置都落在这里；compose 里由 PANEL_DATA 指定）
const DATA_DIR = process.env.PANEL_DATA || "/data";
const SOURCES_FILE = process.env.SOURCES_FILE || path.join(REPO_DIR, "config", "sources.txt");
const DEVICES_FILE = process.env.DEVICES_FILE || path.join(REPO_DIR, "config", "devices.json");
const MIHOMO_CONTAINER = process.env.MIHOMO_CONTAINER || "mihomo";
const BOOTSTRAP_CONTAINER = process.env.BOOTSTRAP_CONTAINER || "mihomo-bootstrap";
const MAX_BODY = 512 * 1024;

const WEB_DIR = fileURLToPath(new URL("./web/", import.meta.url));

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
};

// ---------------- 小工具 ----------------
function sendJson(res, code, data) {
	const body = JSON.stringify(data);
	res.writeHead(code, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(body);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_BODY) {
				reject(new Error("请求体过大"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (!raw) return resolve({});
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new Error("请求体不是合法 JSON"));
			}
		});
		req.on("error", reject);
	});
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

function loadDeviceNames() {
	try {
		const raw = JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8"));
		return raw && typeof raw === "object" ? raw : {};
	} catch {
		return {};
	}
}

// 可选：指定「VPN 客户端」/「ZeroTier」的网段前缀，逗号分隔。
// 留空则只按 RFC1918 粗分 —— 开源仓库里不写死任何人的私有网段，
// 想给设备起具体名字请用 config/devices.json。
const VPN_NETS = (process.env.VPN_NETS || "").split(",").map((s) => s.trim()).filter(Boolean);
const ZT_NETS = (process.env.ZT_NETS || "").split(",").map((s) => s.trim()).filter(Boolean);

function deviceLabel(ip, names) {
	if (names[ip]) return names[ip];
	if (ip === "127.0.0.1" || ip === "::1") return "本机";
	// 没有 sourceIP = 内核自己发起的连接（DNS fallback 等），不是任何设备
	if (!ip || ip === "unknown") return "本机（mihomo 自身）";
	for (const p of VPN_NETS) if (ip.startsWith(p)) return `VPN 客户端 ${ip}`;
	for (const p of ZT_NETS) if (ip.startsWith(p)) return `ZeroTier 设备 ${ip}`;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return `内网 ${ip}`;
	if (ip.startsWith("192.168.")) return `局域网 ${ip}`;
	if (ip.startsWith("10.")) return `内网 ${ip}`;
	return ip;
}

/** 把连接按来源 IP 聚合成"设备" */
function aggregateDevices(connections, names) {
	const map = new Map();
	for (const c of connections) {
		const ip = c.metadata?.sourceIP || "unknown";
		const host = c.metadata?.host || c.metadata?.destinationIP || "";
		const entry = map.get(ip) || {
			ip,
			label: deviceLabel(ip, names),
			connections: 0,
			upload: 0,
			download: 0,
			hosts: new Set(),
			chains: new Set(),
		};
		entry.connections += 1;
		entry.upload += Number(c.upload) || 0;
		entry.download += Number(c.download) || 0;
		if (host) entry.hosts.add(host);
		(Array.isArray(c.chains) ? c.chains : []).forEach((x) => entry.chains.add(x));
		map.set(ip, entry);
	}
	return [...map.values()]
		.map((d) => ({
			...d,
			hosts: [...d.hosts].slice(0, 40),
			chains: [...d.chains],
		}))
		.sort((a, b) => b.upload + b.download - (a.upload + a.download));
}

// ---------------- SSE 辅助 ----------------
function sseOpen(res) {
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
		"X-Content-Type-Options": "nosniff",
	});
	res.write(": connected\n\n");
}
function sseSend(res, data, event) {
	if (res.writableEnded) return;
	if (event) res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ---------------- 业务动作 ----------------
async function findContainerExact(name) {
	const list = await dockerListContainers();
	return list.find((c) => c.name === name) || null;
}

async function restartContainer(name) {
	const c = await findContainerExact(name);
	if (!c) {
		const all = await dockerListContainers();
		const names = all.map((x) => x.name).join(", ") || "(空)";
		throw new Error(`找不到容器「${name}」。当前可见容器: ${names}`);
	}
	if (c.state === "running") {
		await dockerRestart(name);
		return `已重启 ${name}`;
	}
	await dockerStart(name);
	return `已启动 ${name}`;
}

// ---------------- 路由 ----------------
const routes = [];
const route = (method, pattern, handler, opts = {}) =>
	routes.push({ method, pattern, handler, auth: opts.auth !== false, write: Boolean(opts.write) });

// —— 无需登录 ——
route("GET", /^\/api\/health$/, async (_req, res) => sendJson(res, 200, { ok: true }), { auth: false });
route("GET", /^\/api\/session$/, async (req, res) => {
	sendJson(res, 200, { authed: isAuthed(req) });
}, { auth: false });
route("POST", /^\/api\/login$/, async (req, res) => {
	const body = await readBody(req);
	if (!checkPassword(body.password)) {
		await sleep(600); // 轻微延迟，抬高暴力破解成本
		return sendJson(res, 401, { error: "密码错误" });
	}
	res.writeHead(200, {
		"Content-Type": "application/json; charset=utf-8",
		"Set-Cookie": sessionCookie(issueToken()),
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify({ ok: true }));
}, { auth: false });
route("POST", /^\/api\/logout$/, async (_req, res) => {
	res.writeHead(200, {
		"Content-Type": "application/json; charset=utf-8",
		"Set-Cookie": clearCookie(),
	});
	res.end(JSON.stringify({ ok: true }));
}, { auth: false });

// —— 概览 ——
// 容器列表短暂缓存：概览/运维都在轮询，没必要每次都打一次 Docker
const CTN_TTL = 3000;
let ctnCache = { at: 0, list: null, error: null };
async function getContainers() {
	if (ctnCache.list && Date.now() - ctnCache.at < CTN_TTL) return ctnCache;
	try {
		const list = await dockerListContainers();
		ctnCache = { at: Date.now(), list, error: null };
	} catch (e) {
		ctnCache = { at: Date.now(), list: ctnCache.list, error: e.message };
	}
	return ctnCache;
}

// ---------------- 内核内存：改从 Docker 容器统计拿 ----------------
// ⚠ 为什么不用 mihomo 的 `GET /memory`：
//   它是个**流式**接口 —— 会一直往下推样本（每秒一个 {"inuse":…}），连接**永不结束**。
//   实测：curl 抓了 60 秒仍在输出，只能被 max-time 掐断。
//   而面板用的是 fetch + await r.text()，会一直等到流结束 —— 于是**必然等到超时**。
//   这正是概览页那张「mihomo 内核」卡片常年显示下面这句的根因：
//       未连上 / The operation was aborted due to timeout
//   让人误以为内核没起来；其实 /version、/connections、/proxies 全都正常（1~2 ms），
//   所以"设备"页一直有数据。
//
// 现在改从 Docker 的容器统计读（一次性返回），并做 15 秒缓存 —— 不阻塞概览。
const MEM_TTL_MS = 15_000;
let memCache = { at: 0, bytes: null, inflight: false };

function getKernelMemory() {
	if (Date.now() - memCache.at < MEM_TTL_MS) return memCache.bytes;
	if (!memCache.inflight) {
		memCache.inflight = true;
		// stream=false：只要一个采样点就返回（约 1 秒），不会像 /memory 那样吊着
		dockerRequest(
			"GET",
			`/containers/${encodeURIComponent(MIHOMO_CONTAINER)}/stats?stream=false`,
			undefined,
			8000,
		)
			.then((s) => {
				const bytes = Number(s?.memory_stats?.usage);
				memCache = { at: Date.now(), bytes: bytes > 0 ? bytes : null, inflight: false };
			})
			.catch(() => {
				memCache = { at: Date.now(), bytes: null, inflight: false };
			});
	}
	return memCache.bytes;
}

route("GET", /^\/api\/overview$/, async (_req, res) => {
	const out = { ts: Date.now(), system: null, containers: [], mihomo: null, stats: stats.snapshot() };
	out.system = sysInfo();
	// Docker 与 mihomo 并行：串行会让两边延迟叠加
	const [ctn, mh] = await Promise.all([
		getContainers(),
		(async () => {
			try {
				// 只等 /version（1~2ms）。内存走上面的 Docker 统计缓存，绝不阻塞这里。
				const version = await mihomo("GET", "/version", undefined, 4000);
				const bytes = getKernelMemory();
				return { ok: true, data: { version, memory: bytes ? { inuse: bytes } : null } };
			} catch (e) {
				return { ok: false, error: e.message };
			}
		})(),
	]);
	out.containers = ctn.list || [];
	if (ctn.error) out.containersError = ctn.error;
	if (mh.ok) out.mihomo = mh.data;
	else out.mihomoError = mh.error;
	sendJson(res, 200, out);
});

// —— 连接 / 设备 ——
route("GET", /^\/api\/connections$/, async (_req, res) => {
	const data = await mihomo("GET", "/connections");
	const conns = Array.isArray(data?.connections) ? data.connections : [];
	const names = loadDeviceNames();
	sendJson(res, 200, {
		ts: Date.now(),
		uploadTotal: data?.uploadTotal ?? null,
		downloadTotal: data?.downloadTotal ?? null,
		memory: data?.memory ?? null,
		count: conns.length,
		devices: aggregateDevices(conns, names),
		connections: conns.map((c) => ({
			id: c.id,
			sourceIP: c.metadata?.sourceIP,
			sourceLabel: deviceLabel(c.metadata?.sourceIP, names),
			sourcePort: c.metadata?.sourcePort,
			host: c.metadata?.host || "",
			destinationIP: c.metadata?.destinationIP || "",
			destinationPort: c.metadata?.destinationPort || "",
			network: c.metadata?.network || "",
			rule: c.rule || "",
			rulePayload: c.rulePayload || "",
			chains: c.chains || [],
			upload: c.upload || 0,
			download: c.download || 0,
			start: c.start || "",
		})),
	});
});

// —— 节点 ——
route("GET", /^\/api\/proxies$/, async (_req, res) => {
	const data = await mihomo("GET", "/proxies");
	sendJson(res, 200, data);
});

route("GET", /^\/api\/proxies\/delay$/, async (req, res) => {
	const u = new URL(req.url, "http://x");
	const name = u.searchParams.get("name");
	if (!name) return sendJson(res, 400, { error: "缺少 name" });
	// 夹到 1s~60s：防止 timeout=abc 得到 NaN，把 AbortSignal.timeout(NaN) 传下去
	const timeout = Math.min(60000, Math.max(1000, Number(u.searchParams.get("timeout")) || 5000));
	const url = u.searchParams.get("url") || "https://www.gstatic.com/generate_204";
	try {
		const data = await mihomo(
			"GET",
			`/proxies/${encodeURIComponent(name)}/delay?timeout=${encodeURIComponent(String(timeout))}&url=${encodeURIComponent(url)}`,
			undefined,
			timeout + 4000,
		);
		sendJson(res, 200, { ok: true, ...data });
	} catch (e) {
		sendJson(res, 200, { ok: false, error: e.body?.message || e.message });
	}
});

route(
	"POST",
	/^\/api\/proxies\/select$/,
	async (req, res) => {
		const { group, name } = await readBody(req);
		if (!group || !name) return sendJson(res, 400, { error: "缺少 group / name" });
		await mihomo("PUT", `/proxies/${encodeURIComponent(group)}`, { name });
		sendJson(res, 200, { ok: true });
	},
	{ write: true },
);

// —— 日志（SSE，来源：mihomo 容器 stdout） ——
route("GET", /^\/api\/logs\/stream$/, async (req, res) => {
	const u = new URL(req.url, "http://x");
	const tail = Math.min(2000, Math.max(10, Number(u.searchParams.get("tail") || 200)));
	sseOpen(res);
	sseSend(res, { type: "status", message: `连接 ${MIHOMO_CONTAINER} 日志流...` });

	let pending = "";
	const flush = () => {
		if (!pending) return;
		sseSend(res, { type: "log", text: pending });
		pending = "";
	};

	const stream = dockerLogStream(
		MIHOMO_CONTAINER,
		{ tail },
		(text) => {
			pending += text;
			// 控制单次推送大小，避免卡顿
			if (pending.length > 8000) flush();
		},
		(err) => sseSend(res, { type: "error", message: err.message }),
	);

	const tick = setInterval(flush, 400);
	const hb = setInterval(() => {
		if (!res.writableEnded) res.write(": ping\n\n");
		if (stream.done) cleanup();
	}, 15000);

	function cleanup() {
		clearInterval(tick);
		clearInterval(hb);
		stream.abort();
		flush();
		try {
			res.end();
		} catch {}
	}
	req.on("close", cleanup);
});

// —— 实时流量（SSE，10s 快照一次累计值；速率由 stats 采样得出） ——
route("GET", /^\/api\/traffic\/stream$/, async (req, res) => {
	sseOpen(res);
	const push = () => {
		const s = stats.snapshot();
		sseSend(res, {
			type: "traffic",
			rate: s.rate,
			total: s.total,
			day: s.day,
			month: s.month,
			samples: s.samples,
			error: s.error,
		});
	};
	push();
	const t = setInterval(push, 1500);
	req.on("close", () => clearInterval(t));
});

route("GET", /^\/api\/stats$/, async (_req, res) => sendJson(res, 200, stats.snapshot()));
route("POST", /^\/api\/stats\/reset$/, async (_req, res) => {
	stats.reset();
	sendJson(res, 200, { ok: true });
}, { write: true });

// —— 节点源 ——
route("GET", /^\/api\/sources$/, async (_req, res) => {
	let content = "";
	let error = null;
	try {
		content = fs.readFileSync(SOURCES_FILE, "utf8");
	} catch (e) {
		error = `读取失败: ${e.message}`;
	}
	sendJson(res, 200, { path: SOURCES_FILE, content, error });
});

route(
	"POST",
	/^\/api\/sources$/,
	async (req, res) => {
		const { content } = await readBody(req);
		if (typeof content !== "string") return sendJson(res, 400, { error: "缺少 content" });
		if (content.length > MAX_BODY) return sendJson(res, 400, { error: "内容过长" });
		// 备份一份再写，便于手滑回退
		try {
			if (fs.existsSync(SOURCES_FILE)) {
				const bak = `${SOURCES_FILE}.bak`;
				fs.copyFileSync(SOURCES_FILE, bak);
			}
		} catch {}
		fs.writeFileSync(SOURCES_FILE, content, "utf8");
		sendJson(res, 200, { ok: true, path: SOURCES_FILE });
	},
	{ write: true },
);

// —— 运维动作（SSE 带进度） ——
route("GET", /^\/api\/actions\/restart\/stream$/, async (req, res) => {
	if (!sameOrigin(req)) return sendJson(res, 403, { error: "跨站请求被拒绝" });
	const u = new URL(req.url, "http://x");
	const target = u.searchParams.get("target") || MIHOMO_CONTAINER;
	sseOpen(res);
	try {
		sseSend(res, { type: "step", message: `正在重启容器 ${target} ...` });
		const msg = await restartContainer(target);
		sseSend(res, { type: "done", ok: true, message: msg });
	} catch (e) {
		sseSend(res, { type: "done", ok: false, message: e.message });
	}
	res.end();
});

route("GET", /^\/api\/actions\/refresh\/stream$/, async (req, res) => {
	if (!sameOrigin(req)) return sendJson(res, 403, { error: "跨站请求被拒绝" });
	sseOpen(res);
	try {
		// 「抓源 + 热重载」只在 refresh.js 里实现一次，
		// 和「节点全挂自动救援」「面板定时刷新」共用同一份逻辑（含并发锁）。
		const r = await refreshNodes((m) => sseSend(res, { type: "step", message: m }));
		scheduler.recordManual(r);
		sseSend(res, {
			type: "done",
			ok: r.ok,
			message: r.ok ? `节点池已刷新，mihomo 已${r.how}` : `刷新失败：${r.error}`,
		});
	} catch (e) {
		sseSend(res, { type: "done", ok: false, message: e.message });
	}
	res.end();
});

route(
	"POST",
	/^\/api\/actions\/container$/,
	async (req, res) => {
		const { name, op } = await readBody(req);
		if (!name) return sendJson(res, 400, { error: "缺少 name" });
		if (op === "restart") {
			await dockerRestart(name);
		} else if (op === "start") {
			await dockerStart(name);
		} else if (op === "stop") {
			await dockerRequest("POST", `/containers/${encodeURIComponent(name)}/stop?t=5`);
		} else {
			return sendJson(res, 400, { error: "op 只能是 restart/start/stop" });
		}
		sendJson(res, 200, { ok: true });
	},
	{ write: true },
);

// —— 定时刷新节点池（面板内置，替代宿主机 cron） ——
route("GET", /^\/api\/refresh$/, async (_req, res) => {
	sendJson(res, 200, { config: scheduler.getConfig(), state: scheduler.getState() });
});

route(
	"POST",
	/^\/api\/refresh\/config$/,
	async (req, res) => {
		const patch = await readBody(req);
		sendJson(res, 200, { ok: true, config: scheduler.saveConfig(patch) });
	},
	{ write: true },
);

// —— 邮件告警 ——
// 说明：返回给前端的配置里，SMTP 密码永远是打码的（"__SET__"），
// 前端原样回传该占位符时表示「保持不变」。
route("GET", /^\/api\/alerts$/, async (_req, res) => {
	sendJson(res, 200, { config: alerts.getConfig(), state: alerts.getState() });
});

route(
	"POST",
	/^\/api\/alerts\/config$/,
	async (req, res) => {
		const patch = await readBody(req);
		const config = alerts.saveConfig(patch);
		sendJson(res, 200, { ok: true, config });
	},
	{ write: true },
);

route(
	"POST",
	/^\/api\/alerts\/test$/,
	async (_req, res) => {
		try {
			const r = await alerts.sendTestMail();
			sendJson(res, 200, { ok: true, ...r });
		} catch (e) {
			sendJson(res, 200, { ok: false, error: e.message });
		}
	},
	{ write: true },
);

route(
	"POST",
	/^\/api\/alerts\/check$/,
	async (_req, res) => {
		try {
			const r = await alerts.checkNow();
			sendJson(res, 200, { ok: true, result: r, state: alerts.getState() });
		} catch (e) {
			sendJson(res, 200, { ok: false, error: e.message });
		}
	},
	{ write: true },
);

// ---------------- 静态文件 ----------------
function serveStatic(req, res, urlPath) {
	// decodeURIComponent 对畸形百分号序列（例如 "/%"、"/%C0%"）会抛 URIError。
	// 本函数在 createServer 的 async 回调里被调用，异常会变成**未处理的 Promise
	// rejection** —— Node 默认直接结束进程。也就是说随便一个 URL 就能把面板打挂。
	let rel;
	try {
		rel = decodeURIComponent(urlPath.split("?")[0]);
	} catch {
		res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
		return res.end("bad request");
	}
	if (rel === "/" || rel === "") rel = "/index.html";
	const full = path.join(WEB_DIR, rel);
	// 防目录穿越
	if (!full.startsWith(WEB_DIR)) {
		res.writeHead(403);
		return res.end("forbidden");
	}
	fs.readFile(full, (err, buf) => {
		if (err) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			return res.end("404 not found");
		}
		const ext = path.extname(full).toLowerCase();
		res.writeHead(200, {
			"Content-Type": MIME[ext] || "application/octet-stream",
			"Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300",
			"X-Content-Type-Options": "nosniff",
		});
		res.end(buf);
	});
}

/**
 * 同源校验 —— 给「用 EventSource 的写操作」补上 CSRF 防护。
 *
 * 背景：EventSource 不能自定义请求头，所以后端的 actions stream 这两个会
 * 改状态的接口没法走 X-Panel 头校验，成了唯一绕过统一 CSRF 防护的写路径。
 * SameSite=Strict 的 Cookie 已经挡住浏览器跨站携带，这里再加一道：浏览器发出
 * 的跨站 EventSource 一定带 Origin，对不上就拒绝。
 * （非浏览器客户端一般不带 Origin，保持放行，不影响脚本调用。）
 */
function sameOrigin(req) {
	const origin = req.headers.origin;
	if (!origin) return true;
	try {
		return new URL(origin).host === req.headers.host;
	} catch {
		return false;
	}
}

// ---------------- 主分发 ----------------
const server = http.createServer(async (req, res) => {
	const urlPath = (req.url || "/").split("?")[0];

	if (!urlPath.startsWith("/api/")) {
		// 静态分支里任何同步异常都不该让进程退出（见 serveStatic 的说明）
		try {
			return serveStatic(req, res, req.url || "/");
		} catch (e) {
			console.error(`[static] ${req.url} -> ${e.message}`);
			try {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("internal error");
			} catch {}
			return;
		}
	}

	for (const r of routes) {
		if (r.method !== req.method) continue;
		const m = urlPath.match(r.pattern);
		if (!m) continue;

		if (r.auth && !isAuthed(req)) {
			return sendJson(res, 401, { error: "未登录", needLogin: true });
		}
		// 轻量 CSRF 防护：写操作必须带自定义头
		if (r.write && req.headers["x-panel"] !== "1") {
			return sendJson(res, 403, { error: "缺少 X-Panel 请求头" });
		}

		try {
			await r.handler(req, res, m);
		} catch (e) {
			if (!res.headersSent) {
				sendJson(res, 500, { error: e.message || String(e), body: e.body ?? null });
			} else {
				try {
					sseSend(res, { type: "error", message: e.message });
					res.end();
				} catch {}
			}
		}
		return;
	}

	sendJson(res, 404, { error: "接口不存在" });
});

// ---------------- 启动 ----------------
const authInfo = initAuth();
stats.start();
alerts.start();
scheduler.start();

server.listen(PORT, LISTEN, () => {
	const line = "=".repeat(58);
	console.log(line);
	console.log(" mihomo-linux-gateway 管理面板已启动");
	console.log(line);
	console.log(` 监听        : http://${LISTEN}:${PORT}`);
	console.log(` mihomo API  : ${MIHOMO_API}${process.env.MIHOMO_SECRET ? " (含 secret)" : ""}`);
	console.log(` 节点源文件  : ${SOURCES_FILE}`);
	console.log(` mihomo 容器 : ${MIHOMO_CONTAINER}   生成容器: ${BOOTSTRAP_CONTAINER}`);
	if (authInfo.fromEnv) {
		console.log(" 登录密码    : 来自环境变量 PANEL_PASSWORD（见项目根目录 .env）");
	} else if (authInfo.generated) {
		console.log(` 登录密码    : (本次自动生成) ${getPassword()}`);
		console.log(`               ^ 已写入 ${DATA_DIR}/panel-password.txt，建议设 .env 固定下来`);
	} else {
		console.log(` 登录密码    : 沿用 ${DATA_DIR}/panel-password.txt 中保存的密码`);
	}
	console.log(line);
	console.log(" ⚠ 面板能控制整个代理与容器，请勿暴露到公网，仅在内网/ZeroTier 使用。");
	console.log(line);
});

// 兜底：任何漏网的 Promise rejection 都只记日志，不结束进程。
// 面板是常驻服务，不该因为一个畸形请求就整个挂掉。
process.on("unhandledRejection", (e) => {
	console.error(`[panel] 未处理的 Promise rejection: ${e?.message || e}`);
});

process.on("SIGTERM", () => {
	stats.stop();
	alerts.stop();
	scheduler.stop();
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 3000).unref();
});
process.on("SIGINT", () => {
	stats.stop();
	alerts.stop();
	scheduler.stop();
	process.exit(0);
});
