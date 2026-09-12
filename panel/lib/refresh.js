// ============================================================
// refresh.js —— 「重新抓源 + 热重载 mihomo」的唯一实现
//
// 有三个地方需要做这件事，所以逻辑只写一份：
//   1) 面板「运维 → 刷新节点池」按钮          (server.js)
//   2) 告警里的「节点全挂自动救援」            (alerts.js)
//   3) 面板内置的定时刷新                     (scheduler.js，替代宿主机 cron)
//
// 内含一把锁：同一时间只会跑一次 bootstrap。重复触发不会排队堆积，
// 而是直接复用正在进行的那一次（并提示调用方）。
// ============================================================
import { dockerListContainers, dockerRestart, dockerStart, mihomoReloadConfig } from "./core.js";

const BOOTSTRAP_CONTAINER = process.env.BOOTSTRAP_CONTAINER || "mihomo-bootstrap";
const MIHOMO_CONTAINER = process.env.MIHOMO_CONTAINER || "mihomo";

/** 进行中的刷新 Promise（null = 空闲）。既是状态标记，也是并发锁。 */
let running = null;

export function isRefreshing() {
	return !!running;
}

async function findContainer(name) {
	try {
		const list = await dockerListContainers();
		return list.find((c) => c.name === name) || null;
	} catch {
		return null;
	}
}

/** 跑一次 bootstrap 容器（它就是"抓源 -> 生成 config.yaml"那一步），等它退出 */
async function runBootstrap(timeoutMs = 180_000) {
	const c = await findContainer(BOOTSTRAP_CONTAINER);
	if (!c) throw new Error(`找不到容器 ${BOOTSTRAP_CONTAINER}`);
	if (c.state === "running") await dockerRestart(BOOTSTRAP_CONTAINER);
	else await dockerStart(BOOTSTRAP_CONTAINER);

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 3000));
		const s = await findContainer(BOOTSTRAP_CONTAINER);
		if (!s || s.state !== "running") return s ? s.state : "gone";
	}
	return "timeout";
}

/**
 * 抓源 -> 生成 config -> 让 mihomo 生效。
 *
 * 优先「热重载」（PUT /configs）：进程不退出、容器不重启、正在走的连接不断，
 * 设备几乎无感。只有热重载接口不可用时，才回退为重启容器。
 *
 * @param {(msg: string) => void} onStep 进度回调（可选）
 * @returns {Promise<{ok: boolean, how?: string, bootstrap?: string, error?: string}>}
 */
export async function refreshNodes(onStep = () => {}) {
	if (running) {
		onStep("已有一次刷新正在进行，等它完成 ...");
		return running;
	}

	running = (async () => {
		try {
			onStep(`启动节点池生成容器 ${BOOTSTRAP_CONTAINER} ...`);
			onStep("等待拉取源并生成配置（最长 3 分钟）...");
			const st = await runBootstrap();
			onStep(`bootstrap 结束（${st}）`);

			let how = "热重载";
			try {
				await mihomoReloadConfig();
				onStep("mihomo 已热重载（容器未重启、设备未断线）");
			} catch (e) {
				onStep(`热重载失败（${e.message}），回退为重启容器 ...`);
				await dockerRestart(MIHOMO_CONTAINER);
				how = "重启";
				onStep("mihomo 已重启（这一步会有短暂断档）");
			}
			return { ok: true, how, bootstrap: st };
		} catch (e) {
			return { ok: false, error: e.message || String(e) };
		} finally {
			running = null;
		}
	})();

	return running;
}
