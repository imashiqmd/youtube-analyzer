import crypto from "crypto";
import { promisify } from "util";
import { pool } from "./db.js";

const scrypt = promisify(crypto.scrypt);

const SALT_LEN = 16;
const KEY_LEN = 64;
const REMEMBER_ME_DAYS = 30;
const SESSION_HOURS = 24;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const derived = await scrypt(password, salt, KEY_LEN);
  return salt.toString("hex") + ":" + derived.toString("hex");
}

export async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scrypt(password, salt, KEY_LEN);
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function sessionExpiry(rememberMe) {
  const ms = rememberMe
    ? REMEMBER_ME_DAYS * 24 * 60 * 60 * 1000
    : SESSION_HOURS * 60 * 60 * 1000;
  return new Date(Date.now() + ms);
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name || row.email.split("@")[0],
    isAdmin: Boolean(row.is_admin),
    createdAt: row.created_at,
  };
}

function isAdminEmail(email) {
  const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (!adminEmail) return false;
  return normalizeEmail(email) === adminEmail;
}

async function syncAdminFlag(userId, email) {
  if (!isAdminEmail(email)) return;
  await pool.query("UPDATE users SET is_admin = TRUE WHERE id = $1", [userId]);
}

export async function signUp({ email, password, displayName }) {
  const normalizedEmail = normalizeEmail(email);
  const name = String(displayName || "").trim();

  if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
    const err = new Error("Enter a valid email address.");
    err.status = 400;
    throw err;
  }
  if (!password || password.length < 6) {
    const err = new Error("Password must be at least 6 characters.");
    err.status = 400;
    throw err;
  }

  const passwordHash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, display_name, is_admin, created_at`,
    [normalizedEmail, passwordHash, name || null, isAdminEmail(normalizedEmail)]
  );

  const user = publicUser(rows[0]);
  return user;
}

export async function signIn({ email, password, rememberMe = false }) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !password) {
    const err = new Error("Email and password are required.");
    err.status = 400;
    throw err;
  }

  const { rows } = await pool.query(
    `SELECT id, email, display_name, password_hash, is_admin, created_at
     FROM users
     WHERE LOWER(email) = $1`,
    [normalizedEmail]
  );

  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    const err = new Error("Invalid email or password.");
    err.status = 401;
    throw err;
  }

  await syncAdminFlag(user.id, user.email);
  if (isAdminEmail(user.email)) user.is_admin = true;

  const token = createSessionToken();
  const expiresAt = sessionExpiry(rememberMe);

  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, hashToken(token), expiresAt]
  );

  return {
    user: publicUser(user),
    token,
    expiresAt: expiresAt.toISOString(),
    rememberMe: Boolean(rememberMe),
  };
}

export async function signOut(token) {
  if (!token) return;
  await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

export async function getUserFromToken(token) {
  if (!token) return null;

  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.is_admin, u.created_at, s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashToken(token)]
  );

  const row = rows[0];
  if (!row) return null;

  if (new Date(row.expires_at) < new Date()) {
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
    return null;
  }

  return publicUser(row);
}

export async function cleanupExpiredSessions() {
  await pool.query("DELETE FROM sessions WHERE expires_at < NOW()");
}
