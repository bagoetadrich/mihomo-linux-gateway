// ============================================================
// mailer.js —— 极简 SMTP 发信（零依赖）
//
// 支持两种连接方式：
//   - 465 端口：登录前就建立 TLS（implicit TLS）
//   - 587/25 端口：明文连接后 STARTTLS 升级
//
// 只用 Node 内置 net / tls 实现，不引入任何 npm 包。
// 注意：本模块不会把密码写进任何日志。
// ============================================================
import net from "node:net";
import tls from "node:tls";

/** 非 ASCII 文本按 RFC 2047 编码成 =?UTF-8?B?...?= */
function encodeWord(s) {
	const str = String(s ?? "");
	// eslint-disable-next-line no-control-regex
	if (/^[\x20-\x7E]*$/.test(str)) return str;
	return `=?UTF-8?B?${Buffer.from(str, "utf8").toString("base64")}?=`;
}

/** SMTP 会话：按行读响应 */
function attachReader(sock, timeoutMs) {
	let buf = "";
	let pending = null;

	sock.setTimeout?.(timeoutMs, () => {
		const p = pending;
		pending = null;
		p?.reject(new Error("SMTP 读写超时"));
		try {
			sock.destroy();
		} catch {}
	});

	sock.on("data", (chunk) => {
		buf += chunk.toString("utf8");
		const m = buf.match(/^(\d{3}) [^\r\n]*\r\n/m);
		if (m && pending) {
			const end = m.index + m[0].length;
			const resp = buf.slice(0, end);
			buf = buf.slice(end);
			const p = pending;
			pending = null;
			p.resolve(resp.trim());
		}
	});

	sock.on("error", (e) => {
		const p = pending;
		pending = null;
		p?.reject(e);
	});
	sock.on("close", () => {
		const p = pending;
		pending = null;
		p?.reject(new Error("SMTP 连接被关闭"));
	});

	return () => new Promise((resolve, reject) => (pending = { resolve, reject }));
}

function write(sock, line) {
	return new Promise((resolve, reject) => {
		sock.write(line + "\r\n", (err) => (err ? reject(err) : resolve()));
	});
}

function expect(resp, codes, what) {
	const code = Number(String(resp).slice(0, 3));
	if (!codes.includes(code)) {
		throw new Error(`${what} 失败: ${String(resp).split("\r\n")[0]}`);
	}
	return resp;
}

/**
 * 发送一封纯文本邮件
 * @param {object} o
 * @param {string} o.host  SMTP 服务器
 * @param {number} o.port  端口（465=implicit TLS，587/25=STARTTLS）
 * @param {string} o.user  用户名
 * @param {string} o.pass  密码（授权码）
 * @param {string} o.from  发件地址
 * @param {string} [o.fromName] 发件人昵称
 * @param {string|string[]} o.to 收件人
 * @param {string} o.subject 主题
 * @param {string} o.text 正文
 */
export async function sendMail(o) {
	const {
		host,
		port = 465,
		user,
		pass,
		from,
		fromName = "",
		to,
		subject,
		text,
		timeoutMs = 25000,
	} = o;

	if (!host || !user || !pass || !from || !to) {
		throw new Error("SMTP 配置不完整（host/user/pass/from/to 必填）");
	}
	const rcpts = Array.isArray(to) ? to : String(to).split(/[,;\s]+/).filter(Boolean);
	if (!rcpts.length) throw new Error("没有收件人");

	const implicitTls = Number(port) === 465;
	let sock;
	let read;

	// ---- 建连 ----
	if (implicitTls) {
		sock = tls.connect({ host, port: Number(port), servername: host, timeout: timeoutMs });
		read = attachReader(sock, timeoutMs);
		await new Promise((resolve, reject) => {
			sock.once("secureConnect", resolve);
			sock.once("error", reject);
		});
	} else {
		sock = net.connect({ host, port: Number(port) });
		read = attachReader(sock, timeoutMs);
		await new Promise((resolve, reject) => {
			sock.once("connect", resolve);
			sock.once("error", reject);
		});
	}

	try {
		expect(await read(), [220], "连接问候");

		// ---- EHLO（个别服务器对参数挑剔，失败则退化成 HELO） ----
		const domain = from.split("@")[1] || "localhost";
		await write(sock, `EHLO ${domain}`);
		let helloResp = await read();
		if (Number(helloResp.slice(0, 3)) !== 250) {
			await write(sock, "HELO localhost");
			helloResp = await read();
		}
		expect(helloResp, [250], "EHLO");

		// ---- STARTTLS（非 465 端口） ----
		if (!implicitTls) {
			await write(sock, "STARTTLS");
			const r = await read();
			expect(r, [220], "STARTTLS");
			const plain = sock;
			// 升级 TLS 前摘掉明文层的数据监听器：TLS 会复用同一个底层 socket，
			// 旧监听器留着会让原始密文同时喂给已经作废的旧 reader（重复消费）。
			plain.removeAllListeners("data");
			sock = tls.connect({ socket: plain, servername: host, timeout: timeoutMs });
			read = attachReader(sock, timeoutMs);
			await new Promise((resolve, reject) => {
				sock.once("secureConnect", resolve);
				sock.once("error", reject);
			});
			await write(sock, `EHLO ${domain}`);
			expect(await read(), [250], "EHLO(TLS)");
		}

		// ---- 认证 ----
		await write(sock, "AUTH LOGIN");
		expect(await read(), [334], "AUTH LOGIN");
		await write(sock, Buffer.from(user, "utf8").toString("base64"));
		expect(await read(), [334], "AUTH USER");
		await write(sock, Buffer.from(pass, "utf8").toString("base64"));
		expect(await read(), [235], "AUTH PASS（用户名或密码不对）");

		// ---- 信封 ----
		await write(sock, `MAIL FROM:<${from}>`);
		expect(await read(), [250], "MAIL FROM");
		for (const r of rcpts) {
			await write(sock, `RCPT TO:<${r}>`);
			const resp = await read();
			const code = Number(resp.slice(0, 3));
			if (![250, 251].includes(code)) {
				throw new Error(`收件人 ${r} 被拒绝: ${resp.split("\r\n")[0]}`);
			}
		}

		// ---- 正文 ----
		await write(sock, "DATA");
		expect(await read(), [354], "DATA");

		const headers = [
			`From: ${fromName ? `${encodeWord(fromName)} ` : ""}<${from}>`,
			`To: ${rcpts.join(", ")}`,
			`Subject: ${encodeWord(subject)}`,
			`Date: ${new Date().toUTCString()}`,
			"MIME-Version: 1.0",
			"Content-Type: text/plain; charset=UTF-8",
			"Content-Transfer-Encoding: base64",
		].join("\r\n");

		const body = Buffer.from(String(text), "utf8")
			.toString("base64")
			.replace(/(.{76})/g, "$1\r\n");

		await new Promise((resolve, reject) => {
			sock.write(`${headers}\r\n\r\n${body}\r\n.\r\n`, (err) => (err ? reject(err) : resolve()));
		});
		expect(await read(), [250], "发送正文");

		await write(sock, "QUIT").catch(() => {});
		return { ok: true, to: rcpts };
	} finally {
		try {
			sock.end();
			sock.destroy();
		} catch {}
	}
}
