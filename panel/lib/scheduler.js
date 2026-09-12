// ============================================================
// scheduler.js —— 面板内置的「定时刷新节点池」
//
// 为什么不用宿主机 cron / systemd timer:
//   cron 要 SSH 上去改、systemd timer 还得和项目里的 systemd 部署方式区分开，
//   对"只想点几下就能用"的人都是门槛。
//   面板本来就在跑、手里也有 docker.sock，顺手做定时刷新是最省事的位置 ——
//   装完就有，不用在宿主机上配任何东西。
//
// 配置存在 ${PANEL_DATA}/refresh.json（已 gitignore），在面板「运维」页改。
// 可用环境变量 REFRESH_ENABLED / REFRESH_HOURS 预置初值。
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { isRefreshing, refreshNodes } from "./refresh.js";

const DATA_DIR = process.env.PANEL_DATA || "/data";
const CFG_FILE = path.join(DATA_DIR, "refresh.json");

/** 最小间隔 5 分钟，防止手抖填 0 导致疯狂抓源 */
const MIN_INTERVAL_MS = 5 * 60_000;

const DEFAULTS = {
	enabled: true,
	intervalHours: 6,
};

let cfg = { ...DEFAULTS };
let timer = null;
let nextRunAt = 0;
let lastRunAt = 0;
let lastResult = null;

function clampHours(v) {
	const n = Number(v);
	if (!Number.isFinite(n)) return DEFAULTS.intervalHours;
	return Math.min(168, Math.max(1, Math.round(n)));
}

function load() {
	cfg = { ...DEFAULTS };
	let raw = null;
	try {
		raw = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
	} catch {}
	if (raw && typeof raw === "object") {
		if (raw.enabled !== undefined) cfg.enabled = !!raw.enabled;
		cfg.intervalHours = clampHours(raw.intervalHours);
		if (Number.isFinite(raw.lastRunAt)) lastRunAt = raw.lastRunAt;
		if (raw.lastResult && typeof raw.lastResult === "object") lastResult = raw.lastResult;
	}
	// 环境变量只在文件里没有该字段时作为初值
	if (process.env.REFRESH_ENABLED && raw?.enabled === undefined) {
		cfg.enabled = /^(1|true|yes)$/i.test(process.env.REFRESH_ENABLED);
	}
	if (process.env.REFRESH_HOURS && raw?.intervalHours === undefined) {
		cfg.intervalHours = clampHours(process.env.REFRESH_HOURS);
	}
}

function persist() {
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		const tmp = `${CFG_FILE}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ ...cfg, lastRunAt, lastResult }, null, 1), { mode: 0o600 });
		fs.renameSync(tmp, CFG_FILE);
		fs.chmodSync(CFG_FILE, 0o600);
	} catch (e) {
		console.warn(`[refresh] 保存定时刷新配置失败: ${e.message}`);
	}
}

export function getConfig() {
	return { ...cfg };
}

export function getState() {
	return {
		running: isRefreshing(),
		lastRunAt: lastRunAt || null,
		lastResult,
		nextRunAt: nextRunAt || null,
		minIntervalHours: 1,
	};
}

export function saveConfig(patch) {
	const p = patch || {};
	if (p.enabled !== undefined) cfg.enabled = !!p.enabled;
	if (p.intervalHours !== undefined) cfg.intervalHours = clampHours(p.intervalHours);
	persist();
	restart();
	return getConfig();
}

/** 手动跑一次（面板上的「立即刷新」也走这里，便于统一记录 lastResult） */
export async function runOnce(reason = "手动") {
	const steps = [];
	const r = await refreshNodes((m) => steps.push(m));
	lastRunAt = Date.now();
	lastResult = {
		ok: !!r.ok,
		how: r.how || null,
		error: r.error || null,
		reason,
		at: lastRunAt,
		steps,
	};
	persist();
	return lastResult;
}

/** 手动刷新（面板上的「刷新节点池」）完成后记一笔，让面板能显示"上次刷新" */
export function recordManual(result) {
	lastRunAt = Date.now();
	lastResult = {
		ok: !!result?.ok,
		how: result?.how || null,
		error: result?.error || null,
		reason: "手动",
		at: lastRunAt,
		steps: [],
	};
	persist();
}

export function restart() {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
	nextRunAt = 0;
	if (!cfg.enabled) return;

	const ms = Math.max(MIN_INTERVAL_MS, cfg.intervalHours * 3600_000);
	timer = setInterval(() => {
		runOnce("定时").catch((e) => console.warn(`[refresh] 定时刷新出错: ${e.message}`));
	}, ms);
	timer.unref?.();
	nextRunAt = Date.now() + ms;
	console.log(`[refresh] 定时刷新已启用：每 ${cfg.intervalHours} 小时抓一次源（不重启容器）`);
}

export function start() {
	load();
	restart();

	// 启动后不立刻刷（否则每次重启面板容器都要抓一次源）。
	// 但如果距离上次刷新已经超过一个周期，说明期间错过了，补一次。
	if (cfg.enabled && lastRunAt && Date.now() - lastRunAt > cfg.intervalHours * 3600_000) {
		const t = setTimeout(() => {
			runOnce("补刷（距上次已超过一个周期）").catch(() => {});
		}, 60_000);
		t.unref?.();
	}
}

export function stop() {
	if (timer) clearInterval(timer);
	timer = null;
	nextRunAt = 0;
	persist();
}
