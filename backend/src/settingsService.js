import { pool } from "./db.js";

export const DEFAULT_MAX_CHANNELS_PER_USER = 5;
export const DEFAULT_GEMINI_ENABLED_FOR_USERS = true;

const MAX_CHANNELS_KEY = "max_channels_per_user";
const GEMINI_ENABLED_KEY = "gemini_enabled_for_users";

let cachedLimit = null;
let cachedGeminiEnabled = null;
let cacheTime = 0;
const CACHE_MS = 3000;

function invalidateSettingsCache() {
  cachedLimit = null;
  cachedGeminiEnabled = null;
  cacheTime = 0;
}

async function upsertSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = NOW()`,
    [key, String(value)]
  );
  invalidateSettingsCache();
}

export async function getMaxChannelsPerUser() {
  const now = Date.now();
  if (cachedLimit !== null && now - cacheTime < CACHE_MS) {
    return cachedLimit;
  }

  const { rows } = await pool.query(
    `SELECT value FROM app_settings WHERE key = $1`,
    [MAX_CHANNELS_KEY]
  );

  const parsed = rows[0] ? parseInt(rows[0].value, 10) : DEFAULT_MAX_CHANNELS_PER_USER;
  cachedLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CHANNELS_PER_USER;
  cacheTime = now;
  return cachedLimit;
}

export async function setMaxChannelsPerUser(limit) {
  const val = parseInt(limit, 10);
  if (!Number.isFinite(val) || val < 1 || val > 1000) {
    const err = new Error("Channel limit must be between 1 and 1000.");
    err.status = 400;
    throw err;
  }

  await upsertSetting(MAX_CHANNELS_KEY, val);
  cachedLimit = val;
  cacheTime = Date.now();
  return val;
}

export async function getGeminiEnabledForUsers() {
  const now = Date.now();
  if (cachedGeminiEnabled !== null && now - cacheTime < CACHE_MS) {
    return cachedGeminiEnabled;
  }

  const { rows } = await pool.query(
    `SELECT value FROM app_settings WHERE key = $1`,
    [GEMINI_ENABLED_KEY]
  );

  if (!rows[0]) {
    cachedGeminiEnabled = DEFAULT_GEMINI_ENABLED_FOR_USERS;
  } else {
    const raw = String(rows[0].value).trim().toLowerCase();
    cachedGeminiEnabled = raw === "true" || raw === "1" || raw === "yes" || raw === "on";
  }
  cacheTime = now;
  return cachedGeminiEnabled;
}

export async function setGeminiEnabledForUsers(enabled) {
  const val = !!enabled;
  await upsertSetting(GEMINI_ENABLED_KEY, val ? "true" : "false");
  cachedGeminiEnabled = val;
  cacheTime = Date.now();
  return val;
}

export async function getAppSettings() {
  const [maxChannelsPerUser, geminiEnabledForUsers] = await Promise.all([
    getMaxChannelsPerUser(),
    getGeminiEnabledForUsers(),
  ]);
  return { maxChannelsPerUser, geminiEnabledForUsers };
}

export async function assertGeminiAllowedForUser(user) {
  if (!user || user.isAdmin) return;
  const enabled = await getGeminiEnabledForUsers();
  if (!enabled) {
    const err = new Error(
      "AI topic analysis is currently turned off for users. Please try again later or contact an admin."
    );
    err.status = 403;
    err.code = "GEMINI_DISABLED";
    throw err;
  }
}

export function canUserUseGemini(user, geminiEnabledForUsers) {
  return !!(user && (user.isAdmin || geminiEnabledForUsers));
}
