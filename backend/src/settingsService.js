import { pool } from "./db.js";

export const DEFAULT_MAX_CHANNELS_PER_USER = 5;
const SETTING_KEY = "max_channels_per_user";

let cachedLimit = null;
let cacheTime = 0;
const CACHE_MS = 3000;

export async function getMaxChannelsPerUser() {
  const now = Date.now();
  if (cachedLimit !== null && now - cacheTime < CACHE_MS) {
    return cachedLimit;
  }

  const { rows } = await pool.query(
    `SELECT value FROM app_settings WHERE key = $1`,
    [SETTING_KEY]
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

  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = NOW()`,
    [SETTING_KEY, String(val)]
  );

  cachedLimit = val;
  cacheTime = Date.now();
  return val;
}

export async function getAppSettings() {
  const maxChannelsPerUser = await getMaxChannelsPerUser();
  return { maxChannelsPerUser };
}
