import { pool } from "./db.js";

export const TOPIC_CLASSIFICATION_VERSION = 1;

export function isValidTopicClassification(c) {
  return !!(
    c &&
    c.version === TOPIC_CLASSIFICATION_VERSION &&
    c.primaryTopic &&
    typeof c.confidence === "number"
  );
}

export function normalizeTopicClassification(raw) {
  if (!raw || !raw.primaryTopic) return null;
  const primary = String(raw.primaryTopic).trim().replace(/\s+/g, " ");
  return {
    version: TOPIC_CLASSIFICATION_VERSION,
    primaryTopic: primary.toLowerCase() === "other" ? "Other" : primary,
    subtopic: raw.subtopic ? String(raw.subtopic).trim().replace(/\s+/g, " ") : null,
    entities: Array.isArray(raw.entities)
      ? raw.entities.map((e) => String(e).trim()).filter(Boolean).slice(0, 12)
      : [],
    contentType: raw.contentType || "other",
    confidence: Math.min(1, Math.max(0, Number(raw.confidence) || 0.5)),
    classifiedAt: raw.classifiedAt || new Date().toISOString(),
  };
}

function parseTopicClassificationsColumn(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return parseTopicClassificationsColumn(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

export function sanitizeClassificationsMap(input) {
  const source = parseTopicClassificationsColumn(input);
  const out = {};
  for (const [videoId, raw] of Object.entries(source)) {
    if (!videoId) continue;
    const normalized = normalizeTopicClassification(raw);
    if (normalized) out[videoId] = normalized;
  }
  return out;
}

export async function getTopicClassifications(channelId) {
  const { rows } = await pool.query(
    `SELECT topic_classifications FROM channels WHERE channel_id = $1 LIMIT 1`,
    [channelId]
  );
  if (!rows[0]) return {};
  return sanitizeClassificationsMap(rows[0].topic_classifications);
}

export async function mergeTopicClassifications(channelId, incoming) {
  const additions = sanitizeClassificationsMap(incoming);
  if (!Object.keys(additions).length) {
    return getTopicClassifications(channelId);
  }

  const { rows } = await pool.query(
    `UPDATE channels
     SET topic_classifications = COALESCE(topic_classifications, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE channel_id = $1
     RETURNING topic_classifications`,
    [channelId, JSON.stringify(additions)]
  );

  if (!rows[0]) {
    const err = new Error("Channel not found. Analyze it first.");
    err.status = 404;
    throw err;
  }

  return sanitizeClassificationsMap(rows[0].topic_classifications);
}
