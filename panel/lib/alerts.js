// ============================================================
// alerts.js —— 邮件告警
//
// 检查项：
//   apiDown         mihomo 管理 API 失联
//   nodesAllDown    测速后没有任何一个节点可用（最核心的一项）
//   containerDown   mihomo 容器没在运行
//   diskHigh        磁盘占用超过阈值
//
// 行为：
//   - 只在「状态发生变化」时发信（好→坏 发一封；坏→好 发一封恢复）
//   - 一直没恢复的话，每隔 repeatHours 小时提醒一次
//   - 配置与事件日志都落在 ${PANEL_DATA}，该目录已 gitignore
//
// 隐私：密码只存在于 ${PANEL_DATA}/alerts.json，不写日志、不回传前端。
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { diskInfo, dockerListContainers, mihomo } from "./core.js";
import { sendMail } from "./mailer.js";

const DATA_DIR = process.env.PANEL_DATA || "/data";
const CFG_FILE = path.join(DATA_DIR, "alerts.json");
const LOG_FILE = path.join(DATA_DIR, "alerts-log.jsonl");
const MAX_HISTORY = 60;

const DEFAULTS = {
	enabled: false,
	smtp: { host: "", port: 465, user: "", pass: "", from: "", fromName: "网关告警" },
	to: "",
	rules: {
		apiDown: true,
		nodesAllDown: true,
		containerDown: true,
		diskHigh: true,
		diskPercent: 90,
	},
	intervalMin: 5,
	repeatHours: 6,
	testGroup: "",
};

const RULE_LABEL = {
	apiDown: "mihomo 管理 API 失联",
	nodesAllDown: "所有节点均不可用",
	containerDown: "mihomo 容器未在运行",
	diskHigh: "磁盘占用过高",
};

let cfg = structuredClone(DEFAULTS);
let timer = null;
let running = false;
let lastCheck = 0;
let history = [];
/** ruleKey -> { ok:boolean, since:number, lastAlertAt:number } */
const status = {};

function deepMerge(base, patch) {
	const out = Array.isArray(base) ? [...base] : { ...base };
	for (const [k, v] of Object.entries(patch || {})) {
		if (v && typeof v === "object" && !Array.isArray(v) && base?.[k] && typeof base[k] === "object") {
			out[k] = deepMerge(base[k], v);
		} else if (v !== undefined) {
			out[k] = v;
		}
	}
	return out;
}

/** 环境变量作为初始种子（首次运行 / 文件里没有该字段时生效） */
function envSeed() {
	const s = {};
	if (process.env.SMTP_HOST) s.host = process.env.SMTP_HOST;
	if (process.env.SMTP_PORT) s.port = Number(process.env.SMTP_PORT);
	if (process.env.SMTP_USER) s.user = process.env.SMTP_USER;
	if (process.env.SMTP_PASS) s.pass = process.env.SMTP_PASS;
	if (process.env.SMTP_FROM) s.from = process.env.SMTP_FROM;
	if (process.env.SMTP_FROM_NAME) s.fromName = process.env.SMTP_FROM_NAME;
	const seed = { smtp: s };
	if (process.env.ALERT_TO) seed.to = process.env.ALERT_TO;
	if (process.env.ALERT_ENABLED) seed.enabled = /^(1|true|yes)$/i.test(process.env.ALERT_ENABLED);
	return seed;
}

function load() {
	cfg = structuredClone(DEFAULTS);
	try {
		const raw = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
		cfg = deepMerge(cfg, raw);
	} catch {}
	cfg = deepMerge(cfg, envSeed());
	// 事件历史
	try {
		history = fs
			.readFileSync(LOG_FILE, "utf8")
			.split("\n")
			.filter(Boolean)
			.slice(-MAX_HISTORY)
			.map((l) => JSON.parse(l));
	} catch {
		history = [];
	}
}

