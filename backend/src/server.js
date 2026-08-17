import "dotenv/config";
import express from "express";
import { pool, migrate } from "./db.js";
import { analyzeChannel } from "./analyzeService.js";

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.post("/analyze", async (req, res) => {
  const handle = req.body?.handle;
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!handle || typeof handle !== "string" || !handle.trim()) {
    return res.status(400).json({ error: "handle is required" });
  }

  if (!apiKey) {
    return res.status(500).json({ error: "YOUTUBE_API_KEY is not configured on the server" });
  }

  try {
    const result = await analyzeChannel({ handle: handle.trim(), apiKey });
    console.log(
      `[analyze] handle=${handle.trim()} channel=${result.channelId} source=${result.source} units=${result.units_used}`
    );
    res.json(result);
  } catch (err) {
    const status = err.status || (err.youtubeError ? 502 : 500);
    console.error(`[analyze] handle=${handle} error=${err.message}`);
    res.status(status).json({ error: err.message });
  }
});

async function start() {
  await migrate();
  app.listen(port, () => {
    console.log(`YouTube analyzer API listening on http://localhost:${port}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
