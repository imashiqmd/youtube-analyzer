import { pool } from "./db.js";
import { getAppSettings } from "./settingsService.js";
import { API_SERVICES } from "./usageService.js";

async function queryUsageTotals(apiService) {
  const params = apiService ? [apiService] : [];
  const where = apiService ? "WHERE api_service = $1" : "";
  const [totals, today] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(units), 0)::int AS total_units,
              COUNT(*)::int AS total_calls,
              COUNT(DISTINCT user_id)::int AS unique_users
       FROM quota_logs
       ${where}`,
      params
    ),
    pool.query(
      `SELECT COALESCE(SUM(units), 0)::int AS units,
              COUNT(*)::int AS calls
       FROM quota_logs
       WHERE created_at >= CURRENT_DATE${apiService ? " AND api_service = $1" : ""}`,
      params
    ),
  ]);
  return {
    allTimeUnits: totals.rows[0].total_units,
    allTimeCalls: totals.rows[0].total_calls,
    uniqueUsers: totals.rows[0].unique_users,
    todayUnits: today.rows[0].units,
    todayCalls: today.rows[0].calls,
  };
}

async function queryUsageByEndpoint(apiService) {
  const { rows } = await pool.query(
    `SELECT endpoint,
            COUNT(*)::int AS calls,
            COALESCE(SUM(units), 0)::int AS units
     FROM quota_logs
     WHERE api_service = $1
     GROUP BY endpoint
     ORDER BY units DESC, calls DESC`,
    [apiService]
  );
  return rows;
}

async function queryUsageByUser(apiService) {
  const { rows } = await pool.query(
    `SELECT u.email, u.display_name,
            COUNT(ql.id)::int AS calls,
            COALESCE(SUM(ql.units), 0)::int AS units
     FROM quota_logs ql
     JOIN users u ON u.id = ql.user_id
     WHERE ql.api_service = $1
     GROUP BY u.id, u.email, u.display_name
     ORDER BY units DESC
     LIMIT 20`,
    [apiService]
  );
  return rows.map((row) => ({
    email: row.email,
    displayName: row.display_name,
    calls: row.calls,
    units: row.units,
  }));
}

async function queryUsageByDay(apiService) {
  const { rows } = await pool.query(
    `SELECT DATE(created_at) AS day,
            COUNT(*)::int AS calls,
            COALESCE(SUM(units), 0)::int AS units
     FROM quota_logs
     WHERE api_service = $1
       AND created_at >= CURRENT_DATE - INTERVAL '30 days'
     GROUP BY DATE(created_at)
     ORDER BY day DESC`,
    [apiService]
  );
  return rows.map((row) => ({
    day: row.day,
    calls: row.calls,
    units: row.units,
  }));
}

async function getUsageStatsForService(apiService) {
  const [totals, byEndpoint, byUser, byDay] = await Promise.all([
    queryUsageTotals(apiService),
    queryUsageByEndpoint(apiService),
    queryUsageByUser(apiService),
    queryUsageByDay(apiService),
  ]);
  return { totals, byEndpoint, byUser, byDay };
}

export async function getDashboardStats() {
  const [users, channels, videos, saved, activity, quota, quotaToday, youtubeToday, geminiToday, settings] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS count FROM users"),
    pool.query("SELECT COUNT(*)::int AS count FROM channels"),
    pool.query("SELECT COUNT(*)::int AS count FROM videos"),
    pool.query("SELECT COUNT(*)::int AS count FROM user_saved_channels"),
    pool.query("SELECT COUNT(*)::int AS count FROM user_activity"),
    pool.query(
      `SELECT COALESCE(SUM(units), 0)::int AS total_units,
              COUNT(*)::int AS total_calls
       FROM quota_logs`
    ),
    pool.query(
      `SELECT COALESCE(SUM(units), 0)::int AS units,
              COUNT(*)::int AS calls
       FROM quota_logs
       WHERE created_at >= CURRENT_DATE`
    ),
    pool.query(
      `SELECT COALESCE(SUM(units), 0)::int AS units,
              COUNT(*)::int AS calls
       FROM quota_logs
       WHERE created_at >= CURRENT_DATE AND api_service = 'youtube'`
    ),
    pool.query(
      `SELECT COALESCE(SUM(units), 0)::int AS units,
              COUNT(*)::int AS calls
       FROM quota_logs
       WHERE created_at >= CURRENT_DATE AND api_service = 'gemini'`
    ),
    getAppSettings(),
  ]);

  const recentActivity = await pool.query(
    `SELECT ua.id, ua.action, ua.channel_id, ua.metadata, ua.created_at,
            u.email, u.display_name
     FROM user_activity ua
     JOIN users u ON u.id = ua.user_id
     ORDER BY ua.created_at DESC
     LIMIT 50`
  );

  const recentQuota = await pool.query(
    `SELECT ql.id, ql.endpoint, ql.units, ql.channel_id, ql.request_source, ql.api_service, ql.created_at,
            u.email AS user_email, u.display_name AS user_name
     FROM quota_logs ql
     LEFT JOIN users u ON u.id = ql.user_id
     ORDER BY ql.created_at DESC
     LIMIT 50`
  );

  const cacheHits = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM user_activity
     WHERE action = 'analyze_channel' AND metadata->>'source' = 'cache'`
  );

  const apiFetches = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM user_activity
     WHERE action = 'analyze_channel' AND metadata->>'source' = 'api'`
  );

  return {
    totals: {
      users: users.rows[0].count,
      channels: channels.rows[0].count,
      videos: videos.rows[0].count,
      savedChannels: saved.rows[0].count,
      activityEvents: activity.rows[0].count,
      quotaUnitsUsed: quota.rows[0].total_units,
      quotaApiCalls: quota.rows[0].total_calls,
      todayUnits: quotaToday.rows[0].units,
      todayCalls: quotaToday.rows[0].calls,
      youtubeTodayUnits: youtubeToday.rows[0].units,
      youtubeTodayCalls: youtubeToday.rows[0].calls,
      geminiTodayUnits: geminiToday.rows[0].units,
      geminiTodayCalls: geminiToday.rows[0].calls,
      cacheHits: cacheHits.rows[0].count,
      apiFetches: apiFetches.rows[0].count,
    },
    settings,
    recentActivity: recentActivity.rows.map(formatActivityRow),
    recentQuota: recentQuota.rows.map(formatQuotaRow),
  };
}

function formatQuotaRow(row) {
  return {
    id: row.id,
    endpoint: row.endpoint,
    units: row.units,
    channelId: row.channel_id,
    requestSource: row.request_source,
    apiService: row.api_service || API_SERVICES.YOUTUBE,
    createdAt: row.created_at,
    userEmail: row.user_email,
    userName: row.user_name,
  };
}

function formatActivityRow(row) {
  return {
    id: row.id,
    action: row.action,
    channelId: row.channel_id,
    metadata: row.metadata,
    createdAt: row.created_at,
    userEmail: row.email,
    userName: row.display_name,
  };
}

export async function listUsers({ limit = 100, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.is_admin, u.created_at,
            (SELECT COUNT(*)::int FROM user_saved_channels WHERE user_id = u.id) AS saved_count,
            (SELECT COUNT(*)::int FROM user_analyzed_channels WHERE user_id = u.id) AS analyzed_count,
            (SELECT COUNT(*)::int FROM user_activity WHERE user_id = u.id) AS activity_count,
            (SELECT COALESCE(SUM(units), 0)::int FROM quota_logs WHERE user_id = u.id AND api_service = 'youtube') AS youtube_units,
            (SELECT COALESCE(SUM(units), 0)::int FROM quota_logs WHERE user_id = u.id AND api_service = 'gemini') AS gemini_units,
            (SELECT COALESCE(SUM(units), 0)::int FROM quota_logs WHERE user_id = u.id) AS quota_units,
            COALESCE(
              (
                SELECT json_agg(channel_row ORDER BY channel_row->>'analyzedAt' DESC)
                FROM (
                  SELECT json_build_object(
                    'channelId', uac.channel_id,
                    'title', COALESCE(c.channel_data->>'title', usc.title, uac.channel_id),
                    'handle', COALESCE(c.handle, ''),
                    'analyzedAt', uac.first_analyzed_at
                  ) AS channel_row
                  FROM user_analyzed_channels uac
                  LEFT JOIN channels c ON c.channel_id = uac.channel_id
                  LEFT JOIN user_saved_channels usc ON usc.user_id = uac.user_id AND usc.channel_id = uac.channel_id
                  WHERE uac.user_id = u.id
                ) analyzed
              ),
              '[]'::json
            ) AS analyzed_channels
     FROM users u
     ORDER BY u.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: row.is_admin,
    createdAt: row.created_at,
    savedCount: row.saved_count,
    analyzedCount: row.analyzed_count,
    activityCount: row.activity_count,
    quotaUnits: row.quota_units,
    youtubeUnits: row.youtube_units,
    geminiUnits: row.gemini_units,
    analyzedChannels: Array.isArray(row.analyzed_channels) ? row.analyzed_channels : [],
  }));
}

export async function listChannels({ limit = 100, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT c.channel_id, c.handle, c.last_synced_at, c.created_at, c.updated_at,
            c.channel_data->>'title' AS title,
            jsonb_array_length(c.video_ids) AS video_count,
            COUNT(DISTINCT usc.user_id)::int AS saved_by_users
     FROM channels c
     LEFT JOIN user_saved_channels usc ON usc.channel_id = c.channel_id
     GROUP BY c.channel_id, c.handle, c.last_synced_at, c.created_at, c.updated_at, c.channel_data, c.video_ids
     ORDER BY c.last_synced_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows.map((row) => ({
    channelId: row.channel_id,
    handle: row.handle,
    title: row.title,
    videoCount: Number(row.video_count) || 0,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    savedByUsers: row.saved_by_users,
  }));
}

export async function listActivity({ limit = 100, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT ua.id, ua.action, ua.channel_id, ua.metadata, ua.created_at,
            u.email, u.display_name
     FROM user_activity ua
     JOIN users u ON u.id = ua.user_id
     ORDER BY ua.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows.map(formatActivityRow);
}

export async function listQuotaLogs({ limit = 100, offset = 0, apiService = null } = {}) {
  const params = [limit, offset];
  let where = "";
  if (apiService) {
    where = "WHERE ql.api_service = $3";
    params.push(apiService);
  }
  const { rows } = await pool.query(
    `SELECT ql.id, ql.endpoint, ql.units, ql.channel_id, ql.request_source, ql.api_service, ql.created_at,
            u.email AS user_email, u.display_name AS user_name
     FROM quota_logs ql
     LEFT JOIN users u ON u.id = ql.user_id
     ${where}
     ORDER BY ql.created_at DESC
     LIMIT $1 OFFSET $2`,
    params
  );
  return rows.map(formatQuotaRow);
}

export async function getQuotaStats() {
  const [youtube, gemini] = await Promise.all([
    getUsageStatsForService(API_SERVICES.YOUTUBE),
    getUsageStatsForService(API_SERVICES.GEMINI),
  ]);

  return { youtube, gemini };
}
