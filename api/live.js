// Visitor side of a live chat with a team member.
// GET  /api/live?session=ID&after=0          -> { status, agent, messages }
// POST /api/live { session, action: "send", content } | { session, action: "timeout" }
import { supa, enc, cors } from "../lib/db.js";
import { looksLikeContact, captureLiveLead } from "../lib/livelead.js";
import { inBackground } from "../lib/background.js";

export default async function handler(req, res) {
  const ok = cors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!ok) return res.status(403).json({ error: "Origin not allowed" });
  res.setHeader("Cache-Control", "no-store");

  const db = supa();
  if (!db) return res.status(500).json({ error: "Database not configured" });

  try {
    if (req.method === "GET") {
      const session = String(req.query.session || "").slice(0, 64);
      const after = parseInt(req.query.after, 10) || 0;
      if (!session) return res.status(400).json({ error: "Missing session" });
      const [rows, messages] = await Promise.all([
        db.get(`chats?select=handoff_status,agent_name&session_id=eq.${enc(session)}`),
        db.get(`live_messages?select=id,role,content,created_at&session_id=eq.${enc(session)}&id=gt.${after}&order=id.asc`)
      ]);
      const row = (rows || [])[0] || {};
      return res.status(200).json({ status: row.handoff_status || null, agent: row.agent_name || "", messages: messages || [] });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const session = String(body.session || "").slice(0, 64);
      if (!session) return res.status(400).json({ error: "Missing session" });

      if (body.action === "timeout") {
        await db.patch("chats", `session_id=eq.${enc(session)}&handoff_status=eq.requested`, { handoff_status: "missed" });
        return res.status(200).json({ ok: true });
      }

      if (body.action === "send") {
        const content = String(body.content || "").trim().slice(0, 1500);
        if (!content) return res.status(400).json({ error: "Empty message" });
        const rows = await db.get(`chats?select=handoff_status,agent_name&session_id=eq.${enc(session)}`);
        const row = (rows || [])[0] || {};
        if (row.handoff_status !== "accepted") return res.status(409).json({ status: row.handoff_status });
        const msg = await db.insert("live_messages", { session_id: session, role: "visitor", content });
        await db.patch("chats", `session_id=eq.${enc(session)}`, { updated_at: new Date().toISOString() });
        // The visitor shared a name, email or phone with the team: save them as a lead.
        if (looksLikeContact(content)) await inBackground(captureLiveLead({ sessionId: session, host: req.headers.host, agent: row.agent_name || "" }));
        return res.status(200).json({ ok: true, id: msg?.id });
      }
      return res.status(400).json({ error: "Unknown action" });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
