// ============================================================
// stats.js —— 累计流量统计
//
// 为什么需要它：mihomo 的 /connections 只给「每条活动连接当前的累计字节数」，
// 连接一关闭数据就消失；/traffic 只给瞬时速率。所以想要「今天用了多少 G」
// 必须自己持续采样并累加。
//
// 做法：每 2 秒拉一次 /connections，对每条连接取「本次 - 上次」的增量累加。
// 这样连接关闭也不会丢量。结果定期落盘，重启不丢。
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { mihomo } from "./core.js";

const DATA_DIR = process.env.PANEL_DATA || "/data";
const FILE = path.join(DATA_DIR, "traffic.json");
const INTERVAL_MS = Number(process.env.STATS_INTERVAL_MS || 2000);
const HISTORY_MAX = 120; // 速率曲线保留的采样点数(120 * 2s = 4 分钟)
const FLUSH_MS = 30000;

let state = {
	total: { up: 0, down: 0 },
	day: { date: "", up: 0, down: 0 },
	month: { key: "", up: 0, down: 0 },
};

let samples = [];
let lastConns = new Map();
let lastTick = 0;
let lastFlush = 0;
let lastError = null;
let running = false;
let timer = null;

function dayKey(d = new Date()) {
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const monthKey = (d = new Date()) => dayKey(d).slice(0, 7);

function load() {
	try {
		const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
		if (raw && raw.total) {
			state = {
				total: { up: raw.total.up || 0, down: raw.total.down || 0 },
				day: raw.day || { date: "", up: 0, down: 0 },
				month: raw.month || { key: "", up: 0, down: 0 },
			};
		}
	} catch {
		// 首次运行没有文件，正常
	}
}

function save() {
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		const tmp = `${FILE}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ ...state, savedAt: Date.now() }, null, 1));
		fs.renameSync(tmp, FILE);
	} catch (e) {
		lastError = `统计落盘失败: ${e.message}`;
	}
}

async function tick() {
	if (running) return;
	running = true;
	try {
		const data = await mihomo("GET", "/connections");
		const conns = Array.isArray(data?.connections) ? data.connections : [];
		const now = Date.now();
		const dt = lastTick ? Math.max(0.001, (now - lastTick) / 1000) : 0;

		let dUp = 0;
		let dDown = 0;
		const seen = new Set();
		for (const c of conns) {
			const id = c.id || `${c.metadata?.sourceIP}:${c.metadata?.sourcePort}`;
			seen.add(id);
			const up = Number(c.upload) || 0;
			const down = Number(c.download) || 0;
			const prev = lastConns.get(id);
			if (prev) {
				dUp += Math.max(0, up - prev.up);
				dDown += Math.max(0, down - prev.down);
			} else {
				dUp += up;
				dDown += down;
			}
			lastConns.set(id, { up, down });
		}
		for (const id of [...lastConns.keys()]) if (!seen.has(id)) lastConns.delete(id);

		// 跨天/跨月自动切桶
		const dk = dayKey();
		if (state.day.date !== dk) state.day = { date: dk, up: 0, down: 0 };
		const mk = monthKey();
		if (state.month.key !== mk) state.month = { key: mk, up: 0, down: 0 };

		state.total.up += dUp;
		state.total.down += dDown;
		state.day.up += dUp;
		state.day.down += dDown;
		state.month.up += dUp;
		state.month.down += dDown;

		const rateUp = dt ? dUp / dt : 0;
		const rateDown = dt ? dDown / dt : 0;
		samples.push({ t: now, up: rateUp, down: rateDown });
		if (samples.length > HISTORY_MAX) samples.shift();

		lastTick = now;
		lastError = null;
		if (now - lastFlush > FLUSH_MS) {
			save();
			lastFlush = now;
		}
	} catch (e) {
		lastError = e.message || String(e);
	} finally {
		running = false;
	}
}

export function snapshot() {
	const last = samples[samples.length - 1] || { up: 0, down: 0 };
	return {
		total: state.total,
		day: state.day,
		month: state.month,
		rate: { up: last.up, down: last.down },
		samples: samples.map((s) => ({ t: s.t, up: s.up, down: s.down })),
		intervalMs: INTERVAL_MS,
		updatedAt: lastTick,
		error: lastError,
	};
}

export function reset() {
	state.total = { up: 0, down: 0 };
	state.day = { date: dayKey(), up: 0, down: 0 };
	state.month = { key: monthKey(), up: 0, down: 0 };
	samples = [];
	lastConns.clear();
	save();
}

export function start() {
	load();
	if (!state.day.date) state.day = { date: dayKey(), up: 0, down: 0 };
	if (!state.month.key) state.month = { key: monthKey(), up: 0, down: 0 };
	tick();
	timer = setInterval(tick, INTERVAL_MS);
	timer.unref?.();
}

export function stop() {
	if (timer) clearInterval(timer);
	timer = null;
	save();
}
