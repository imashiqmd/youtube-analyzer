import { pool } from "./db.js";

export const API_SERVICES = {
  YOUTUBE: "youtube",
  GEMINI: "gemini",
};

export async function logApiUsage({
  apiService = API_SERVICES.YOUTUBE,
  endpoint,
  units = 1,
  channelId = null,
  requestSource = null,
  userId = null,
}) {
  if (!endpoint) return;
  await pool.query(
    `INSERT INTO quota_logs (endpoint, units, channel_id, request_source, user_id, api_service)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [endpoint, units, channelId, requestSource, userId, apiService]
  );
}

export async function logApiUsageBatch(client, {
  calls,
  channelId,
  requestSource,
  userId = null,
  apiService = API_SERVICES.YOUTUBE,
}) {
  if (!calls.length) return;

  const endpoints = [];
  const units = [];
  const channelIds = [];
  const sources = [];
  const userIds = [];
  const services = [];

  for (const call of calls) {
    endpoints.push(call.endpoint);
    units.push(call.units);
    channelIds.push(channelId || null);
    sources.push(requestSource || null);
    userIds.push(userId || null);
    services.push(apiService);
  }

  await client.query(
    `INSERT INTO quota_logs (endpoint, units, channel_id, request_source, user_id, api_service)
     SELECT e, u, c, s, uid, svc
     FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::uuid[], $6::text[])
       AS t(e, u, c, s, uid, svc)`,
    [endpoints, units, channelIds, sources, userIds, services]
  );
}

export async function logGeminiUsage({
  userId,
  channelId,
  model,
  videosClassified = 0,
  requestSource = "topic_classification",
}) {
  await logApiUsage({
    apiService: API_SERVICES.GEMINI,
    endpoint: model || "generateContent",
    units: 1,
    channelId,
    requestSource: videosClassified
      ? requestSource + ":" + videosClassified + "_videos"
      : requestSource,
    userId,
  });
}
