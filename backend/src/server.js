import "dotenv/config";
import express from "express";
import compression from "compression";
import { pool, migrate } from "./db.js";
import { analyzeChannel, getChannelBundleById, resolveCachedChannelId } from "./analyzeService.js";
import { signUp, signIn, signOut, getUserFromToken, cleanupExpiredSessions } from "./authService.js";
import {
  listSavedChannels,
  saveChannelForUser,
  removeSavedChannel,
  logUserActivity,
  assertUserCanAnalyzeChannel,
  recordUserChannelAnalysis,
  fetchUserChannelUsage,
} from "./userService.js";
import {
  getDashboardStats,
  listUsers,
  listChannels,
  listActivity,
  listQuotaLogs,
  getQuotaStats,
} from "./adminService.js";

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(compression());
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

async function requireAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "Sign in required." });
  }
  try {
    const user = await getUserFromToken(token);
    if (!user) {
      return res.status(401).json({ error: "Session expired. Please sign in again." });
    }
    req.user = user;
    req.authToken = token;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function requireAdmin(req, res, next) {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "Sign in required." });
  }
  try {
    const user = await getUserFromToken(token);
    if (!user) {
      return res.status(401).json({ error: "Session expired. Please sign in again." });
    }
    if (!user.isAdmin) {
      return res.status(403).json({ error: "Admin access required." });
    }
    req.user = user;
    req.authToken = token;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.get("/", (_req, res) => {
  res.json({
    name: "YouTube Channel Analyzer API",
    status: "ok",
    endpoints: {
      health: "GET /health",
      analyze: "POST /analyze",
      channel: "GET /channels/:channelId",
      savedChannels: "GET/POST /me/saved-channels",
      adminDashboard: "GET /admin/dashboard",
    },
  });
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.post("/auth/signup", async (req, res) => {
  const { email, password, displayName } = req.body || {};
  try {
    const user = await signUp({ email, password, displayName });
    res.status(201).json({ user });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "An account with this email already exists." });
    }
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password, rememberMe } = req.body || {};
  try {
    const result = await signIn({ email, password, rememberMe: Boolean(rememberMe) });
    await logUserActivity(result.user.id, "sign_in", {
      metadata: { rememberMe: Boolean(rememberMe) },
    });
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.post("/auth/logout", async (req, res) => {
  try {
    const user = await getUserFromToken(getBearerToken(req));
    await signOut(getBearerToken(req));
    if (user) await logUserActivity(user.id, "sign_out");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/auth/me", async (req, res) => {
  try {
    const user = await getUserFromToken(getBearerToken(req));
    if (!user) {
      return res.status(401).json({ error: "Not signed in." });
    }
    const usage = await fetchUserChannelUsage(user.id, user.isAdmin);
    res.json({ user, usage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/me/saved-channels", requireAuth, async (req, res) => {
  try {
    const channels = await listSavedChannels(req.user.id);
    res.json({ channels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/me/saved-channels", requireAuth, async (req, res) => {
  const { channelId, title, thumbnail, query } = req.body || {};
  if (!channelId || !title) {
    return res.status(400).json({ error: "channelId and title are required." });
  }
  try {
    await saveChannelForUser(req.user.id, { channelId, title, thumbnail, query });
    const channels = await listSavedChannels(req.user.id);
    res.json({ channels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/me/saved-channels/:channelId", requireAuth, async (req, res) => {
  try {
    await removeSavedChannel(req.user.id, req.params.channelId);
    const channels = await listSavedChannels(req.user.id);
    res.json({ channels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/channels/:channelId", requireAuth, async (req, res) => {
  try {
    const channelId = req.params.channelId;
    await assertUserCanAnalyzeChannel(req.user, channelId);
    const result = await getChannelBundleById(channelId);
    if (!result) {
      return res.status(404).json({ error: "Channel not found. Analyze it first." });
    }
    await recordUserChannelAnalysis(req.user.id, channelId);
    const usage = await fetchUserChannelUsage(req.user.id, req.user.isAdmin);
    res.json({ ...result, usage });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message, code: err.code || undefined });
  }
});

app.post("/analyze", requireAuth, async (req, res) => {
  const handle = req.body?.handle;
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!handle || typeof handle !== "string" || !handle.trim()) {
    return res.status(400).json({ error: "handle is required" });
  }

  if (!apiKey) {
    return res.status(500).json({ error: "YOUTUBE_API_KEY is not configured on the server" });
  }

  try {
    const trimmedHandle = handle.trim();
    const channelIdHint = await resolveCachedChannelId(trimmedHandle);
    await assertUserCanAnalyzeChannel(req.user, channelIdHint);

    const result = await analyzeChannel({
      handle: trimmedHandle,
      apiKey,
      userId: req.user.id,
    });
    await recordUserChannelAnalysis(req.user.id, result.channelId);
    const usage = await fetchUserChannelUsage(req.user.id, req.user.isAdmin);

    console.log(
      `[analyze] user=${req.user.email} handle=${trimmedHandle} channel=${result.channelId} source=${result.source} units=${result.units_used}`
    );
    res.json({ ...result, usage });
  } catch (err) {
    const status = err.status || (err.youtubeError ? 502 : 500);
    console.error(`[analyze] handle=${handle} error=${err.message}`);
    res.status(status).json({ error: err.message, code: err.code || undefined });
  }
});

app.get("/admin/dashboard", requireAdmin, async (_req, res) => {
  try {
    res.json(await getDashboardStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/users", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    res.json({ users: await listUsers({ limit, offset }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/channels", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    res.json({ channels: await listChannels({ limit, offset }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/activity", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    res.json({ activity: await listActivity({ limit, offset }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/quota-logs", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    res.json({ logs: await listQuotaLogs({ limit, offset }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/quota-stats", requireAdmin, async (_req, res) => {
  try {
    res.json(await getQuotaStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function start() {
  await migrate();
  app.listen(port, () => {
    console.log(`YouTube analyzer API listening on http://localhost:${port}`);
    cleanupExpiredSessions().catch((err) => {
      console.warn("Session cleanup failed:", err.message);
    });
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
