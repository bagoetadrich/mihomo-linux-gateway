// ============================================================
// core.js —— 底层能力：Docker socket / mihomo API / 系统信息
// 零依赖，只用 Node 内置模块
// ============================================================
import http from "node:http";
import fs from "node:fs";
import os from "node:os";

export const DOCKER_SOCK = process.env.DOCKER_SOCK || "/var/run/docker.sock";
export const MIHOMO_API = process.env.MIHOMO_API || "http://127.0.0.1:9090";
export const MIHOMO_SECRET = process.env.MIHOMO_SECRET || "";

// ---------------- Docker Engine API（走 unix socket） ----------------
export function dockerRequest(method, apiPath, body, timeoutMs = 6000) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined || body === null ? null : JSON.stringify(body);
		const headers = {};
		if (payload) {
			headers["Content-Type"] = "application/json";
			headers["Content-Length"] = Buffer.byteLength(payload);
		} else if (method !== "GET" && method !== "HEAD") {
			// Docker 对部分 POST 端点要求显式 Content-Length
			headers["Content-Length"] = 0;
		}
		const req = http.request({ socketPath: DOCKER_SOCK, path: apiPath, method, headers }, (res) => {
			let buf = "";
			res.setEncoding("utf8");
			res.on("data", (d) => (buf += d));
			res.on("end", () => {
				if (res.statusCode >= 400) {
					const err = new Error(`docker ${method} ${apiPath} -> ${res.statusCode}`);
					err.status = res.statusCode;
					err.body = buf.slice(0, 500);
					return reject(err);
				}
				if (!buf) return resolve(null);
				try {
					resolve(JSON.parse(buf));
				} catch {
					resolve(buf);
				}
			});
		});
		req.on("error", reject);
		req.setTimeout(timeoutMs, () => req.destroy(new Error("docker socket 超时")));
		if (payload) req.write(payload);
		req.end();
	});
}

