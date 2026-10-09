// POST /api/admin/analyze { session?, force? } -> run the Conversation Analyst on waiting chats
import { requireAuth } from "../auth.js";
import { runPending } from "../analyst.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const me = await requireAuth(req, res);
  if (!me) return;
  const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  try {
    const out = await runPending({ limit: 4, session: b.session ? String(b.session).slice(0, 64) : null });
    return res.status(200).json(out);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "The Analyst could not run right now. Has the chat_analysis table been created?" });
  }
}
