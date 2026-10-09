// DigitalRyze website chatbot backend (Vercel serverless function).
// POST /api/chat  { messages: [{role, content}], sessionId, leadSaved, page }
// Returns         { reply, leadSaved, handoff }
// The bot itself lives in lib/bot.js (shared with WhatsApp).

import { respond } from "../lib/bot.js";

const MAX_HISTORY = 40;          // messages kept per request
const MAX_MSG_CHARS = 1500;      // per visitor message
const RATE_LIMIT = 30;           // requests per IP per 10 minutes (best effort)
const hits = new Map();

function cors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || "https://digitalryze.com,https://www.digitalryze.com")
    .split(",").map(s => s.trim());
  const origin = req.headers.origin || "";
  // Always allow the Vercel deployment itself, so the test page works.
  if (req.headers.host) allowed.push(`https://${req.headers.host}`);
  if (allowed.includes(origin) || allowed.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return allowed.includes(origin) || allowed.includes("*");
}

function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter(t => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE_LIMIT;
}

function cleanMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const msgs = raw
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS).trim(), ...(Number.isFinite(m.ts) ? { ts: m.ts } : {}), ...(m.ctx === true ? { ctx: true } : {}) }))
    .filter(m => m.content.length > 0)
    .slice(-MAX_HISTORY);
  // Claude needs the conversation to start with a user turn.
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

export default async function handler(req, res) {
  const originOk = cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!originOk) return res.status(403).json({ error: "Origin not allowed" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    return res.status(429).json({ reply: "You're sending messages quickly. Please wait a few minutes, or call +91 760 044 3625." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const messages = cleanMessages(body.messages);
    if (!messages.length) return res.status(400).json({ error: "No message" });
    const out = await respond({
      messages,
      sessionId: String(body.sessionId || "").slice(0, 64),
      page: String(body.page || "").slice(0, 300),
      leadSaved: Boolean(body.leadSaved),
      host: req.headers.host,
      channel: "web"
    });
    return res.status(200).json(out);
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      reply: "I'm having trouble connecting right now. You can book a call at https://calendly.com/digitalryze/virtual-coffee-with-digitalryze-team or call +91 760 044 3625."
    });
  }
}
