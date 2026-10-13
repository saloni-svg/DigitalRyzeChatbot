// Admin side of live chat.
// GET  /api/admin/live                      -> { pending: [...], active: [...] }
// GET  /api/admin/live?session=ID&after=0   -> { status, agent, messages }
// POST /api/admin/live { action: accept | reject | send | end, session, agent, content }
// "send" translates the team member's English reply into the visitor's language before saving it
// (set REPLY_TRANSLATION=off on Vercel to turn this off).
import { supa, enc } from "../db.js";
import { requireAuth } from "../auth.js";
import { toVisitorLanguage } from "../translate.js";
import { isWhatsAppSession, waNumber, sendWhatsApp, whatsappError } from "../whatsapp.js";
import { captureLiveLead, looksLikeContact } from "../livelead.js";

const BOOKING = "https://calendly.com/digitalryze/virtual-coffee-with-digitalryze-team";
// WhatsApp chats: the customer only sees what is sent through WhatsApp, so status changes are sent there too.
async function tellWhatsApp(session, text) {
  if (!isWhatsAppSession(session)) return null;
  try { await sendWhatsApp(waNumber(session), text); return null; }
  catch (err) { console.error("WhatsApp send failed", err); return whatsappError(err); }
}

const WAIT_MINUTES = 15; // requests older than this are hidden
let hasOriginal = null;   // does live_messages have the optional "original" column? (checked once)

