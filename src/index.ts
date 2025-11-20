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

type KvListPage = {
	keys: { name: string }[];
	list_complete: boolean;
	cursor?: string;
};

const app = new Hono<{ Bindings: Env }>();

// 全局 CORS
app.use("*", cors());

// 创建会话
app.post("/session", async (c) => {
	const sessionId = crypto.randomUUID();
	console.log("create session:", sessionId);

	await c.env.RRWEB_SERVER.put(sessionId, JSON.stringify([]));

	// 保持简单版本即可
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

		// 读取已有事件（如无则为空数组）
		const exist = await c.env.RRWEB_SERVER.get(sessionId, "json");
		const existingEvents: RRWebEvent[] = Array.isArray(exist) ? exist : [];

		// 还原本次上报的 batch
		let batch: RRWebEvent[] | undefined = body.events;

		if (body.compressed) {
			if (!body.payload) {
				return c.json({ error: "missing payload for compressed request" }, 400);
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
		await c.env.RRWEB_SERVER.put(sessionId, JSON.stringify(allEvents));

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

	const data = await c.env.RRWEB_SERVER.get(sessionId, "json");

	if (!data) {
		return c.json({ error: "session not found" }, 404);
	}

	const events: RRWebEvent[] = Array.isArray(data) ? data : [];

	return c.json({ events });
});

// 列出所有会话
app.post("/sessions/list", async (c) => {
	// KV 的 list 会分页，这里简单处理：只列出第一页
	const list = await c.env.RRWEB_SERVER.list();

	const sessions = list.keys.map((k) => k.name);

	return c.json({ sessions });
});

// 删除单个会话
app.post("/sessions/remove", async (c) => {
	try {
		const { sessionId } = (await c.req.json()) as { sessionId?: string };

		if (!sessionId) {
			return c.json({ ok: false, error: "missing sessionId" }, 400);
		}

		const data = await c.env.RRWEB_SERVER.get(sessionId);
		if (!data) {
			return c.json({ ok: false, error: "session not found" }, 404);
		}

		await c.env.RRWEB_SERVER.delete(sessionId);
		return c.json({ ok: true, message: `session ${sessionId} removed` });
	} catch (e: any) {
		console.error(e);
		return c.json({ ok: false, error: e?.message ?? "internal error" }, 500);
	}
});

// 清空所有会话（注意：大量会话时会比较慢）
app.post("/sessions/clear", async (c) => {
	try {
		let cursor: string | undefined = undefined;

		while (true) {
			// 必须为 KVNamespaceListResult 指定泛型，如 <unknown>
			const result: KvListPage = await c.env.RRWEB_SERVER.list({ cursor });

			for (const k of result.keys) {
				await c.env.RRWEB_SERVER.delete(k.name);
			}

			if (!result.cursor) {
				break; // 没有下一页
			}

			cursor = result.cursor;
		}

		return c.json({ ok: true, message: "all sessions cleared" });
	} catch (e: any) {
		console.error(e);
		return c.json({ ok: false, error: e?.message ?? "internal error" }, 500);
	}
});

export default app;