export async function dockerListContainers() {
	const list = await dockerRequest("GET", "/containers/json?all=1");
	return (list || []).map((c) => ({
		id: c.Id,
		name: (c.Names?.[0] || "").replace(/^\//, ""),
		image: c.Image,
		state: c.State,
		status: c.Status,
		created: c.Created,
	}));
}

export async function dockerRestart(name, timeoutSec = 10) {
	return dockerRequest("POST", `/containers/${encodeURIComponent(name)}/restart?t=${timeoutSec}`);
}

export async function dockerStart(name) {
	return dockerRequest("POST", `/containers/${encodeURIComponent(name)}/start`);
}

export async function dockerInspect(name) {
	return dockerRequest("GET", `/containers/${encodeURIComponent(name)}/json`);
}

/**
 * 跟随容器日志（HTTP 流，纯文本，不必用 WebSocket）。
 * Docker 对「非 TTY 容器」会做多路复用：每帧 = 8 字节头(type,0,0,0,size BE) + payload。
 * 这里自动识别并拆帧；若首帧不像标准头，则退化为原始文本。
 *
 * @returns {{ abort: () => void }} 调用 abort() 停止跟随
 */
export function dockerLogStream(name, { tail = 200, since = 0 } = {}, onText, onError) {
	const q = new URLSearchParams({
		follow: "1",
		stdout: "1",
		stderr: "1",
		timestamps: "1",
		tail: String(tail),
	});
	if (since) q.set("since", String(since));

	let demux = null; // null=未判定, true=多路复用, false=原始
	let buf = Buffer.alloc(0);
	const state = { done: false };

	const req = http.request(
		{ socketPath: DOCKER_SOCK, path: `/containers/${encodeURIComponent(name)}/logs?${q}`, method: "GET" },
		(res) => {
			if (res.statusCode >= 400) {
				let e = "";
				res.setEncoding("utf8");
				res.on("data", (d) => (e += d));
				res.on("end", () => {
					state.done = true;
					onError?.(new Error(`读取日志失败 HTTP ${res.statusCode}: ${e.slice(0, 200)}`));
				});
				return;
			}
			res.on("data", (chunk) => {
				if (demux === false) {
					onText(chunk.toString("utf8"));
					return;
				}
				buf = Buffer.concat([buf, chunk]);
				if (demux === null) {
					if (buf.length < 8) return;
					const type = buf[0];
					const size = buf.readUInt32BE(4);
					// 标准多路复用帧：type ∈ {0,1,2} 且 size 合理
					demux = type <= 2 && size < 1 << 24 && buf.length >= 8 + Math.min(size, 1);
					if (!demux) {
						onText(buf.toString("utf8"));
						buf = Buffer.alloc(0);
						return;
					}
				}
				while (buf.length >= 8) {
					const size = buf.readUInt32BE(4);
					if (buf.length < 8 + size) break;
					onText(buf.subarray(8, 8 + size).toString("utf8"));
					buf = buf.subarray(8 + size);
				}
			});
			res.on("end", () => {
				state.done = true;
			});
		},
	);
	req.on("error", (e) => {
		state.done = true;
		onError?.(e);
	});
	req.end();

	return {
		abort: () => {
			try {
				req.destroy();
			} catch {}
		},
		get done() {
			return state.done;
		},
	};
}

// ---------------- mihomo external-controller API ----------------
// 默认超时压到 4 秒：面板是轮询式的，慢一次就会拖垮整页。
// 确实需要长耗时的（比如整组测速）由调用方显式传更大的值。
export async function mihomo(method, apiPath, body, timeoutMs = 4000) {
	const headers = {};
	if (MIHOMO_SECRET) headers.Authorization = `Bearer ${MIHOMO_SECRET}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const r = await fetch(MIHOMO_API + apiPath, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await r.text();
	let data = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = text;
	}
	if (!r.ok) {
		const err = new Error(`${method} ${apiPath} -> HTTP ${r.status}`);
		err.status = r.status;
		err.body = data;
		throw err;
	}
	return data;
}

// ---------------- 系统信息（Linux） ----------------
let lastCpu = null;

/** CPU 使用率(%)：/proc/stat 两次采样差值。首次调用返回 null。 */
export function cpuPercent() {
	try {
		const first = fs.readFileSync("/proc/stat", "utf8").split("\n")[0];
		const parts = first.trim().split(/\s+/).slice(1).map(Number);
		if (parts.length < 4 || parts.some(Number.isNaN)) return null;
		const idle = parts[3] + (parts[4] || 0);
		const total = parts.reduce((a, b) => a + b, 0);
		if (!lastCpu) {
			lastCpu = { idle, total };
			return null;
		}
		const dIdle = idle - lastCpu.idle;
		const dTotal = total - lastCpu.total;
		lastCpu = { idle, total };
		if (dTotal <= 0) return null;
		return Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
	} catch {
		return null;
	}
}

export function memInfo() {
	try {
		const t = fs.readFileSync("/proc/meminfo", "utf8");
		const get = (k) => {
			const m = t.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"));
			return m ? Number(m[1]) * 1024 : 0;
		};
		const total = get("MemTotal");
		const avail = get("MemAvailable") || get("MemFree");
		const used = Math.max(0, total - avail);
		return { total, used, percent: total ? (used / total) * 100 : 0 };
	} catch {
		return null;
	}
}

/** 磁盘信息：对宿主挂载点(默认 /repo)取，才能反映宿主磁盘而不是容器 overlay */
export function diskInfo() {
	const p = process.env.HOST_MOUNT || "/repo";
	for (const target of [p, "/"]) {
		try {
			const s = fs.statfsSync(target);
			const total = s.blocks * s.bsize;
			const free = s.bavail * s.bsize;
			return { path: target, total, free, used: total - free, percent: total ? ((total - free) / total) * 100 : 0 };
		} catch {}
	}
	return null;
}

export function sysInfo() {
	return {
		hostname: os.hostname(),
		platform: `${os.platform()} ${os.release()} (${os.arch()})`,
		cpuCount: os.cpus().length,
		cpuModel: os.cpus()[0]?.model || "",
		cpuPercent: cpuPercent(),
		loadavg: os.loadavg(),
		mem: memInfo(),
		disk: diskInfo(),
		uptime: os.uptime(),
		now: Date.now(),
	};
}
