// WhatsApp chatbot (Meta WhatsApp Cloud API webhook).
// GET  /api/whatsapp  -> Meta's webhook verification (hub.challenge)
// POST /api/whatsapp  -> incoming messages: the same bot as the website replies on WhatsApp.
// Conversations are saved in Supabase as session "wa_<number>" so they appear in the dashboard,
// and a team member can take over the chat there (live handoff), replying through WhatsApp.
import crypto from "crypto";
import { respond } from "../lib/bot.js";
import { supa, enc } from "../lib/db.js";
import { sendWhatsApp, markRead } from "../lib/whatsapp.js";
import { looksLikeContact, captureLiveLead } from "../lib/livelead.js";

export const config = { maxDuration: 60 };

const MAX_HISTORY = 40, MAX_MSG_CHARS = 1500;
const seen = new Set();        // message ids handled by this server instance (Meta sometimes delivers twice)
const queues = new Map();      // one message at a time per customer, in order

async function rawBody(req) {
  if (typeof req.body === "string") return req.body;
  const chunks = [];
  try { for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); } catch (e) { /* stream already read */ }
  if (chunks.length) return Buffer.concat(chunks).toString("utf8");
  return req.body ? JSON.stringify(req.body) : "";
}

function signatureOk(req, raw) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true; // not configured yet: accept (set WHATSAPP_APP_SECRET to switch checking on)
  const sig = String(req.headers["x-hub-signature-256"] || "");
  const good = "sha256=" + crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

function textOf(msg) {
  if (msg.type === "text") return msg.text && msg.text.body;
  if (msg.type === "button") return msg.button && msg.button.text;
  if (msg.type === "interactive") {
    const i = msg.interactive || {};
    return (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title);
  }
  return null;
}

async function handleMessage(msg, contactName, host) {
  const db = supa();
  const number = String(msg.from || "").replace(/\D/g, "");
  if (!number || !db) return;
  const sessionId = "wa_" + number;
  const text = textOf(msg);
  markRead(msg.id);

  if (!text) {
    await sendWhatsApp(number, "Thanks! I can only read text messages for now. Please type your question and I'll help right away.");
    return;
  }
  const content = String(text).trim().slice(0, MAX_MSG_CHARS);
  const ts = Number(msg.timestamp) ? Number(msg.timestamp) * 1000 : Date.now();

  const row = ((await db.get(`chats?select=messages,lead_saved,handoff_status,agent_name&session_id=eq.${enc(sessionId)}`).catch(() => [])) || [])[0] || {};
  const history = Array.isArray(row.messages) ? row.messages : [];
  if (history.some(m => m && m.wid === msg.id)) return; // already answered (duplicate delivery)

  // A team member has taken over: pass the message to the live chat instead of the bot.
  if (row.handoff_status === "accepted") {
    await db.insert("live_messages", { session_id: sessionId, role: "visitor", content });
    await db.patch("chats", `session_id=eq.${enc(sessionId)}`, { updated_at: new Date().toISOString() });
    // Shared a name or email with the team member: save as a lead (their WhatsApp number is already known).
    if (looksLikeContact(content)) {
      await captureLiveLead({ sessionId, host, phoneHint: "+" + number, agent: row.agent_name || "" })
        .catch(err => console.error("Live lead capture failed", err));
    }
    return;
  }

  const messages = history
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .concat([{ role: "user", content, ts, wid: msg.id }])
    .slice(-MAX_HISTORY);
  while (messages.length && messages[0].role !== "user") messages.shift();

  let reply;
  try {
    const out = await respond({
      messages, sessionId, page: "WhatsApp", leadSaved: row.lead_saved, host, channel: "whatsapp",
      contact: { phone: "+" + number, name: contactName || "" }
    });
    reply = out.reply;
  } catch (err) {
    console.error("WhatsApp bot failed", err);
    reply = "Sorry, I'm having trouble right now. You can book a call here: https://calendly.com/digitalryze/virtual-coffee-with-digitalryze-team or call +91 760 044 3625.";
  }
  await sendWhatsApp(number, reply);
}

function enqueue(number, job) {
  const prev = queues.get(number) || Promise.resolve();
  const next = prev.then(job, job).catch(err => console.error("WhatsApp message failed", err));
  queues.set(number, next);
  next.finally(() => { if (queues.get(number) === next) queues.delete(number); });
  return next;
}

export default async function handler(req, res) {
  // Webhook verification when you click "Verify and save" in Meta.
  if (req.method === "GET") {
    const q = req.query || {};
    const expected = process.env.WHATSAPP_VERIFY_TOKEN;
    if (expected && q["hub.mode"] === "subscribe" && q["hub.verify_token"] === expected) {
      res.setHeader("Content-Type", "text/plain");
      return res.status(200).send(String(q["hub.challenge"] || ""));
    }
    return res.status(403).send("Forbidden");
  }
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const raw = await rawBody(req);
  if (!signatureOk(req, raw)) return res.status(401).send("Bad signature");
  let body = {};
  try { body = raw ? JSON.parse(raw) : (req.body || {}); } catch { return res.status(400).send("Bad JSON"); }

  const jobs = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = {};
      (v.contacts || []).forEach(c => { names[c.wa_id] = c.profile && c.profile.name; });
      for (const msg of v.messages || []) {        // delivery/read receipts (v.statuses) are ignored
        if (!msg.id || seen.has(msg.id)) continue;
        seen.add(msg.id); if (seen.size > 2000) seen.clear();
        jobs.push(enqueue(msg.from, () => handleMessage(msg, names[msg.from], req.headers.host)));
      }
    }
  }

  // Reply to Meta straight away (it retries slow webhooks), and keep working in the background.
  const all = Promise.allSettled(jobs);
  let background = false;
  try {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(all); background = true;
  } catch { /* @vercel/functions not installed */ }
  if (!background) await all; // finish before the function ends
  return res.status(200).send("OK");
}