function persistConfig() {
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		const tmp = `${CFG_FILE}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(cfg, null, 1), { mode: 0o600 });
		fs.renameSync(tmp, CFG_FILE);
		fs.chmodSync(CFG_FILE, 0o600);
	} catch (e) {
		console.warn(`[alerts] 保存配置失败: ${e.message}`);
	}
}

function pushHistory(entry) {
	history.push(entry);
	if (history.length > MAX_HISTORY) history.shift();
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", { mode: 0o600 });
	} catch {}
}

// ---------------- 对外：读取配置（密码打码） ----------------
export function getConfig() {
	const c = structuredClone(cfg);
	c.smtp.pass = c.smtp.pass ? "__SET__" : "";
	return c;
}

export function saveConfig(patch) {
	const incoming = structuredClone(patch || {});
	// 前端回传 "__SET__" 或空 => 沿用已保存的密码
	const keepPass =
		!incoming.smtp?.pass || incoming.smtp.pass === "__SET__" || /^\*+$/.test(incoming.smtp.pass);
	if (incoming.smtp && keepPass) delete incoming.smtp.pass;
	cfg = deepMerge(cfg, incoming);
	cfg.intervalMin = Math.min(1440, Math.max(1, Number(cfg.intervalMin) || 5));
	cfg.repeatHours = Math.min(168, Math.max(1, Number(cfg.repeatHours) || 6));
	cfg.rules.diskPercent = Math.min(99, Math.max(50, Number(cfg.rules.diskPercent) || 90));
	persistConfig();
	restart();
	return getConfig();
}

export function getState() {
	return {
		enabled: cfg.enabled,
		lastCheck: lastCheck || null,
		intervalMin: cfg.intervalMin,
		checks: Object.fromEntries(
			Object.entries(status).map(([k, v]) => [
				k,
				{ ok: v.ok, since: v.since, lastAlertAt: v.lastAlertAt || null },
			]),
		),
		history: history.slice(-MAX_HISTORY).reverse(),
	};
}

// ---------------- 检查逻辑 ----------------
async function pickTestGroup() {
	if (cfg.testGroup) return cfg.testGroup;
	try {
		const data = await mihomo("GET", "/proxies");
		const all = Object.entries(data?.proxies || {});
		const urlTest = all.find(([, p]) => p.type === "URLTest");
		if (urlTest) return urlTest[0];
		const sel = all.find(([, p]) => p.type === "Selector");
		if (sel) return sel[0];
	} catch {}
	return "";
}

async function checkNodes() {
	const group = await pickTestGroup();
	if (!group) return { ok: false, detail: "找不到可测速的策略组" };
	const url = "https://www.gstatic.com/generate_204";
	const res = await mihomo(
		"GET",
		`/group/${encodeURIComponent(group)}/delay?url=${encodeURIComponent(url)}&timeout=5000`,
		undefined,
		90000,
	);
	const entries = Object.entries(res || {});
	const alive = entries.filter(([, d]) => Number(d) > 0);
	const fastest = alive.length ? Math.min(...alive.map(([, d]) => Number(d))) : 0;
	return {
		ok: alive.length > 0,
		detail:
			alive.length > 0
				? `「${group}」${alive.length}/${entries.length} 个节点可用，最快 ${fastest}ms`
				: `「${group}」${entries.length} 个节点全部不可用`,
		group,
		alive: alive.length,
		total: entries.length,
	};
}

async function runChecks() {
	const results = {};

	// 1) API
	let apiOk = true;
	try {
		await mihomo("GET", "/version", undefined, 8000);
	} catch {
		apiOk = false;
	}
	results.apiDown = { ok: apiOk, detail: apiOk ? "mihomo 管理 API 正常" : "连不上 mihomo 管理 API" };

	// 2) 节点（API 挂了就没法测，直接跟着算坏）
	if (apiOk) {
		try {
			results.nodesAllDown = await checkNodes();
		} catch (e) {
			results.nodesAllDown = { ok: false, detail: `测速失败: ${e.message}` };
		}
	} else {
		results.nodesAllDown = { ok: false, detail: "API 失联，无法测速" };
	}

	// 3) 容器
	try {
		const list = await dockerListContainers();
		const name = process.env.MIHOMO_CONTAINER || "mihomo";
		const c = list.find((x) => x.name === name);
		if (!c) {
			results.containerDown = { ok: false, detail: `找不到容器 ${name}` };
		} else {
			const ok = c.state === "running";
			results.containerDown = { ok, detail: `${name} 状态: ${c.state}（${c.status || ""}）` };
		}
	} catch (e) {
		results.containerDown = { ok: false, detail: `读取容器失败: ${e.message}` };
	}

	// 4) 磁盘
	const disk = diskInfo();
	if (disk) {
		const limit = Number(cfg.rules.diskPercent) || 90;
		results.diskHigh = {
			ok: disk.percent < limit,
			detail: `磁盘已用 ${disk.percent.toFixed(1)}%（阈值 ${limit}%）`,
		};
	} else {
		results.diskHigh = { ok: true, detail: "无法读取磁盘信息" };
	}

	return results;
}

function buildMail(problems, recovered) {
	const lines = [];
	const t = new Date().toLocaleString("zh-CN", { hour12: false });
	if (problems.length) {
		lines.push("检测到以下异常：", "");
		for (const p of problems) {
			lines.push(`  ✗ ${RULE_LABEL[p.key] || p.key}`);
			lines.push(`      ${p.detail}`);
		}
	}
	if (recovered.length) {
		if (lines.length) lines.push("");
		lines.push("已恢复正常：", "");
		for (const r of recovered) {
			lines.push(`  ✓ ${RULE_LABEL[r.key] || r.key}`);
			lines.push(`      ${r.detail}`);
		}
	}
	lines.push(
		"",
		"--------------------------------------------",
		`检查时间: ${t}`,
		`检查间隔: 每 ${cfg.intervalMin} 分钟`,
		"",
		"建议：",
		"  1) 打开管理面板查看「概览」与「节点」页",
		"  2) 节点全挂时，可在「节点源」页换源后点「刷新节点池」",
		"  3) 本邮件由 mihomo-linux-gateway 面板自动发送",
	);
	return lines.join("\n");
}

async function dispatch(problems, recovered) {
	if (!problems.length && !recovered.length) return;
	const subject = problems.length
		? `【网关告警】${problems.map((p) => RULE_LABEL[p.key] || p.key).join("、")}`
		: `【网关恢复】${recovered.map((r) => RULE_LABEL[r.key] || r.key).join("、")}`;
	const text = buildMail(problems, recovered);

	const entry = {
		at: Date.now(),
		kind: problems.length ? "alert" : "recover",
		problems: problems.map((p) => ({ key: p.key, detail: p.detail })),
		recovered: recovered.map((r) => ({ key: r.key, detail: r.detail })),
		subject,
	};

	try {
		await sendMail({
			host: cfg.smtp.host,
			port: cfg.smtp.port,
			user: cfg.smtp.user,
			pass: cfg.smtp.pass,
			from: cfg.smtp.from || cfg.smtp.user,
			fromName: cfg.smtp.fromName,
			to: cfg.to,
			subject,
			text,
		});
		entry.sent = true;
	} catch (e) {
		entry.sent = false;
		entry.error = e.message; // 注意：mailer 不会把密码放进错误信息
	}
	pushHistory(entry);
	return entry;
}

export async function checkNow() {
	if (running) return { skipped: true };
	running = true;
	try {
		const results = await runChecks();
		const now = Date.now();
		const problems = [];
		const recovered = [];

		for (const [key, r] of Object.entries(results)) {
			if (!cfg.rules[key]) {
				status[key] = { ok: true, since: now, lastAlertAt: status[key]?.lastAlertAt || 0 };
				continue;
			}
			const prev = status[key];
			const wasOk = prev ? prev.ok : true;
			if (r.ok && !wasOk) {
				recovered.push({ key, detail: r.detail });
				status[key] = { ok: true, since: now, lastAlertAt: prev?.lastAlertAt || 0 };
			} else if (!r.ok && wasOk) {
				problems.push({ key, detail: r.detail });
				status[key] = { ok: false, since: now, lastAlertAt: 0 };
			} else if (!r.ok) {
				// 持续异常：超过 repeatHours 再提醒一次
				const last = prev?.lastAlertAt || prev?.since || now;
				if (now - last >= cfg.repeatHours * 3600_000) {
					problems.push({ key, detail: r.detail + "（持续未恢复）" });
					status[key] = { ok: false, since: prev?.since || now, lastAlertAt: 0 };
				}
			} else {
				status[key] = { ok: true, since: prev?.since || now, lastAlertAt: prev?.lastAlertAt || 0 };
			}
		}

		lastCheck = now;
		if (problems.length || recovered.length) {
			const sent = await dispatch(problems, recovered);
			if (sent?.sent) {
				for (const p of problems) if (status[p.key]) status[p.key].lastAlertAt = now;
			}
		}
		return { checked: true, results, problems: problems.length, recovered: recovered.length };
	} finally {
		running = false;
	}
}

export async function sendTestMail() {
	const t = new Date().toLocaleString("zh-CN", { hour12: false });
	const text = [
		"这是一封测试邮件。",
		"",
		"如果你收到了它，说明 SMTP 配置正确，网关告警可以正常工作。",
		"",
		"--------------------------------------------",
		`发送时间: ${t}`,
		`SMTP: ${cfg.smtp.host}:${cfg.smtp.port}`,
		"（收件人地址已按你的配置填写）",
	].join("\n");
	const r = await sendMail({
		host: cfg.smtp.host,
		port: cfg.smtp.port,
		user: cfg.smtp.user,
		pass: cfg.smtp.pass,
		from: cfg.smtp.from || cfg.smtp.user,
		fromName: cfg.smtp.fromName,
		to: cfg.to,
		subject: "【网关告警】测试邮件",
		text,
	});
	return r;
}

export function restart() {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
	if (!cfg.enabled) return;
	if (!cfg.smtp.host || !cfg.smtp.user || !cfg.smtp.pass || !cfg.to) {
		console.warn("[alerts] 已启用但配置不完整（需要 smtp.host/user/pass 与收件人），暂不启动");
		return;
	}
	const ms = Math.max(60_000, cfg.intervalMin * 60_000);
	timer = setInterval(() => {
		checkNow().catch((e) => console.warn(`[alerts] 检查出错: ${e.message}`));
	}, ms);
	timer.unref?.();
	console.log(`[alerts] 已启用，每 ${cfg.intervalMin} 分钟检查一次`);
}

export function start() {
	load();
	if (cfg.enabled) {
		// 启动后延迟 20 秒做第一次检查，避免和容器启动抢资源
		const t = setTimeout(() => checkNow().catch(() => {}), 20000);
		t.unref?.();
	}
	restart();
}

export function stop() {
	if (timer) clearInterval(timer);
	timer = null;
}
