// Admin: AI highlights + summary for one conversation (cached in Supabase).
// POST /api/admin/summary { key, messages: [{role, content}], force }
import { supa, enc } from "../db.js";
import { requireAuth } from "../auth.js";

const MODEL = process.env.SUMMARY_MODEL || "claude-haiku-4-5-20251001";


const INSTRUCTIONS = `You summarise website chat conversations for the DigitalRyze sales team.
Return ONLY a JSON object, no markdown, no code fences, in this exact shape:
{"highlights": ["...", "..."], "summary": "..."}

highlights: 3 to 8 short keyword phrases (1 to 4 words each) capturing the most important points: services asked about, the visitor's business or industry, budget, location, problems, objections, and whether they asked for a human or booked a call. No full sentences.
summary: 2 to 4 plain sentences covering who the visitor is (if known), what they wanted, what was offered or agreed, and the next step. Only state facts from the chat. Do not invent details.
Never use em dashes or en dashes. Write in English.`;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const me = await requireAuth(req, res);
  if (!me) return;

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const key = String(body.key || "").slice(0, 100);
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter(m => m && typeof m.content === "string" && m.content.trim())
      .slice(-80);
    if (!key || !messages.length) return res.status(400).json({ error: "Nothing to summarise." });

    const db = supa();
    const force = body.force && me.role === "admin";
    if (db && !force) {
      const rows = await db.get(`chat_summaries?select=*&key=eq.${enc(key)}`).catch(() => []);
      const hit = (rows || [])[0];
      if (hit && hit.message_count === messages.length) {
        return res.status(200).json({ highlights: hit.highlights || [], summary: hit.summary || "", cached: true });
      }
    }

    const label = { user: "Visitor", visitor: "Visitor", assistant: "AI assistant", agent: "Team member", system: "Note" };
    const transcript = messages.map(m => `${label[m.role] || "Note"}: ${m.content.slice(0, 1500)}`).join("\n").slice(-24000);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        ...(process.env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID.trim() } : {})
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system: INSTRUCTIONS,
        messages: [{ role: "user", content: `Conversation:\n${transcript}` }]
      })
    });
    if (!r.ok) throw new Error(`Claude API ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    const json = JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim().match(/\{[\s\S]*\}/)[0]);
    const clean = s => String(s || "").replace(/\s*[\u2013\u2014]\s*/g, ", ").trim();
    const highlights = (Array.isArray(json.highlights) ? json.highlights : []).map(clean).filter(Boolean).slice(0, 8);
    const summary = clean(json.summary);

    if (db) {
      await db.upsert("chat_summaries", { key, highlights, summary, message_count: messages.length, created_at: new Date().toISOString() }, "key")
        .catch(err => console.error("Summary cache failed (has chat_summaries been created?)", err));
    }
    return res.status(200).json({ highlights, summary, cached: false });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not create a summary right now. Try again in a moment." });
  }
}
