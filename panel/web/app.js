/* ============================================================
   app.js —— 网关管理面板前端（原生 JS，无框架、无构建）
   ============================================================ */
(() => {
	"use strict";

	// ---------------- 小工具 ----------------
	const $ = (s, r = document) => r.querySelector(s);
	const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

	function esc(s) {
		return String(s ?? "").replace(/[&<>"']/g, (c) => ({
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		})[c]);
	}

	function fmtBytes(n) {
		n = Number(n) || 0;
		const u = ["B", "KB", "MB", "GB", "TB", "PB"];
		let i = 0;
		while (n >= 1024 && i < u.length - 1) {
			n /= 1024;
			i++;
		}
		return `${i === 0 ? n : n.toFixed(n < 10 ? 2 : 1)} ${u[i]}`;
	}
	const fmtSpeed = (n) => `${fmtBytes(n)}/s`;

	function fmtDur(sec) {
		sec = Math.max(0, Math.floor(Number(sec) || 0));
		const d = Math.floor(sec / 86400);
		const h = Math.floor((sec % 86400) / 3600);
		const m = Math.floor((sec % 3600) / 60);
		if (d) return `${d} 天 ${h} 小时`;
		if (h) return `${h} 小时 ${m} 分`;
		return `${m} 分`;
	}

	function fmtTime(t) {
		if (!t) return "-";
		const d = new Date(t);
		if (Number.isNaN(d.getTime())) return "-";
		const p = (x) => String(x).padStart(2, "0");
		return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
	}

	// 没有源 IP / 源端口的连接是 mihomo 自身发起的（如 DNS fallback），显示成占位符
	const showIP = (ip) => (!ip || ip === "unknown" ? "—" : ip);
	const showPort = (p) => (p ? `:${p}` : "");

	function toast(msg, kind = "") {
		const el = $("#toast");
		el.className = `toast ${kind}`;
		el.textContent = msg;
		el.classList.remove("hidden");
		clearTimeout(toast._t);
		toast._t = setTimeout(() => el.classList.add("hidden"), 4200);
	}

	async function api(path, { method = "GET", body } = {}) {
		const headers = { "X-Panel": "1" };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		const res = await fetch(path, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (res.status === 401) {
			showLogin();
			throw new Error("未登录或会话已过期");
		}
		let data = {};
		try {
			data = await res.json();
		} catch {}
		if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
		return data;
	}

	function latClass(ms) {
		if (!ms || ms <= 0) return "bad";
		if (ms < 300) return "good";
		if (ms < 800) return "mid";
		return "bad";
	}

	// ---------------- 登录 ----------------
	function showLogin() {
		$("#login").classList.remove("hidden");
		$("#app").classList.add("hidden");
		stopStreams();
	}

	function showApp() {
		$("#login").classList.add("hidden");
		$("#app").classList.remove("hidden");
		startTrafficStream();
		navigate(location.hash || "#overview");
	}

	$("#login .login-card").addEventListener("submit", async (e) => {
		e.preventDefault();
		const btn = $("#loginBtn");
		btn.disabled = true;
		$("#loginErr").classList.add("hidden");
		try {
			await api("/api/login", { method: "POST", body: { password: $("#pw").value } });
			$("#pw").value = "";
			showApp();
		} catch (err) {
			$("#loginErr").textContent = err.message;
			$("#loginErr").classList.remove("hidden");
		} finally {
			btn.disabled = false;
		}
	});

	$("#logoutBtn").addEventListener("click", async () => {
		try {
			await api("/api/logout", { method: "POST", body: {} });
		} catch {}
		showLogin();
	});

	// ---------------- 实时流量流（全局） ----------------
	let trafficES = null;
	let lastTraffic = null;

	function startTrafficStream() {
		if (trafficES) return;
		trafficES = new EventSource("/api/traffic/stream");
		trafficES.onmessage = (ev) => {
			try {
				const d = JSON.parse(ev.data);
				if (d.type !== "traffic") return;
				lastTraffic = d;
				$("#rateMini").textContent = `↑ ${fmtSpeed(d.rate.up)}　↓ ${fmtSpeed(d.rate.down)}`;
				if (currentView === "overview") paintTraffic(d);
			} catch {}
		};
		trafficES.onerror = () => {
			$("#sideStatus").textContent = "流量流已断开，重连中...";
		};
	}
	function stopStreams() {
		if (trafficES) {
			trafficES.close();
			trafficES = null;
		}
		closeLogs();
	}

	// ---------------- 路由 ----------------
	const TITLES = {
		overview: "概览",
		devices: "设备与连接",
		proxies: "节点",
		logs: "日志",
		sources: "节点源",
		ops: "运维",
	};
	let currentView = "";
	let currentCleanup = null;
	let pollTimer = null;
	// 视图代号：每次切页 +1。异步请求回来时如果代号变了，说明页面已经换过，
	// 必须丢弃结果，否则会去操作已经不存在的 DOM（报 classList of null）。
	let viewGen = 0;

	function navigate(hash) {
		const raw = String(hash || "").replace(/^#/, "");
		const view = raw in TITLES ? raw : "overview";
		if (currentCleanup) {
			try {
				currentCleanup();
			} catch {}
			currentCleanup = null;
		}
		closeLogs();
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		viewGen++;
		currentView = view;
		$("#viewTitle").textContent = TITLES[view];
		$$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
		({ overview: viewOverview, devices: viewDevices, proxies: viewProxies, logs: viewLogs, sources: viewSources, ops: viewOps }[view] || viewOverview)();
	}

	window.addEventListener("hashchange", () => navigate(location.hash));
	$("#refreshBtn").addEventListener("click", () => navigate(location.hash));

	// ============================================================
	// 视图：概览
	// ============================================================
	function viewOverview() {
		const v = $("#view");
		v.innerHTML = `
			<div class="grid c4">
				<div class="stat"><div class="label">实时上传</div><div class="value up" id="ovUp">--</div></div>
				<div class="stat"><div class="label">实时下载</div><div class="value down" id="ovDown">--</div></div>
				<div class="stat"><div class="label">今日流量</div><div class="value" id="ovDay">--</div><div class="hint" id="ovDayHint"></div></div>
				<div class="stat"><div class="label">本月流量</div><div class="value" id="ovMonth">--</div><div class="hint" id="ovMonthHint"></div></div>
			</div>

			<div class="card" style="margin-top:16px">
				<h3>速率曲线 <span class="sub">近几分钟采样</span></h3>
				<canvas class="spark" id="spark"></canvas>
				<div class="row small muted" style="margin-top:6px">
					<span style="color:var(--up)">■ 上传</span>
					<span style="color:var(--down)">■ 下载</span>
					<span class="spacer"></span>
					<span id="sparkPeak"></span>
				</div>
			</div>

			<div class="grid c2">
				<div class="card">
					<h3>系统状态</h3>
					<div id="sysBox" class="muted small">读取中...</div>
				</div>
				<div class="card">
					<h3>mihomo 内核</h3>
					<div id="mihomoBox" class="muted small">读取中...</div>
				</div>
			</div>

			<div class="card">
				<h3>容器 <span class="sub" id="ctnHint"></span></h3>
				<div class="table-wrap"><table id="ctnTable">
					<thead><tr><th>名称</th><th>镜像</th><th>状态</th><th class="nowrap">操作</th></tr></thead>
					<tbody><tr><td colspan="4" class="empty">读取中...</td></tr></tbody>
				</table></div>
			</div>
		`;

		if (lastTraffic) paintTraffic(lastTraffic);
		let busy = false;
		const load = async () => {
			if (busy) return; // 上一次还没回来，跳过，避免请求堆积
			busy = true;
			const gen = viewGen;
			try {
				const d = await api("/api/overview");
				if (gen !== viewGen) return; // 已经切到别的页面，丢弃结果
				paintSystem(d.system);
				paintMihomo(d.mihomo, d.mihomoError);
				paintContainers(d.containers, d.containersError);
				const st = $("#sideStatus");
				if (st) st.textContent = `正常 · ${d.system?.hostname || ""}`;
			} catch (e) {
				if (gen !== viewGen) return;
				toast(`读取概览失败: ${e.message}`, "err");
				const st = $("#sideStatus");
				if (st) st.textContent = "读取失败";
			} finally {
				busy = false;
			}
		};
		load();
		pollTimer = setInterval(load, 6000);
	}

	function paintTraffic(d) {
		const up = $("#ovUp");
		if (!up) return; // 当前不在概览页，跳过
		up.textContent = fmtSpeed(d.rate.up);
		$("#ovDown").textContent = fmtSpeed(d.rate.down);
		$("#ovDay").textContent = fmtBytes((d.day?.up || 0) + (d.day?.down || 0));
		$("#ovMonth").textContent = fmtBytes((d.month?.up || 0) + (d.month?.down || 0));
		$("#ovDayHint").textContent = `↑ ${fmtBytes(d.day?.up)}　↓ ${fmtBytes(d.day?.down)}`;
		$("#ovMonthHint").textContent = `↑ ${fmtBytes(d.month?.up)}　↓ ${fmtBytes(d.month?.down)}`;
		drawSpark(d.samples);
	}

	function paintSystem(s) {
		if (!s) return;
		const box = $("#sysBox");
		if (!box) return; // 页面已切换，DOM 不在了
		const mem = s.mem;
		const disk = s.disk;
		const cpu = s.cpuPercent;
		box.classList.remove("muted", "small");
		box.innerHTML = `
			<div class="row"><span>主机</span><span class="spacer"></span><span class="mono">${esc(s.hostname)}</span></div>
			<div class="row"><span>内核</span><span class="spacer"></span><span class="mono small">${esc(s.platform)}</span></div>
			<div class="row"><span>运行时长</span><span class="spacer"></span><span class="mono">${fmtDur(s.uptime)}</span></div>
			<div style="margin-top:12px">
				<div class="row"><span>CPU（${s.cpuCount} 核）</span><span class="spacer"></span><span class="mono">${cpu == null ? "采样中..." : cpu.toFixed(1) + "%"}</span></div>
				<div class="bar ${cpu > 85 ? "bad" : cpu > 60 ? "warn" : ""}"><i style="width:${Math.min(100, cpu || 0)}%"></i></div>
			</div>
			${
				mem
					? `<div style="margin-top:12px">
					<div class="row"><span>内存</span><span class="spacer"></span><span class="mono">${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}（${mem.percent.toFixed(0)}%）</span></div>
					<div class="bar ${mem.percent > 90 ? "bad" : mem.percent > 75 ? "warn" : ""}"><i style="width:${mem.percent}%"></i></div>
				</div>`
					: ""
			}
			${
				disk
					? `<div style="margin-top:12px">
					<div class="row"><span>磁盘 <span class="muted small">${esc(disk.path)}</span></span><span class="spacer"></span><span class="mono">${fmtBytes(disk.free)} 可用 / ${fmtBytes(disk.total)}（${disk.percent.toFixed(0)}% 已用）</span></div>
					<div class="bar ${disk.percent > 90 ? "bad" : disk.percent > 80 ? "warn" : ""}"><i style="width:${disk.percent}%"></i></div>
				</div>`
					: ""
			}
			<div class="row" style="margin-top:12px"><span>负载</span><span class="spacer"></span><span class="mono">${(s.loadavg || []).map((x) => x.toFixed(2)).join(" / ")}</span></div>
		`;
	}

	function paintMihomo(m, err) {
		const box = $("#mihomoBox");
		if (!box) return; // 页面已切换，DOM 不在了
		box.classList.remove("muted", "small");
		if (err) {
			box.innerHTML = `<span class="badge bad">未连上</span><div style="margin-top:8px">${esc(err)}</div>
				<div class="small muted" style="margin-top:8px">检查 mihomo 的 external-controller 是否已开启（见 README）。</div>`;
			return;
		}
		const v = m?.version || {};
		const mem = m?.memory || {};
		const inuse = mem.inuse ? (Number(mem.inuse) / 1024 / 1024).toFixed(1) : "-";
		box.innerHTML = `
			<div class="row"><span>版本</span><span class="spacer"></span><span class="mono">${esc(v.version || "-")}</span></div>
			<div class="row"><span>Meta</span><span class="spacer"></span><span class="mono">${v.meta ? "是" : "否"}</span></div>
			<div class="row"><span>内核内存</span><span class="spacer"></span><span class="mono">${inuse} MB</span></div>
			<div class="row"><span>Go</span><span class="spacer"></span><span class="mono small">${esc(v.go || "-")}</span></div>
		`;
	}

	function paintContainers(list, err) {
		const tb = $("#ctnTable tbody");
		const hint = $("#ctnHint");
		if (!tb || !hint) return; // 页面已切换
		hint.textContent = err ? `（${err}）` : `共 ${list?.length || 0} 个`;
		if (!list || !list.length) {
			tb.innerHTML = `<tr><td colspan="4" class="empty">${esc(err || "没有容器")}</td></tr>`;
			return;
		}
		tb.innerHTML = list
			.map(
				(c) => `<tr>
					<td class="mono">${esc(c.name)}</td>
					<td class="mono small muted">${esc(c.image)}</td>
					<td><span class="badge ${c.state === "running" ? "ok" : c.state === "exited" ? "" : "warn"}">${esc(c.state)}</span>
						<div class="small muted">${esc(c.status || "")}</div></td>
					<td class="nowrap"><button class="ghost small" data-ctn="${esc(c.name)}" data-op="restart">重启</button></td>
				</tr>`,
			)
			.join("");
		tb.onclick = async (e) => {
			const b = e.target.closest("button[data-ctn]");
			if (!b) return;
			b.disabled = true;
			try {
				await api("/api/actions/container", { method: "POST", body: { name: b.dataset.ctn, op: b.dataset.op } });
				toast(`已${b.dataset.op === "restart" ? "重启" : "操作"} ${b.dataset.ctn}`, "ok");
				setTimeout(() => navigate("#overview"), 1500);
			} catch (err2) {
				toast(`操作失败: ${err2.message}`, "err");
				b.disabled = false;
			}
		};
	}

	// 速率曲线
	function drawSpark(samples) {
		const cv = $("#spark");
		if (!cv || !cv.parentElement) return;
		const dpr = window.devicePixelRatio || 1;
		const w = cv.clientWidth || 600;
		const h = 56;
		cv.width = w * dpr;
		cv.height = h * dpr;
		const g = cv.getContext("2d");
		g.scale(dpr, dpr);
		g.clearRect(0, 0, w, h);

		const data = (samples || []).slice(-120);
		if (data.length < 2) {
			$("#sparkPeak").textContent = "";
			return;
		}
		const peak = Math.max(1, ...data.map((s) => Math.max(s.up || 0, s.down || 0)));
		const px = (i) => (i / (data.length - 1)) * (w - 2) + 1;
		const py = (v) => h - 2 - (v / peak) * (h - 6);

		for (const [key, color] of [
			["up", "#f59e0b"],
			["down", "#22c55e"],
		]) {
			g.beginPath();
			g.strokeStyle = color;
			g.lineWidth = 1.5;
			data.forEach((s, i) => {
				const x = px(i);
				const y = py(s[key] || 0);
				i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
			});
			g.stroke();
		}
		$("#sparkPeak").textContent = `峰值 ${fmtSpeed(peak)}`;
	}

	// ============================================================
	// 视图：设备与连接
	// ============================================================
	function viewDevices() {
		const v = $("#view");
		v.innerHTML = `
			<div class="card">
				<h3>设备 <span class="sub">按来源 IP 聚合当前连接</span></h3>
				<div class="table-wrap"><table id="devTable">
					<thead><tr><th>设备</th><th>IP</th><th>连接</th><th>上传</th><th>下载</th><th>访问中</th></tr></thead>
					<tbody><tr><td colspan="6" class="empty">读取中...</td></tr></tbody>
				</table></div>
			</div>
			<div class="card">
				<h3>连接明细 <span class="sub" id="connHint"></span></h3>
				<div class="table-wrap"><table id="connTable">
					<thead><tr><th>来源</th><th>目标</th><th>规则</th><th>链路</th><th>上传</th><th>下载</th><th>时间</th></tr></thead>
					<tbody><tr><td colspan="7" class="empty">读取中...</td></tr></tbody>
				</table></div>
			</div>
		`;
		let busy = false;
		const load = async () => {
			if (busy) return;
			busy = true;
			const gen = viewGen;
			try {
				const d = await api("/api/connections");
				if (gen !== viewGen) return; // 已切页，丢弃
				const hint = $("#connHint");
				const devTb = $("#devTable tbody");
				const connTb = $("#connTable tbody");
				if (!hint || !devTb || !connTb) return;
				hint.textContent = `共 ${d.count} 条`;
				devTb.innerHTML = (d.devices || []).length
					? d.devices
							.map(
								(x) => `<tr>
						<td>${esc(x.label)}</td>
						<td class="mono">${esc(showIP(x.ip))}</td>
						<td class="mono">${x.connections}</td>
						<td class="mono" style="color:var(--up)">${fmtBytes(x.upload)}</td>
						<td class="mono" style="color:var(--down)">${fmtBytes(x.download)}</td>
						<td class="small muted">${esc((x.hosts || []).slice(0, 6).join(", "))}${x.hosts?.length > 6 ? " ..." : ""}</td>
					</tr>`,
							)
							.join("")
					: `<tr><td colspan="6" class="empty">当前没有活动连接</td></tr>`;

				connTb.innerHTML = (d.connections || []).length
					? d.connections
							.slice(0, 300)
							.map(
								(c) => `<tr>
						<td class="mono small">${esc(c.sourceLabel)}<br><span class="muted">${showPort(c.sourcePort)}</span></td>
						<td class="mono small">${esc(c.host || c.destinationIP)}<br><span class="muted">:${esc(c.destinationPort)}</span></td>
						<td class="small">${esc(c.rule)}${c.rulePayload ? `<br><span class="muted mono">${esc(c.rulePayload)}</span>` : ""}</td>
						<td>${(c.chains || []).map((x) => `<span class="badge">${esc(x)}</span>`).join(" ")}</td>
						<td class="mono small" style="color:var(--up)">${fmtBytes(c.upload)}</td>
						<td class="mono small" style="color:var(--down)">${fmtBytes(c.download)}</td>
						<td class="mono small muted">${fmtTime(c.start)}</td>
					</tr>`,
							)
							.join("")
					: `<tr><td colspan="7" class="empty">当前没有活动连接</td></tr>`;
			} catch (e) {
				if (gen !== viewGen) return;
				toast(`读取连接失败: ${e.message}`, "err");
			} finally {
				busy = false;
			}
		};
		load();
		pollTimer = setInterval(load, 4000);
	}

	// ============================================================
	// 视图：节点
	// ============================================================
	const GROUP_TYPES = new Set(["Selector", "URLTest", "Fallback", "LoadBalance", "Relay"]);
	let proxiesCache = null;

	function viewProxies() {
		const v = $("#view");
		v.innerHTML = `
			<div class="card">
				<h3>策略组</h3>
				<div id="groups" class="grid c2"><div class="empty">读取中...</div></div>
			</div>
			<div class="card">
				<div class="row">
					<h3 style="margin:0">节点 <span class="sub" id="nodeHint"></span></h3>
					<span class="spacer"></span>
					<button id="testAll" class="ghost">全部测速</button>
				</div>
				<div class="table-wrap" style="margin-top:12px"><table id="nodeTable">
					<thead><tr><th>节点</th><th>类型</th><th>延迟</th><th class="nowrap">操作</th></tr></thead>
					<tbody><tr><td colspan="4" class="empty">读取中...</td></tr></tbody>
				</table></div>
			</div>
		`;
		let busy = false;
		const load = async () => {
			if (busy) return;
			busy = true;
			const gen = viewGen;
			try {
				const d = await api("/api/proxies");
				if (gen !== viewGen) return; // 已切页，丢弃
				proxiesCache = d.proxies || {};
				paintGroups(proxiesCache);
				paintNodes(proxiesCache);
			} catch (e) {
				if (gen !== viewGen) return;
				toast(`读取节点失败: ${e.message}`, "err");
				const g = $("#groups");
				if (g) g.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
			} finally {
				busy = false;
			}
		};
		load();
		pollTimer = setInterval(load, 10000);

		$("#testAll").onclick = () => testAllNodes();
	}

	function paintGroups(all) {
		const host = $("#groups");
		if (!host) return; // 页面已切换
		const groups = Object.entries(all).filter(([, p]) => GROUP_TYPES.has(p.type));
		if (!groups.length) {
			host.innerHTML = `<div class="empty">没有策略组</div>`;
			return;
		}
		host.innerHTML = groups
			.map(([name, g]) => {
				const canSelect = g.type === "Selector";
				const opts = (g.all || [])
					.map((n) => `<option value="${esc(n)}" ${n === g.now ? "selected" : ""}>${esc(n)}</option>`)
					.join("");
				return `<div>
					<div class="row"><span class="badge accent">${esc(g.type)}</span><b>${esc(name)}</b></div>
					<div style="margin-top:8px">
						${
							canSelect
								? `<select data-group="${esc(name)}" style="width:100%">${opts}</select>`
								: `<div class="mono small">当前：${esc(g.now || "-")}</div>`
						}
					</div>
				</div>`;
			})
			.join("");

		$$("select", host).forEach((sel) => {
			sel.onchange = async () => {
				const group = sel.dataset.group;
				const name = sel.value;
				try {
					await api("/api/proxies/select", { method: "POST", body: { group, name } });
					toast(`${group} → ${name}`, "ok");
				} catch (e) {
					toast(`切换失败: ${e.message}`, "err");
				}
				setTimeout(() => navigate("#proxies"), 600);
			};
		});
	}

	function lastDelay(p) {
		const h = p.history;
		if (Array.isArray(h) && h.length) {
			const last = h[h.length - 1];
			return Number(last.delay) || 0;
		}
		return 0;
	}

	function paintNodes(all) {
		const hint = $("#nodeHint");
		const tb = $("#nodeTable tbody");
		if (!hint || !tb) return; // 页面已切换
		const nodes = Object.entries(all).filter(([, p]) => !GROUP_TYPES.has(p.type));
		hint.textContent = `共 ${nodes.length} 个`;
		if (!nodes.length) {
			tb.innerHTML = `<tr><td colspan="4" class="empty">没有节点</td></tr>`;
			return;
		}
		tb.innerHTML = nodes
			.map(([name, p]) => {
				const d = lastDelay(p);
				return `<tr data-node="${esc(name)}">
					<td>${esc(name)}</td>
					<td><span class="badge">${esc(p.type || "?")}</span></td>
					<td class="lat ${latClass(d)}" data-lat>${d > 0 ? d + " ms" : "未测"}</td>
					<td class="nowrap"><button class="ghost small" data-test="${esc(name)}">测速</button></td>
				</tr>`;
			})
			.join("");
		$("#nodeTable tbody").onclick = async (e) => {
			const b = e.target.closest("button[data-test]");
			if (!b) return;
			await testOne(b.dataset.test, b);
		};
	}

	async function testOne(name, btn) {
		const row = $(`#nodeTable tbody tr[data-node="${CSS.escape(name)}"]`);
		const cell = row?.querySelector("[data-lat]");
		if (cell) {
			cell.textContent = "测试中...";
			cell.className = "lat";
		}
		if (btn) btn.disabled = true;
		try {
			const r = await api(`/api/proxies/delay?name=${encodeURIComponent(name)}&timeout=5000`);
			const d = Number(r.delay) || 0;
			if (cell) {
				cell.textContent = d > 0 ? `${d} ms` : "失败";
				cell.className = `lat ${latClass(d)}`;
			}
			return d;
		} catch {
			if (cell) {
				cell.textContent = "失败";
				cell.className = "lat bad";
			}
			return 0;
		} finally {
			if (btn) btn.disabled = false;
		}
	}

	async function testAllNodes() {
		const rows = $$("#nodeTable tbody tr[data-node]");
		if (!rows.length) return;
		const btn = $("#testAll");
		btn.disabled = true;
		let done = 0;
		let ok = 0;
		btn.textContent = `测速中 0/${rows.length}`;
		const names = rows.map((r) => r.dataset.node);
		const CONC = 6;
		let idx = 0;
		async function worker() {
			while (idx < names.length) {
				const n = names[idx++];
				const d = await testOne(n, null);
				done++;
				if (d > 0) ok++;
				btn.textContent = `测速中 ${done}/${names.length}（可用 ${ok}）`;
			}
		}
		await Promise.all(Array.from({ length: CONC }, worker));
		btn.textContent = `全部测速（可用 ${ok}/${names.length}）`;
		btn.disabled = false;
		toast(`测速完成：${ok}/${names.length} 个可用`, ok ? "ok" : "err");
	}

	// ============================================================
	// 视图：日志
	// ============================================================
	let logES = null;
	let logPaused = false;

	function closeLogs() {
		if (logES) {
			logES.close();
			logES = null;
		}
	}

	function viewLogs() {
		const v = $("#view");
		v.innerHTML = `
			<div class="card">
				<div class="row">
					<h3 style="margin:0">${esc("mihomo 容器日志")}</h3>
					<span class="spacer"></span>
					<button id="logToggle" class="ghost">暂停</button>
					<button id="logClear" class="ghost">清屏</button>
					<button id="logReconnect" class="ghost">重连</button>
				</div>
				<div class="logbox" id="logbox" style="margin-top:12px"></div>
				<div class="small muted" style="margin-top:8px" id="logStatus">连接中...</div>
			</div>
		`;
		logPaused = false;
		$("#logToggle").onclick = () => {
			logPaused = !logPaused;
			$("#logToggle").textContent = logPaused ? "继续" : "暂停";
		};
		$("#logClear").onclick = () => {
			$("#logbox").textContent = "";
		};
		$("#logReconnect").onclick = () => {
			closeLogs();
			connectLogs();
		};
		connectLogs();
		currentCleanup = closeLogs;
	}

	function connectLogs() {
		closeLogs();
		logES = new EventSource("/api/logs/stream?tail=300");
		logES.onmessage = (ev) => {
			let d;
			try {
				d = JSON.parse(ev.data);
			} catch {
				return;
			}
			if (d.type === "status") {
				$("#logStatus").textContent = d.message;
				return;
			}
			if (d.type === "error") {
				$("#logStatus").innerHTML = `<span style="color:var(--danger)">${esc(d.message)}</span>`;
				return;
			}
			if (d.type !== "log" || logPaused) return;
			appendLog(d.text);
		};
		logES.onerror = () => {
			$("#logStatus").textContent = "连接中断，3 秒后自动重连...";
		};
	}

	function appendLog(text) {
		const box = $("#logbox");
		if (!box) return;
		const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
		const lines = String(text).split(/\r?\n/).filter((l) => l.length);
		const frag = document.createDocumentFragment();
		for (const line of lines) {
			const span = document.createElement("div");
			let cls = "l-dim";
			if (/error|fail|refused|panic/i.test(line)) cls = "l-error";
			else if (/warn/i.test(line)) cls = "l-warn";
			else if (/level=info|"info"|\binfo\b/i.test(line)) cls = "l-info";
			span.className = cls;
			span.textContent = line;
			frag.appendChild(span);
		}
		box.appendChild(frag);
		// 限制行数，避免长时间开着吃内存
		while (box.childElementCount > 3000) box.removeChild(box.firstChild);
		if (atBottom) box.scrollTop = box.scrollHeight;
	}

	// ============================================================
	// 视图：节点源
	// ============================================================
	function viewSources() {
		const v = $("#view");
		v.innerHTML = `
			<div class="card">
				<h3>节点源列表 <span class="sub" id="srcPath"></span></h3>
				<p class="small muted" style="margin-top:0">
					每行一个 URL；含 <code class="mono">{i}</code> 的行会展开成 1~6（对应 ChromeGo 的 ip_1~ip_6）。
					<code class="mono">#</code> 开头为注释。改完点「保存」，再点「刷新节点池」才会生效。
				</p>
				<textarea id="srcText" rows="16" spellcheck="false"></textarea>
				<div class="row" style="margin-top:12px">
					<button id="srcSave">保存</button>
					<button id="srcReset" class="ghost">放弃修改</button>
					<span class="spacer"></span>
					<button id="srcRefresh" class="ghost">保存并刷新节点池</button>
				</div>
				<div class="out hidden" id="srcOut"></div>
			</div>
		`;
		const load = async () => {
			try {
				const d = await api("/api/sources");
				$("#srcPath").textContent = d.path;
				$("#srcText").value = d.content || "";
				if (d.error && !d.content) toast(d.error, "err");
			} catch (e) {
				toast(`读取失败: ${e.message}`, "err");
			}
		};
		load();
		$("#srcReset").onclick = load;
		$("#srcSave").onclick = async () => {
			try {
				await api("/api/sources", { method: "POST", body: { content: $("#srcText").value } });
				toast("已保存（旧版本自动备份为 sources.txt.bak）", "ok");
			} catch (e) {
				toast(`保存失败: ${e.message}`, "err");
			}
		};
		$("#srcRefresh").onclick = async () => {
			const btn = $("#srcRefresh");
			btn.disabled = true;
			try {
				await api("/api/sources", { method: "POST", body: { content: $("#srcText").value } });
				toast("源列表已保存，开始刷新节点池", "ok");
			} catch (e) {
				toast(`保存失败: ${e.message}`, "err");
				btn.disabled = false;
				return;
			}
			await runRefresh($("#srcOut"));
			btn.disabled = false;
		};
	}

	// ============================================================
	// 视图：运维
	// ============================================================
	function fmtTime(ts) {
		try {
			return new Date(ts).toLocaleString("zh-CN", { hour12: false });
		} catch {
			return "—";
		}
	}

	async function loadScheduler() {
		try {
			paintScheduler(await api("/api/refresh"));
		} catch (e) {
			const h = $("#srHint");
			if (h) h.textContent = "读取失败";
		}
	}

	function paintScheduler(d) {
		const c = (d && d.config) || {};
		const en = $("#srEnabled");
		if (en && c.enabled !== undefined) {
			en.checked = !!c.enabled;
			$("#srHours").value = c.intervalHours || 6;
		}
		const st = (d && d.state) || {};
		const nx = $("#srNext");
		if (nx) nx.textContent = st.nextRunAt ? fmtTime(st.nextRunAt) : "未启用";
		const h = $("#srHint");
		if (!h) return;
		const lr = st.lastResult;
		h.textContent = lr
			? `上次 ${fmtTime(lr.at)} ${lr.ok ? "成功" : "失败"}${lr.reason ? `（${lr.reason}）` : ""}`
			: "尚未执行过";
	}

	function viewOps() {
		const v = $("#view");
		v.innerHTML = `
			<div class="grid c2">
				<div class="card">
					<h3>一键操作</h3>
					<div class="actions">
						<button id="opRefresh">刷新节点池</button>
						<button id="opRestart" class="ghost">重启 mihomo</button>
						<button id="opStatsReset" class="ghost">流量统计清零</button>
					</div>
					<p class="small muted" style="margin-bottom:0">
						「刷新节点池」= 重新执行 bootstrap（按 config/sources.txt 抓源生成配置）→ 热重载 mihomo（不重启容器、设备不断线）。约 10 秒~1 分钟。
					</p>
				</div>
				<div class="card">
					<h3>安全提示</h3>
					<p class="small muted" style="margin:0">
						本面板可控制容器与整个代理链路，<b>请勿暴露到公网</b>。<br />
						建议只在局域网 / ZeroTier 内访问，并用防火墙限制来源。
					</p>
				</div>
			</div>
			<div class="card">
				<h3>定时刷新节点池 <span class="sub" id="srHint">读取中...</span></h3>
				<div class="row" style="margin-bottom:10px">
					<label class="remember" style="justify-content:flex-start;margin:0">
						<input type="checkbox" id="srEnabled" /> 启用
					</label>
					<span class="small muted" style="margin-left:14px">每</span>
					<input id="srHours" type="number" min="1" max="168" style="width:74px" value="6" />
					<span class="small muted">小时自动抓一次源</span>
					<span class="spacer"></span>
					<button id="srSave" class="small">保存</button>
				</div>
				<p class="small muted" style="margin:0">
					由面板自己定时执行「抓源 → 热重载」，<b>不需要在宿主机配 cron / systemd timer</b>，设备不会断线。<br />
					下次执行：<span id="srNext" class="mono">—</span>
				</p>
			</div>
			<div class="card">
				<h3>邮件告警 <span class="sub" id="alertHint">读取中...</span></h3>
				<div class="row" style="margin-bottom:14px">
					<label class="remember" style="justify-content:flex-start;margin:0">
						<input type="checkbox" id="alEnabled" /> 启用邮件告警
					</label>
					<span class="spacer"></span>
					<button id="alCheck" class="ghost small">立即检查一次</button>
					<button id="alTest" class="ghost small">发送测试邮件</button>
					<button id="alSave" class="small">保存设置</button>
				</div>

				<div class="grid c2">
					<div>
						<div class="row"><span class="small muted" style="width:84px">发送方式</span>
							<select id="alMethod" style="flex:1"><option value="smtp">SMTP</option></select></div>
						<div class="row" style="margin-top:8px"><span class="small muted" style="width:84px">服务器</span>
							<input id="alHost" style="flex:1" placeholder="smtp.exmail.qq.com" autocomplete="off" /></div>
						<div class="row" style="margin-top:8px"><span class="small muted" style="width:84px">端口</span>
							<input id="alPort" type="number" style="width:96px" value="465" />
							<span class="small muted" id="alPortHint"></span></div>
						<div class="row" style="margin-top:8px"><span class="small muted" style="width:84px">用户名</span>
							<input id="alUser" style="flex:1" autocomplete="off" /></div>
						<div class="row" style="margin-top:8px"><span class="small muted" style="width:84px">密码</span>
							<input id="alPass" type="password" style="flex:1" placeholder="留空表示不修改" autocomplete="new-password" /></div>
					</div>
					<div>
						<div class="row"><span class="small muted" style="width:84px">发信人昵称</span>
							<input id="alFromName" style="flex:1" /></div>
						<div class="row" style="margin-top:8px"><span class="small muted" style="width:84px">发信地址</span>
							<input id="alFrom" style="flex:1" placeholder="留空则使用用户名" /></div>
						<div class="row" style="margin-top:8px"><span class="small muted" style="width:84px">收件人</span>
							<input id="alTo" style="flex:1" placeholder="多个用逗号分隔" /></div>
						<div class="row" style="margin-top:8px"><span class="small muted" style="width:84px">检查间隔</span>
							<input id="alInterval" type="number" style="width:80px" value="5" /><span class="small muted">分钟</span></div>
						<div class="row" style="margin-top:8px"><span class="small muted" style="width:84px">重复提醒</span>
							<input id="alRepeat" type="number" style="width:80px" value="6" /><span class="small muted">小时（一直没恢复时再提醒）</span></div>
					</div>
				</div>

				<h3 style="margin-top:18px">告警项</h3>
				<div class="row">
					<label class="remember"><input type="checkbox" id="alR_nodes" /> 所有节点均不可用</label>
					<label class="remember"><input type="checkbox" id="alR_api" /> 管理 API 失联</label>
					<label class="remember"><input type="checkbox" id="alR_ctn" /> 容器未在运行</label>
					<label class="remember"><input type="checkbox" id="alR_disk" /> 磁盘超过
						<input id="alDisk" type="number" style="width:62px;padding:3px 6px" value="90" />%</label>
					<label class="remember"><input type="checkbox" id="alR_heal" /> 节点全挂时自动重抓源（自救）</label>
				</div>
				<p class="small muted" style="margin:10px 0 0">
					「所有节点均不可用」= 对策略组里每个节点做一次真实测速，一个都不通就发信。
					这就是你最初想要的那个「全挂了主动告诉你」。<br />
					勾上「自动重抓源」后，一旦检测到全挂，面板会<b>自动重新抓一次源并热重载</b>（10 分钟冷却），
					救援过程与结果会写进告警邮件。<b>注意：它只能重拉你已配置的那些源，变不出源里本来就没有的节点。</b>
				</p>

				<div class="out hidden" id="alOut" style="margin-top:12px"></div>

				<details style="margin-top:14px">
					<summary>最近事件（<span id="alHistCount">0</span> 条）</summary>
					<div class="table-wrap" style="margin-top:8px">
						<table id="alHist">
							<thead><tr><th>时间</th><th>类型</th><th>内容</th><th>已发出</th></tr></thead>
							<tbody><tr><td colspan="4" class="empty">暂无记录</td></tr></tbody>
						</table>
					</div>
				</details>
			</div>

			<div class="card">
				<h3>容器</h3>
				<div class="table-wrap"><table id="opsCtn">
					<thead><tr><th>名称</th><th>镜像</th><th>状态</th><th class="nowrap">操作</th></tr></thead>
					<tbody><tr><td colspan="4" class="empty">读取中...</td></tr></tbody>
				</table></div>
			</div>
			<div class="card">
				<h3>执行输出</h3>
				<div class="out" id="opsOut"><span class="muted">（等待操作）</span></div>
			</div>
		`;
		const out = $("#opsOut");
		let busy = false;
		const load = async () => {
			if (busy) return;
			busy = true;
			const gen = viewGen;
			try {
				const d = await api("/api/overview");
				if (gen !== viewGen) return; // 已切页，丢弃
				paintOpsContainers(d.containers);
			} catch (e) {
				if (gen !== viewGen) return;
				toast(`读取容器失败: ${e.message}`, "err");
			} finally {
				busy = false;
			}
		};
		load();
		pollTimer = setInterval(load, 8000);
		loadAlerts();

		$("#alSave").onclick = saveAlerts;
		$("#alTest").onclick = testAlerts;
		$("#alCheck").onclick = checkAlerts;
		$("#alPort").oninput = () => {
			const p = Number($("#alPort").value);
			$("#alPortHint").textContent = p === 587 || p === 25 ? "（STARTTLS）" : p === 465 ? "（SSL/TLS）" : "";
		};

		$("#opRefresh").onclick = () => runRefresh(out);
		$("#opRestart").onclick = () => runSSE(`/api/actions/restart/stream?target=${encodeURIComponent("mihomo")}`, out);

		// 定时刷新（面板内置，不需要宿主机 cron）
		$("#srSave").onclick = async () => {
			try {
				await api("/api/refresh/config", {
					method: "POST",
					body: { enabled: $("#srEnabled").checked, intervalHours: Number($("#srHours").value) || 6 },
				});
				toast("定时刷新设置已保存", "ok");
				await loadScheduler();
			} catch (e) {
				toast(`保存失败: ${e.message}`, "err");
			}
		};
		loadScheduler();
		$("#opStatsReset").onclick = async () => {
			if (!confirm("确定把累计流量统计清零？此操作不可撤销。")) return;
			try {
				await api("/api/stats/reset", { method: "POST", body: {} });
				toast("统计已清零", "ok");
			} catch (e) {
				toast(`失败: ${e.message}`, "err");
			}
		};
	}

	function paintOpsContainers(list) {
		const tb = $("#opsCtn tbody");
		if (!tb) return; // 页面已切换
		if (!list || !list.length) {
			tb.innerHTML = `<tr><td colspan="4" class="empty">没有容器</td></tr>`;
			return;
		}
		tb.innerHTML = list
			.map(
				(c) => `<tr>
				<td class="mono">${esc(c.name)}</td>
				<td class="mono small muted">${esc(c.image)}</td>
				<td><span class="badge ${c.state === "running" ? "ok" : ""}">${esc(c.state)}</span></td>
				<td class="nowrap">
					<button class="ghost small" data-op="restart" data-name="${esc(c.name)}">重启</button>
					<button class="ghost small" data-op="stop" data-name="${esc(c.name)}">停止</button>
				</td>
			</tr>`,
			)
			.join("");
		tb.onclick = async (e) => {
			const b = e.target.closest("button[data-op]");
			if (!b) return;
			if (b.dataset.op === "stop" && !confirm(`确定停止 ${b.dataset.name}？`)) return;
			b.disabled = true;
			try {
				await api("/api/actions/container", { method: "POST", body: { name: b.dataset.name, op: b.dataset.op } });
				toast(`${b.dataset.name} 已${b.dataset.op === "restart" ? "重启" : "停止"}`, "ok");
				setTimeout(() => navigate("#ops"), 1500);
			} catch (err) {
				toast(`失败: ${err.message}`, "err");
				b.disabled = false;
			}
		};
	}

	// ---------------- 邮件告警 ----------------
	const ALERT_LABEL = {
		apiDown: "管理 API 失联",
		nodesAllDown: "所有节点均不可用",
		containerDown: "mihomo 容器未运行",
		diskHigh: "磁盘占用过高",
	};

	async function loadAlerts() {
		try {
			const d = await api("/api/alerts");
			const c = d.config;
			$("#alEnabled").checked = !!c.enabled;
			$("#alHost").value = c.smtp.host || "";
			$("#alPort").value = c.smtp.port || 465;
			$("#alUser").value = c.smtp.user || "";
			$("#alPass").value = "";
			$("#alPass").placeholder = c.smtp.pass ? "已设置（留空则不修改）" : "SMTP 授权码 / 密码";
			$("#alFromName").value = c.smtp.fromName || "";
			$("#alFrom").value = c.smtp.from || "";
			$("#alTo").value = c.to || "";
			$("#alInterval").value = c.intervalMin || 5;
			$("#alRepeat").value = c.repeatHours || 6;
			$("#alR_nodes").checked = !!c.rules.nodesAllDown;
			$("#alR_api").checked = !!c.rules.apiDown;
			$("#alR_ctn").checked = !!c.rules.containerDown;
			$("#alR_disk").checked = !!c.rules.diskHigh;
			$("#alDisk").value = c.rules.diskPercent || 90;
			$("#alR_heal").checked = c.rules.autoHeal !== false;
			paintAlertState(d);
		} catch (e) {
			toast(`读取告警设置失败: ${e.message}`, "err");
			$("#alertHint").textContent = "读取失败";
		}
	}

	function collectAlertConfig() {
		return {
			enabled: $("#alEnabled").checked,
			smtp: {
				host: $("#alHost").value.trim(),
				port: Number($("#alPort").value) || 465,
				user: $("#alUser").value.trim(),
				pass: $("#alPass").value, // 空字符串 = 保持不变
				from: $("#alFrom").value.trim(),
				fromName: $("#alFromName").value.trim(),
			},
			to: $("#alTo").value.trim(),
			intervalMin: Number($("#alInterval").value) || 5,
			repeatHours: Number($("#alRepeat").value) || 6,
			rules: {
				nodesAllDown: $("#alR_nodes").checked,
				apiDown: $("#alR_api").checked,
				containerDown: $("#alR_ctn").checked,
				diskHigh: $("#alR_disk").checked,
				diskPercent: Number($("#alDisk").value) || 90,
				autoHeal: $("#alR_heal").checked,
			},
		};
	}

	function paintAlertState(d) {
		const cfg = d.config;
		const st = d.state;
		const p = Number(cfg?.smtp?.port) || 465;
		$("#alPortHint").textContent = p === 587 || p === 25 ? "（STARTTLS）" : p === 465 ? "（SSL/TLS）" : "";

		if (!st) return;
		const bad = Object.entries(st.checks || {})
			.filter(([, v]) => !v.ok)
			.map(([k]) => ALERT_LABEL[k] || k);
		$("#alertHint").textContent = !st.enabled ? "未启用" : bad.length ? "⚠ " + bad.join("、") : "运行中";

		const h = st.history || [];
		$("#alHistCount").textContent = h.length;
		const tb = $("#alHist tbody");
		if (!h.length) {
			tb.innerHTML = `<tr><td colspan="4" class="empty">暂无记录</td></tr>`;
			return;
		}
		tb.innerHTML = h
			.map(
				(e) => `<tr>
				<td class="mono small nowrap">${fmtTime(e.at)}</td>
				<td><span class="badge ${e.kind === "alert" ? "bad" : "ok"}">${e.kind === "alert" ? "告警" : "恢复"}</span></td>
				<td class="small">${esc(e.subject || "")}</td>
				<td>${e.sent === false ? '<span class="badge warn">失败</span>' : '<span class="badge ok">是</span>'}</td>
			</tr>`,
			)
			.join("");
	}

	async function saveAlerts() {
		const btn = $("#alSave");
		btn.disabled = true;
		try {
			const r = await api("/api/alerts/config", { method: "POST", body: collectAlertConfig() });
			toast("告警设置已保存", "ok");
			$("#alPass").value = "";
			paintAlertState({ config: r.config, state: null });
			await loadAlerts();
		} catch (e) {
			toast(`保存失败: ${e.message}`, "err");
		} finally {
			btn.disabled = false;
		}
	}

	async function testAlerts() {
		const btn = $("#alTest");
		btn.disabled = true;
		btn.textContent = "发送中...";
		try {
			const r = await api("/api/alerts/test", { method: "POST", body: {} });
			if (r.ok) toast("测试邮件已发送，请查收", "ok");
			else toast(`发送失败: ${r.error}`, "err");
		} catch (e) {
			toast(`发送失败: ${e.message}`, "err");
		} finally {
			btn.disabled = false;
			btn.textContent = "发送测试邮件";
		}
	}

	async function checkAlerts() {
		const btn = $("#alCheck");
		btn.disabled = true;
		btn.textContent = "检查中...";
		try {
			const r = await api("/api/alerts/check", { method: "POST", body: {} });
			if (!r.ok) {
				toast(`检查失败: ${r.error}`, "err");
			} else if (r.result?.skipped) {
				toast("已有一次检查正在进行中");
			} else {
				const res = r.result || {};
				toast(
					`检查完成：${res.problems ? `${res.problems} 项异常` : "全部正常"}${res.recovered ? `，${res.recovered} 项恢复` : ""}`,
					res.problems ? "err" : "ok",
				);
				paintAlertState({ config: null, state: r.state });
			}
		} catch (e) {
			toast(`检查失败: ${e.message}`, "err");
		} finally {
			btn.disabled = false;
			btn.textContent = "立即检查一次";
		}
	}

	function runRefresh(outEl) {
		return runSSE("/api/actions/refresh/stream", outEl);
	}

	function runSSE(url, outEl) {
		return new Promise((resolve) => {
			if (outEl) {
				outEl.classList.remove("hidden");
				outEl.textContent = "";
			}
			const write = (text, cls) => {
				if (!outEl) return;
				const line = document.createElement("div");
				if (cls) line.className = cls;
				line.textContent = text;
				outEl.appendChild(line);
				outEl.scrollTop = outEl.scrollHeight;
			};
			const es = new EventSource(url);
			es.onmessage = (ev) => {
				let d;
				try {
					d = JSON.parse(ev.data);
				} catch {
					return;
				}
				if (d.type === "step") write(`· ${d.message}`);
				else if (d.type === "status") write(`  ${d.message}`, "muted");
				else if (d.type === "error") write(`! ${d.message}`, "fail");
				else if (d.type === "done") {
					write(d.ok ? `✓ ${d.message}` : `✗ ${d.message}`, d.ok ? "ok" : "fail");
					toast(d.message, d.ok ? "ok" : "err");
					es.close();
					resolve(d.ok);
				}
			};
			es.onerror = () => {
				es.close();
				resolve(false);
			};
		});
	}

	// ============================================================
	// 启动
	// ============================================================
	(async function boot() {
		try {
			const s = await api("/api/session");
			if (s.authed) showApp();
			else showLogin();
		} catch {
			showLogin();
		}
	})();

})();
