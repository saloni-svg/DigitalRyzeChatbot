// POST /api/admin/login
//   { email, password }                      -> { token, user }              sign in
//   { action: "forgot", email, origin }       -> { ok }                       email a one-time reset link (30 minutes)
//   { action: "check_reset", token }          -> { ok, email }                is this link still valid?
//   { action: "reset", token, password }      -> { ok, email }                set the new password
//
// Reset links are random 256-bit tokens; only their SHA-256 hash is stored, they expire after 30 minutes and
// work once. The answer to "forgot" is always the same, so nobody can find out which emails have accounts.
import crypto from "crypto";
import { login, signToken, publicUser, hashPassword } from "../auth.js";
import { supa, enc } from "../db.js";

const RESET_MINUTES = 30, MAX_PER_HOUR = 3;
// The main admin's email: allowed to reset even before a personal account exists for it.
const OWNER_EMAIL = () => String(process.env.OWNER_EMAIL || "salonidigitalryze@gmail.com").trim().toLowerCase();
const sha = t => crypto.createHash("sha256").update(String(t)).digest("hex");
const normEmail = e => String(e || "").trim().toLowerCase().slice(0, 160);
const GENERIC = "If this email belongs to a dashboard account, a reset link is on its way. Check your inbox (and spam) in a minute.";

function dashboardUrl(req, origin) {
  const fromEnv = String(process.env.DASHBOARD_URL || "").trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "").replace(/\/admin$/, "") + "/admin/";
  // Only trust our own hosts for the link.
  const o = String(origin || "");
  if (/^https:\/\/(app\.digitalryze\.com|[a-z0-9-]+\.vercel\.app)$/i.test(o)) return o + "/admin/";
  return `https://${req.headers.host}/admin/`;
}

async function sendEmail(to, subject, body) {
  const url = process.env.LEAD_WEBHOOK_URL;
  if (!url) throw new Error("LEAD_WEBHOOK_URL is not set");
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, redirect: "follow",
    body: JSON.stringify({ secret: process.env.LEAD_WEBHOOK_SECRET || "", type: "followup", to, subject, body, from_name: "DigitalRYZE Dashboard" })
  });
  const text = (await r.text()).trim();
  if (!(r.ok && text === "followup-sent")) throw new Error("Email not sent: " + text.slice(0, 120));
}

async function findReset(db, token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ""))) return null;
  const rows = await db.get(`password_resets?select=*&token_hash=eq.${sha(token)}&used_at=is.null&expires_at=gt.${enc(new Date().toISOString())}`);
  return (rows || [])[0] || null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  const db = supa();

  // ---- 1. Forgot password: email a one-time link ----
  if (body.action === "forgot") {
    const email = normEmail(body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    await new Promise(r => setTimeout(r, 400 + Math.random() * 400));     // same timing whether or not the account exists
    try {
      if (!db) throw new Error("Database not configured");
      const user = ((await db.get(`admin_users?select=id,first_name,email&email=eq.${enc(email)}`).catch(() => [])) || [])[0];
      if (!user && email !== OWNER_EMAIL()) return res.status(200).json({ ok: true, message: GENERIC });
      const hourAgo = new Date(Date.now() - 3600e3).toISOString();
      const recent = (await db.get(`password_resets?select=id&email=eq.${enc(email)}&created_at=gt.${enc(hourAgo)}&limit=${MAX_PER_HOUR + 1}`)) || [];
      if (recent.length >= MAX_PER_HOUR) return res.status(200).json({ ok: true, message: GENERIC });   // quietly limit
      const token = crypto.randomBytes(32).toString("hex");
      await db.insert("password_resets", { email, user_id: user ? String(user.id) : null, token_hash: sha(token),
        expires_at: new Date(Date.now() + RESET_MINUTES * 60e3).toISOString() });
      const link = dashboardUrl(req, body.origin) + "?reset=" + token;
      const hi = user && user.first_name ? `Hi ${user.first_name},` : "Hi,";
      await sendEmail(email, "Reset your DigitalRYZE dashboard password",
        `${hi}\n\nSomeone (hopefully you) asked to reset the password for the DigitalRYZE dashboard account ${email}.\n\n` +
        `Open this link to choose a new password:\n${link}\n\n` +
        `The link works once and expires in ${RESET_MINUTES} minutes.\n\n` +
        `If you didn't ask for this, you can ignore this email. Your password stays the same.\n\nDigitalRYZE Dashboard`);
    } catch (err) {
      console.error("Password reset email failed", err.message);   // never tell the visitor which emails exist
    }
    return res.status(200).json({ ok: true, message: GENERIC });
  }

  // ---- 2. Is this reset link still valid? ----
  if (body.action === "check_reset") {
    const r = db ? await findReset(db, body.token).catch(() => null) : null;
    if (!r) return res.status(400).json({ error: "This reset link has expired or was already used. Ask for a new one." });
    return res.status(200).json({ ok: true, email: r.email });
  }

  // ---- 3. Set the new password ----
  if (body.action === "reset") {
    const pw = String(body.password || "");
    if (pw.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return res.status(400).json({ error: "Use at least one letter and one number." });
    if (!db) return res.status(500).json({ error: "Database not configured" });
    try {
      const r = await findReset(db, body.token);
      if (!r) return res.status(400).json({ error: "This reset link has expired or was already used. Ask for a new one." });
      // Use the link once (and only if nobody used it a moment ago).
      const claimed = await db.patch("password_resets", `id=eq.${r.id}&used_at=is.null`, { used_at: new Date().toISOString() });
      if (!claimed || !claimed.length) return res.status(400).json({ error: "This reset link was already used. Ask for a new one." });
      const hash = hashPassword(pw);
      const existing = ((await db.get(`admin_users?select=id&email=eq.${enc(r.email)}`)) || [])[0];
      if (existing) await db.patch("admin_users", `id=eq.${existing.id}`, { password_hash: hash });
      else if (r.email === OWNER_EMAIL()) await db.insert("admin_users", { email: r.email, first_name: "Main", last_name: "Admin", role: "admin", password_hash: hash });
      else return res.status(400).json({ error: "This account no longer exists." });
      // Any other open links for this email stop working.
      await db.patch("password_resets", `email=eq.${enc(r.email)}&used_at=is.null`, { used_at: new Date().toISOString() }).catch(() => {});
      return res.status(200).json({ ok: true, email: r.email });
    } catch (err) {
      console.error("Password reset failed", err);
      if (/password_resets/i.test(String(err.message))) return res.status(500).json({ error: "Password reset needs a database update: run password-reset.sql in Supabase." });
      return res.status(500).json({ error: "Could not reset the password. Please try again." });
    }
  }

  // ---- Sign in ----
  const user = await login(body.email, body.password);
  if (!user) {
    await new Promise(r => setTimeout(r, 600)); // slow down guessing
    return res.status(401).json({ error: "Wrong email or password." });
  }
  return res.status(200).json({ token: signToken(user), user: publicUser(user) });
}
