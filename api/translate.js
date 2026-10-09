// POST /api/translate { text, target? } -> { translation, detected_language, already_target, target }
// target is a language code: "en" (default) or e.g. "fr", "hi", "ar".
import { translate } from "../lib/translate.js";

const LIMIT = 60;                 // requests per IP per 10 minutes (best effort, per server instance)
const hits = new Map();
const cache = new Map();
const CACHE_MAX = 500;

function limited(ip) {
  const now = Date.now(), windowMs = 10 * 60 * 1000;
  const recent = (hits.get(ip) || []).filter(t => now - t < windowMs);
  recent.push(now); hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > LIMIT;
}

export default async function handler(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || "https://digitalryze.com,https://www.digitalryze.com").split(",").map(s => s.trim());
  if (req.headers.host) allowed.push("https://" + req.headers.host);
  const origin = req.headers.origin || "";
  const originOk = allowed.includes(origin) || allowed.includes("*");
  if (originOk) res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!originOk) return res.status(403).json({ error: "Origin not allowed" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "Translation is not configured" });

  const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  if (limited(ip)) return res.status(429).json({ error: "Too many translation requests. Try again in a few minutes." });

  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
  const text = String(body.text || "").trim();
  if (!text || text.length > 4000) return res.status(400).json({ error: "Text must be between 1 and 4000 characters" });
  const target = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(body.target || "")) ? String(body.target) : "en";

  const key = target + "\n" + text;
  if (cache.has(key)) return res.status(200).json(cache.get(key));
  try {
    const result = await translate(text, target);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return res.status(200).json(result);
  } catch (e) {
    console.error("Translate failed", e);
    return res.status(502).json({ error: "Translation failed. Try again." });
  }
}
