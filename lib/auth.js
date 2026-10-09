// Dashboard sign-in: user accounts in Supabase, signed session tokens, and a master password.
import crypto from "crypto";
import { supa, enc } from "./db.js";

const TOKEN_HOURS = 12;
const secret = () => process.env.SESSION_SECRET || ("dr-session:" + (process.env.ADMIN_PASSWORD || ""));
const b64 = buf => Buffer.from(buf).toString("base64url");

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}
export function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 64);
  const real = Buffer.from(hash, "hex");
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}
export function sameText(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function signToken(user) {
  const payload = { uid: user.id, email: user.email, role: user.role, exp: Date.now() + TOKEN_HOURS * 3600e3 };
  const body = b64(JSON.stringify(payload));
  const sig = b64(crypto.createHmac("sha256", secret()).update(body).digest());
  return `${body}.${sig}`;
}
function readToken(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const good = b64(crypto.createHmac("sha256", secret()).update(body).digest());
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

export function publicUser(u) {
  return {
    id: u.id, first_name: u.first_name || "", last_name: u.last_name || "", email: u.email, role: u.role,
    phone: u.phone || "", birthday: u.birthday || "", job_title: u.job_title || "", created_at: u.created_at || null,
    owner: !!u.owner, has_password: !!(u.owner || u.password_hash), avatar: u.avatar || "",
    can_calendar: u.owner ? true : u.can_calendar !== false
  };
}
function ownerUser(email) {
  return { id: "owner", first_name: "Main", last_name: "Admin", email: String(email || "").toLowerCase(), role: "admin", owner: true };
}

// Sign in with email + password. The ADMIN_PASSWORD works as a master login for any email.
export async function login(email, password) {
  email = String(email || "").trim().toLowerCase();
  if (!email || !password) return null;
  const db = supa();
  let u = null;
  if (db) {
    const rows = await db.get(`admin_users?select=*&email=eq.${enc(email)}`).catch(() => []);
    u = (rows || [])[0] || null;
    if (u && checkPassword(password, u.password_hash)) return u;
  }
  if (process.env.ADMIN_PASSWORD && sameText(password, process.env.ADMIN_PASSWORD)) {
    // The master password opens the saved account for this email (with its details), or a temporary admin login.
    return u || ownerUser(email);
  }
  return null;
}

// Returns the signed-in user, or sends 401/403 and returns null.
export async function requireAuth(req, res, { admin = false } = {}) {
  const p = readToken(req.headers["x-admin-key"]);
  if (!p) { res.status(401).json({ error: "Please sign in again." }); return null; }
  let user;
  if (p.uid === "owner") user = ownerUser(p.email);
  else {
    const db = supa();
    const rows = db ? await db.get(`admin_users?select=*&id=eq.${enc(p.uid)}`).catch(() => []) : [];
    user = (rows || [])[0];
    if (!user) { res.status(401).json({ error: "This account no longer exists." }); return null; }
  }
  if (admin && user.role !== "admin") { res.status(403).json({ error: "Only admins can do this." }); return null; }
  return user;
}
