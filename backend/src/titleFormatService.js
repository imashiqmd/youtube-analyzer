import { pool } from "./db.js";

export const TITLE_FORMAT_CLASSIFICATION_VERSION = 1;

const CHARACTERISTIC_KEYS = [
  "has_question",
  "has_number",
  "has_vs",
  "has_colon",
  "has_brackets",
  "has_parentheses",
  "has_first_person",
];

export function isValidTitleFormatClassification(c) {
  return !!(
    c &&
    c.version === TITLE_FORMAT_CLASSIFICATION_VERSION &&
    c.primaryFormat &&
    typeof c.confidence === "number"
  );
}

function normalizeCharacteristics(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const out = {};
  CHARACTERISTIC_KEYS.forEach((key) => {
    out[key] = !!source[key];
  });
  return out;
}

export function normalizeTitleFormatClassification(raw) {
  if (!raw || !raw.primaryFormat) return null;
  const primary = String(raw.primaryFormat).trim().replace(/\s+/g, " ");
  if (!primary) return null;
  return {
    version: TITLE_FORMAT_CLASSIFICATION_VERSION,
    primaryFormat: primary,
    characteristics: normalizeCharacteristics(raw.characteristics),
    confidence: Math.min(1, Math.max(0, Number(raw.confidence) || 0.5)),
    classifiedAt: raw.classifiedAt || new Date().toISOString(),
  };
}

function parseTitleFormatClassificationsColumn(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return parseTitleFormatClassificationsColumn(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

export function sanitizeTitleFormatClassificationsMap(input) {
  const source = parseTitleFormatClassificationsColumn(input);
  const out = {};
  for (const [videoId, raw] of Object.entries(source)) {
    if (!videoId) continue;
    const normalized = normalizeTitleFormatClassification(raw);
    if (normalized) out[videoId] = normalized;
  }
  return out;
}

export async function getTitleFormatClassifications(channelId) {
  const { rows } = await pool.query(
    `SELECT title_format_classifications FROM channels WHERE channel_id = $1 LIMIT 1`,
    [channelId]
  );
  if (!rows[0]) return {};
  return sanitizeTitleFormatClassificationsMap(rows[0].title_format_classifications);
}

export async function mergeTitleFormatClassifications(channelId, incoming) {
  const additions = sanitizeTitleFormatClassificationsMap(incoming);
  if (!Object.keys(additions).length) {
    return getTitleFormatClassifications(channelId);
  }

  const { rows } = await pool.query(
    `UPDATE channels
     SET title_format_classifications = COALESCE(title_format_classifications, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE channel_id = $1
     RETURNING title_format_classifications`,
    [channelId, JSON.stringify(additions)]
  );

  if (!rows[0]) {
    const err = new Error("Channel not found. Analyze it first.");
    err.status = 404;
    throw err;
  }

  return sanitizeTitleFormatClassificationsMap(rows[0].title_format_classifications);
}