// Live messages after a given id, with the English original of translated replies when it is stored.
async function liveMessages(db, session, after) {
  const base = `live_messages?session_id=eq.${enc(session)}&id=gt.${after}&order=id.asc&select=id,role,content,created_at`;
  if (hasOriginal !== false) {
    try { const rows = await db.get(base + ",original"); hasOriginal = true; return rows; }
    catch (err) { if (!/original/.test(err.message)) throw err; hasOriginal = false; }
  }
  return db.get(base);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const me = await requireAuth(req, res); // admins and users can both handle live chats
  if (!me) return;
  const db = supa();
  if (!db) return res.status(500).json({ error: "Database not configured" });

  try {
    if (req.method === "GET") {
      const session = String(req.query.session || "").slice(0, 64);
      if (session) {
        const after = parseInt(req.query.after, 10) || 0;
        const [rows, messages] = await Promise.all([
          db.get(`chats?select=handoff_status,agent_name&session_id=eq.${enc(session)}`),
          liveMessages(db, session, after)
        ]);
        const row = (rows || [])[0] || {};
        return res.status(200).json({ status: row.handoff_status || null, agent: row.agent_name || "", messages: messages || [] });
      }
      const since = new Date(Date.now() - WAIT_MINUTES * 60000).toISOString();
      const cols = "session_id,handoff_status,handoff_at,agent_name,lead_name,lead_email,lead_phone,page,messages";
      const [pending, active] = await Promise.all([
        db.get(`chats?select=${cols}&handoff_status=eq.requested&handoff_at=gt.${enc(since)}&order=handoff_at.asc`),
        db.get(`chats?select=${cols}&handoff_status=eq.accepted&order=handoff_at.desc&limit=20`)
      ]);
      return res.status(200).json({ pending: pending || [], active: active || [] });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      // Older live chats (from before automatic lead capture): find visitors who shared their
      // name, email or phone with a team member but still show as "Anonymous visitor".
      if (body.action === "capture_pending") {
        const chats = (await db.get("chats?select=session_id,agent_name&handoff_status=in.(accepted,ended)&lead_name=is.null&order=updated_at.desc&limit=40").catch(() => [])) || [];
        let checked = 0, saved = 0;
        for (const c of chats) {
          if (checked >= 10) break;                                    // keep each run short
          const msgs = (await db.get(`live_messages?select=content&session_id=eq.${enc(c.session_id)}&role=eq.visitor&limit=100`).catch(() => [])) || [];
          if (!msgs.some(m => looksLikeContact(m.content))) continue;   // nothing shared: no AI call
          checked++;
          const out = await captureLiveLead({ sessionId: c.session_id, host: req.headers.host, agent: c.agent_name || "",
            phoneHint: isWhatsAppSession(c.session_id) ? "+" + waNumber(c.session_id) : "" }).catch(err => { console.error(err); return null; });
          if (out && out.lead) saved++;
        }
        return res.status(200).json({ ok: true, checked, saved });
      }

      const session = String(body.session || "").slice(0, 64);
      const agent = String(body.agent || "DigitalRYZE team").trim().slice(0, 40) || "DigitalRYZE team";
      if (!session) return res.status(400).json({ error: "Missing session" });
      const where = `session_id=eq.${enc(session)}`;

      if (body.action === "accept") {
        const rows = await db.patch("chats", `${where}&handoff_status=eq.requested`, { handoff_status: "accepted", agent_name: agent });
        if (!rows || !rows.length) return res.status(409).json({ error: "This request is no longer waiting. The visitor may have left." });
        await db.insert("live_messages", { session_id: session, role: "system", content: `${agent} from DigitalRYZE joined the chat.` });
        await tellWhatsApp(session, `${agent} from DigitalRYZE has joined the chat. How can I help?`);
        return res.status(200).json({ ok: true });
      }
      if (body.action === "reject") {
        const rows = await db.patch("chats", `${where}&handoff_status=eq.requested`, { handoff_status: "rejected" });
        if (rows && rows.length) await tellWhatsApp(session, `Sorry, our team isn't available right now. We'll reply here as soon as we can, or you can book a call: ${BOOKING}`);
        return res.status(200).json({ ok: true });
      }
      if (body.action === "send") {
        const content = String(body.content || "").trim().slice(0, 2000);
        if (!content) return res.status(400).json({ error: "Empty message" });
        const [rows, liveVisitor] = await Promise.all([
          db.get(`chats?select=handoff_status,messages&${where}`),
          db.get(`live_messages?select=content&${where}&role=eq.visitor&order=id.desc&limit=4`).catch(() => [])
        ]);
        const chat = (rows || [])[0];
        if (!chat || chat.handoff_status !== "accepted") return res.status(409).json({ error: "This chat is not live anymore." });

        // What the visitor has written recently (AI chat first, then live chat), newest last.
        const samples = (chat.messages || []).filter(m => m && m.role === "user").map(m => m.content).slice(-4)
          .concat((liveVisitor || []).map(m => m.content).reverse()).slice(-4);
        let out = { translated: false, text: content };
        try { out = await toVisitorLanguage(content, samples); }
        catch (err) { console.error("Reply translation failed, sending English", err.message); }

        // WhatsApp: deliver first, and only show the message as sent if WhatsApp accepted it.
        const waError = await tellWhatsApp(session, out.text);
        if (waError) return res.status(502).json({ error: waError });

        let msg;
        const row = { session_id: session, role: "agent", content: out.text };
        try {
          // Keep the English original when the optional "original" column exists.
          msg = await db.insert("live_messages", out.translated && hasOriginal !== false ? { ...row, original: content } : row);
        } catch (err) {
          if (!out.translated || !/original/.test(err.message)) throw err;
          hasOriginal = false;
          msg = await db.insert("live_messages", row);
        }
        return res.status(200).json({ ok: true, id: msg?.id, sent: out.text, original: content, translated: out.translated, language: out.language || null });
      }
      if (body.action === "end") {
        const ended = await db.patch("chats", `${where}&handoff_status=eq.accepted`, { handoff_status: "ended" });
        if (!ended || !ended.length) return res.status(200).json({ ok: true }); // already ended
        await db.insert("live_messages", { session_id: session, role: "system", content: `${agent} has left the chat.` });

        // The AI assistant takes over again: tell the visitor clearly, in their language.
        let handback = "I'm the DigitalRYZE AI assistant, and I'll continue helping you from here. What else can I help you with?";
        try {
          const [rows, liveVisitor] = await Promise.all([
            db.get(`chats?select=messages&${where}`),
            db.get(`live_messages?select=content&${where}&role=eq.visitor&order=id.desc&limit=4`).catch(() => [])
          ]);
          const samples = (((rows || [])[0] || {}).messages || []).filter(m => m && m.role === "user").map(m => m.content).slice(-4)
            .concat((liveVisitor || []).map(m => m.content).reverse()).slice(-4);
          const out = await toVisitorLanguage(handback, samples);
          handback = out.text;
        } catch (err) { console.error("Handback translation failed, using English", err.message); }
        await db.insert("live_messages", { session_id: session, role: "assistant", content: handback });

        // WhatsApp: copy the live conversation into the chat history (marked ctx, not shown twice) so the AI can continue it.
        if (isWhatsAppSession(session)) {
          try {
            const [rows, live] = await Promise.all([
              db.get(`chats?select=messages&${where}`),
              db.get(`live_messages?select=role,content,created_at&${where}&role=in.(visitor,agent)&order=id.asc&limit=200`)
            ]);
            const history = (((rows || [])[0] || {}).messages || []);
            const lastTs = history.reduce((t, m) => Math.max(t, Number(m && m.ts) || 0), 0);
            const added = (live || []).filter(m => new Date(m.created_at).getTime() > lastTs).map(m => ({
              role: m.role === "visitor" ? "user" : "assistant", ctx: true, ts: new Date(m.created_at).getTime(),
              content: (m.role === "agent" ? `[${agent} from DigitalRyze said]: ` : "") + m.content
            }));
            added.push({ role: "assistant", content: handback, ts: Date.now() + 1, ctx: true });
            await db.patch("chats", where, { messages: history.concat(added).slice(-80), updated_at: new Date().toISOString() });
          } catch (err) { console.error("Copying live chat into history failed", err.message); }
        }

        await tellWhatsApp(session, `${agent} has left the chat.\n\n${handback}`);
        // Save the visitor as a lead if they shared their name, email or phone during the live chat.
        await captureLiveLead({ sessionId: session, host: req.headers.host, agent,
          phoneHint: isWhatsAppSession(session) ? "+" + waNumber(session) : "" }).catch(err => console.error("Live lead capture failed", err));
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: "Unknown action" });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
