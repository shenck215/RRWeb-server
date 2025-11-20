import { Hono } from "hono";
import { cors } from "hono/cors";
import { ungzip } from "pako";
import type { KVNamespace } from "@cloudflare/workers-types";

// Cloudflare Worker 的环境声明：这里用 KV 存储会话
type Env = {
	RRWEB_SERVER: KVNamespace;
};

type RRWebEvent = any;

type EventsRequestBody =
	| {
			sessionId: string;
			events: RRWebEvent[];
			compressed?: false;
			payload?: undefined;
	  }
	| {
			sessionId: string;
			events?: RRWebEvent[];
			compressed: true;
			payload: string; // base64 + gzip
	  };

const app = new Hono<{ Bindings: Env }>();

// ------------------ 代数管理相关 ------------------

// 记录当前代数的 KV key
const GEN_KEY = "__GEN__";

/** 获取当前代数（不存在则初始化为 1） */
const getGeneration = async (env: Env): Promise<number> => {
	const v = await env.RRWEB_SERVER.get(GEN_KEY);
	if (!v) {
		await env.RRWEB_SERVER.put(GEN_KEY, "1");
		return 1;
	}
	const n = Number(v);
	if (!Number.isFinite(n) || n < 1) {
		await env.RRWEB_SERVER.put(GEN_KEY, "1");
		return 1;
	}
	return n;
};

/** 把当前代数 +1，用于“清空所有会话” */
const bumpGeneration = async (env: Env): Promise<number> => {
	const cur = await getGeneration(env);
	const next = cur + 1;
	await env.RRWEB_SERVER.put(GEN_KEY, String(next));
	return next;
};

/** 根据代数 + sessionId 生成真正的 KV key */
const buildKey = (gen: number, sessionId: string): string =>
	`${gen}:${sessionId}`;

/** 从 KV key 里反推出 sessionId（前提：key 形如 `${gen}:xxx`） */
const extractSessionId = (gen: number, name: string): string =>
	name.slice(`${gen}:`.length);

// -------------------------------------------------

// 全局 CORS
app.use("*", cors());

// 创建会话
app.post("/session", async (c) => {
	const gen = await getGeneration(c.env);
	const sessionId = crypto.randomUUID();
	const key = buildKey(gen, sessionId);

	console.log("create session:", { gen, sessionId, key });

	// 初始化为空数组
	await c.env.RRWEB_SERVER.put(key, JSON.stringify([]));

	return c.json({ sessionId });
});

// 接收事件
app.post("/events", async (c) => {
	try {
		const body = (await c.req.json()) as EventsRequestBody;

		const { sessionId } = body;
		if (!sessionId) {
			return c.json({ error: "missing sessionId" }, 400);
		}

		const gen = await getGeneration(c.env);
		const key = buildKey(gen, sessionId);

		// 读取已有事件（如无则为空数组）
		const exist = await c.env.RRWEB_SERVER.get(key, "json");
		const existingEvents: RRWebEvent[] = Array.isArray(exist) ? exist : [];

		// 还原本次上报的 batch
		let batch: RRWebEvent[] | undefined = body.events;

		if (body.compressed) {
			if (!body.payload) {
				return c.json(
					{ error: "missing payload for compressed request" },
					400
				);
			}

			// base64 → Uint8Array
			const binary = Uint8Array.from(atob(body.payload), (ch) =>
				ch.charCodeAt(0)
			);
			const jsonStr = new TextDecoder().decode(ungzip(binary));
			batch = JSON.parse(jsonStr);
		}

		if (!Array.isArray(batch)) {
			return c.json({ error: "events should be an array" }, 400);
		}

		const allEvents = existingEvents.concat(batch);

		// KV 不支持“追加”文件，只能整体覆盖
		await c.env.RRWEB_SERVER.put(key, JSON.stringify(allEvents));

		return c.json({ ok: true, count: batch.length });
	} catch (e: any) {
		console.error(e);
		return c.json({ error: e?.message ?? "internal error" }, 500);
	}
});

// 获取会话事件
app.post("/sessions/get", async (c) => {
	const { sessionId } = (await c.req.json()) as { sessionId?: string };

	if (!sessionId) {
		return c.json({ error: "missing sessionId" }, 400);
	}

	const gen = await getGeneration(c.env);
	const key = buildKey(gen, sessionId);
	const data = await c.env.RRWEB_SERVER.get(key, "json");

	if (!data) {
		return c.json({ error: "session not found" }, 404);
	}

	const events: RRWebEvent[] = Array.isArray(data) ? data : [];

	return c.json({ events });
});

// 列出当前代数下的所有会话
app.post("/sessions/list", async (c) => {
	const gen = await getGeneration(c.env);
	const prefix = `${gen}:`;

	// 只列出当前代的 key
	const list = (await c.env.RRWEB_SERVER.list({
		prefix,
	})) as any;

	const sessions = (list.keys as { name: string }[])
		.map((k) => k.name)
		.map((name) => extractSessionId(gen, name));

	return c.json({ sessions });
});

// 删除当前代数中的单个会话
app.post("/sessions/remove", async (c) => {
	try {
		const { sessionId } = (await c.req.json()) as { sessionId?: string };

		if (!sessionId) {
			return c.json({ ok: false, error: "missing sessionId" }, 400);
		}

		const gen = await getGeneration(c.env);
		const key = buildKey(gen, sessionId);

		const data = await c.env.RRWEB_SERVER.get(key);
		if (!data) {
			return c.json({ ok: false, error: "session not found" }, 404);
		}

		await c.env.RRWEB_SERVER.delete(key);
		return c.json({ ok: true, message: `session ${sessionId} removed` });
	} catch (e: any) {
		console.error(e);
		return c.json({ ok: false, error: e?.message ?? "internal error" }, 500);
	}
});

// 清空所有会话（逻辑清空：O(1)，秒生效）
app.post("/sessions/clear", async (c) => {
	try {
		const nextGen = await bumpGeneration(c.env);
		console.log("bump generation to", nextGen);

		return c.json({
			ok: true,
			message: "all sessions cleared (generation bumped)",
			generation: nextGen,
		});
	} catch (e: any) {
		console.error(e);
		return c.json({ ok: false, error: e?.message ?? "internal error" }, 500);
	}
});

export default app;
