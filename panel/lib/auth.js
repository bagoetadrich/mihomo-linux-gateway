// ============================================================
// auth.js —— 单用户口令认证
//
// 设计要点：
//   - 密码优先取环境变量 PANEL_PASSWORD；没设则生成一个随机密码
//     落到 ${PANEL_DATA}/panel-password.txt 并打印到容器日志
//     （保证面板「永远不会处于无密码状态」）
//   - 会话是无状态签名 Cookie（HMAC），重启容器不掉登录
//   - 所有写操作额外要求自定义请求头，作为轻量 CSRF 防护
// ============================================================
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.PANEL_DATA || "/data";
const PASSWORD_FILE = path.join(DATA_DIR, "panel-password.txt");
const SESSION_DAYS = Number(process.env.PANEL_SESSION_DAYS || 30);

export const COOKIE_NAME = "mp_session";

let PASSWORD = "";
let KEY = null;
let generated = false;

function deriveKey(pw) {
	return crypto.createHash("sha256").update(`mihomo-gateway-panel::${pw}::v1`).digest();
}

/** 初始化密码：环境变量优先，其次持久化文件，最后随机生成 */
export function initAuth() {
	const fromEnv = (process.env.PANEL_PASSWORD || "").trim();
	if (fromEnv) {
		PASSWORD = fromEnv;
	} else {
		try {
			const saved = fs.readFileSync(PASSWORD_FILE, "utf8").trim();
			if (saved) PASSWORD = saved;
		} catch {}
		if (!PASSWORD) {
			PASSWORD = crypto.randomBytes(9).toString("base64url");
			generated = true;
			try {
				fs.mkdirSync(DATA_DIR, { recursive: true });
				fs.writeFileSync(PASSWORD_FILE, PASSWORD, { mode: 0o600 });
			} catch (e) {
				console.warn(`[panel] 无法保存自动生成的密码: ${e.message}`);
			}
		}
	}
	KEY = deriveKey(PASSWORD);
	return { generated, fromEnv: Boolean(fromEnv) };
}

export function getPassword() {
	return PASSWORD;
}

export function checkPassword(input) {
	if (!PASSWORD) return false;
	const a = Buffer.from(String(input ?? ""));
	const b = Buffer.from(PASSWORD);
	if (a.length !== b.length) {
		// 长度不同也做一次比较，避免明显的时间侧信道
		crypto.timingSafeEqual(b, b);
		return false;
	}
	return crypto.timingSafeEqual(a, b);
}

export function issueToken() {
	const exp = Date.now() + SESSION_DAYS * 86400_000;
	const payload = String(exp);
	const sig = crypto.createHmac("sha256", KEY).update(payload).digest("base64url");
	return `${payload}.${sig}`;
}

export function verifyToken(token) {
	if (!token) return false;
	const i = token.lastIndexOf(".");
	if (i <= 0) return false;
	const payload = token.slice(0, i);
	const sig = token.slice(i + 1);
	const exp = Number(payload);
	if (!Number.isFinite(exp) || exp < Date.now()) return false;
	const want = crypto.createHmac("sha256", KEY).update(payload).digest("base64url");
	const a = Buffer.from(sig);
	const b = Buffer.from(want);
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

export function parseCookies(req) {
	const out = {};
	const raw = req.headers.cookie;
	if (!raw) return out;
	for (const part of raw.split(";")) {
		const i = part.indexOf("=");
		if (i < 0) continue;
		out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
	}
	return out;
}

export function isAuthed(req) {
	return verifyToken(parseCookies(req)[COOKIE_NAME]);
}

export function sessionCookie(token) {
	const maxAge = SESSION_DAYS * 86400;
	return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

export function clearCookie() {
	return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
