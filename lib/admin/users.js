// Dashboard accounts.
// GET  /api/admin/users                      -> { me, users (admins only) }
// POST /api/admin/users { action: "create" | "update" | "delete", ... }   (admins only)
import { supa, enc } from "../db.js";
import { requireAuth, hashPassword, checkPassword, sameText, publicUser, signToken } from "../auth.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const str = (v, n = 120) => String(v == null ? "" : v).trim().slice(0, n);

function fields(b) {
  const out = {};
  if (b.first_name !== undefined) out.first_name = str(b.first_name, 60);
  if (b.last_name !== undefined) out.last_name = str(b.last_name, 60);
  if (b.email !== undefined) out.email = str(b.email, 160).toLowerCase();
  if (b.phone !== undefined) out.phone = str(b.phone, 40) || null;
  if (b.birthday !== undefined) out.birthday = /^\d{4}-\d{2}-\d{2}$/.test(b.birthday) ? b.birthday : null;
  if (b.job_title !== undefined) out.job_title = str(b.job_title, 80) || null;
  if (b.role !== undefined) out.role = b.role === "admin" ? "admin" : "user";
  // Calendar access: true = show the Calendar page, false = hide it (set by admins).
  if (b.can_calendar !== undefined) out.can_calendar = !(b.can_calendar === false || b.can_calendar === "false");
  if (b.avatar !== undefined) {
    const v = String(b.avatar || "");
    // small square image, resized in the browser before upload; empty string removes it
    out.avatar = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < 300000 ? v : null;
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const db = supa();
  if (!db) return res.status(500).json({ error: "Database not configured" });

  if (req.method === "GET") {
    const me = await requireAuth(req, res);
    if (!me) return;
    let users = [];
    if (me.role === "admin") {
      users = (await db.get("admin_users?select=*&order=created_at.asc").catch(() => [])) || [];
    }
    return res.status(200).json({ me: publicUser(me), users: users.map(publicUser) });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  // Everyone can edit their own information. Managing other people needs an admin.
  const me = await requireAuth(req, res, { admin: b.action !== "self" });
  if (!me) return;

  try {
    if (b.action === "create") {
      const f = fields(b);
      if (!f.first_name || !f.last_name || !f.email || !b.password) return res.status(400).json({ error: "First name, last name, email and password are required." });
      if (!EMAIL.test(f.email)) return res.status(400).json({ error: "Please enter a valid email address." });
      if (String(b.password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
      const exists = await db.get(`admin_users?select=id&email=eq.${enc(f.email)}`);
      if (exists && exists.length) return res.status(409).json({ error: "A user with this email already exists." });
      const row = await db.insert("admin_users", { ...f, role: f.role || "user", password_hash: hashPassword(b.password) });
      return res.status(200).json({ user: publicUser(row) });
    }

    // An admin edits their own information. A master-password login becomes a real admin account here.
    if (b.action === "self") {
      const f = fields(b);
      delete f.role;
      delete f.can_calendar; // only an admin can change someone's calendar access
      if (!f.first_name || !f.last_name || !f.email) return res.status(400).json({ error: "First name, last name and email are required." });
      if (!EMAIL.test(f.email)) return res.status(400).json({ error: "Please enter a valid email address." });
      if (b.password && String(b.password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
      // Changing your own password needs your current password (or the master password).
      if (b.password && !me.owner) {
        const cur = String(b.current_password || "");
        const ok = cur && (checkPassword(cur, me.password_hash) || (process.env.ADMIN_PASSWORD && sameText(cur, process.env.ADMIN_PASSWORD)));
        if (!ok) return res.status(400).json({ error: "Your current password is incorrect." });
      }
      if (b.password) f.password_hash = hashPassword(b.password);

      if (me.owner) {
        const existing = (await db.get(`admin_users?select=*&email=eq.${enc(f.email)}`)) || [];
        let row;
        if (existing.length) {
          const rows = await db.patch("admin_users", `id=eq.${existing[0].id}`, { ...f, role: "admin" });
          row = rows[0];
        } else {
          // No new password given: keep signing in with the current (master) password.
          if (!f.password_hash) f.password_hash = hashPassword(process.env.ADMIN_PASSWORD || "");
          row = await db.insert("admin_users", { ...f, role: "admin" });
        }
        return res.status(200).json({ user: publicUser(row), token: signToken(row) });
      }

      const clash = await db.get(`admin_users?select=id&email=eq.${enc(f.email)}&id=neq.${me.id}`);
      if (clash && clash.length) return res.status(409).json({ error: "Another user already uses this email." });
      const rows = await db.patch("admin_users", `id=eq.${me.id}`, f);
      return res.status(200).json({ user: publicUser(rows[0]), token: signToken(rows[0]) });
    }

    if (b.action === "update") {
      const id = parseInt(b.id, 10);
      if (!id) return res.status(400).json({ error: "Missing user." });
      const f = fields(b);
      if (f.email !== undefined && !EMAIL.test(f.email)) return res.status(400).json({ error: "Please enter a valid email address." });
      if (f.first_name === "" || f.last_name === "") return res.status(400).json({ error: "First and last name are required." });
      if (f.email) {
        const exists = await db.get(`admin_users?select=id&email=eq.${enc(f.email)}&id=neq.${id}`);
        if (exists && exists.length) return res.status(409).json({ error: "Another user already uses this email." });
      }
      if (b.password) {
        if (String(b.password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
        f.password_hash = hashPassword(b.password);
      } else {
        const cur = await db.get(`admin_users?select=password_hash&id=eq.${id}`);
        if (cur && cur[0] && !cur[0].password_hash) return res.status(400).json({ error: "This user has no password yet. Please set one so they can sign in." });
      }
      const rows = await db.patch("admin_users", `id=eq.${id}`, f);
      if (!rows || !rows.length) return res.status(404).json({ error: "User not found." });
      return res.status(200).json({ user: publicUser(rows[0]) });
    }

    if (b.action === "delete") {
      const id = parseInt(b.id, 10);
      if (!id) return res.status(400).json({ error: "Missing user." });
      if (String(me.id) === String(id)) return res.status(400).json({ error: "You can't remove your own account." });
      await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/admin_users?id=eq.${id}`, {
        method: "DELETE",
        headers: { apikey: process.env.SUPABASE_SERVICE_KEY, ...(process.env.SUPABASE_SERVICE_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` } : {}) }
      });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error(err);
    if (/can_calendar/.test(String(err && err.message))) {
      return res.status(500).json({ error: "Calendar access needs one new column. Run calendar-access.sql in the Supabase SQL Editor, then try again." });
    }
    return res.status(500).json({ error: "Server error" });
  }
}
