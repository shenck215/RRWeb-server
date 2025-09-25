import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fse from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { gzipSync, gunzipSync } from "zlib";

// 处理 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;
const DATA_DIR = path.join(__dirname, "storage");

app.use(cors());
app.use(bodyParser.json({ limit: "10mb" })); // 支持批量/压缩后依然足够

// 创建会话
app.post("/session", async (req, res) => {
  const sessionId = uuidv4();
  const p = path.join(DATA_DIR, `${sessionId}.jsonl`);
  await fse.ensureFile(p);
  res.json({ sessionId });
});

// 接收事件
app.post("/events", async (req, res) => {
  try {
    const { sessionId, events, compressed, payload } = req.body;
    if (!sessionId) return res.status(400).json({ error: "missing sessionId" });

    const file = path.join(DATA_DIR, `${sessionId}.jsonl`);
    await fse.ensureFile(file);

    let batch = events;
    if (compressed) {
      const buf = Buffer.from(payload, "base64");
      const jsonStr = gunzipSync(buf).toString("utf-8");
      batch = JSON.parse(jsonStr);
    }

    if (!Array.isArray(batch)) {
      return res.status(400).json({ error: "events should be an array" });
    }

    const lines = batch.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fse.appendFile(file, lines, "utf-8");

    res.json({ ok: true, count: batch.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 获取会话事件
app.post("/sessions/get", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "missing sessionId" });

  const file = path.join(DATA_DIR, `${sessionId}.jsonl`);
  if (!(await fse.pathExists(file))) {
    return res.status(404).json({ error: "session not found" });
  }
  const content = await fse.readFile(file, "utf-8");
  const events = content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  res.json({ events });
});

// 列出所有会话
app.post("/sessions/list", async (_req, res) => {
  await fse.ensureDir(DATA_DIR);
  const files = (await fse.readdir(DATA_DIR)).filter((n) =>
    n.endsWith(".jsonl")
  );
  const list = files.map((f) => f.replace(".jsonl", ""));
  res.json({ sessions: list });
});

// 删除单个会话
app.post("/sessions/remove", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "missing sessionId" });

    const file = path.join(DATA_DIR, `${sessionId}.jsonl`);
    const exists = await fse.pathExists(file);
    if (!exists)
      return res.status(404).json({ ok: false, error: "session not found" });

    await fse.remove(file);
    res.json({ ok: true, message: `session ${sessionId} removed` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 清空所有会话
app.post("/sessions/clear", async (_req, res) => {
  try {
    await fse.ensureDir(DATA_DIR);
    await fse.emptyDir(DATA_DIR);
    await fse.ensureDir(DATA_DIR);
    res.json({ ok: true, message: "all sessions cleared" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, async () => {
  await fse.ensureDir(DATA_DIR);
  console.log(`rrweb demo server listening on http://localhost:${PORT}`);
});
