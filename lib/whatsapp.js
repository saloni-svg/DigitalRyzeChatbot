// WhatsApp Cloud API (Meta) helpers.
// Env on Vercel: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET (recommended).
const VERSION = process.env.WHATSAPP_API_VERSION || "v23.0";

export const isWhatsAppSession = id => /^wa_\d+$/.test(String(id || ""));
export const waNumber = id => String(id || "").replace(/^wa_/, "");

// Markdown from the bot -> WhatsApp formatting (**bold** -> *bold*, [text](url) -> text: url).
export function toWhatsAppText(text) {
  return String(text || "")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1: $2")
    .replace(/^#{1,6}\s*/gm, "")
    .trim();
}

async function graph(path, body) {
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error("WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not set on Vercel.");
  const r = await fetch(`https://graph.facebook.com/${VERSION}/${phoneId}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = (d && d.error) || {};
    const err = new Error(e.error_user_msg || e.message || `WhatsApp API ${r.status}`);
    err.code = e.code;
    throw err;
  }
  return d;
}

// Send a text message (split into parts if it is longer than WhatsApp allows).
export async function sendWhatsApp(to, text) {
  const body = toWhatsAppText(text);
  const parts = [];
  for (let rest = body; rest.length; ) {
    if (rest.length <= 3800) { parts.push(rest); break; }
    let cut = rest.lastIndexOf("\n", 3800); if (cut < 1000) cut = 3800;
    parts.push(rest.slice(0, cut)); rest = rest.slice(cut).trim();
  }
  for (const part of parts) {
    await graph("messages", { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: part, preview_url: true } });
  }
}

// Blue ticks + "typing..." while the bot thinks.
export async function markRead(messageId) {
  try {
    await graph("messages", { messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } });
  } catch (err) {
    // Older API versions do not support the typing indicator: fall back to just marking as read.
    try { await graph("messages", { messaging_product: "whatsapp", status: "read", message_id: messageId }); } catch (e) { /* not important */ }
  }
}

// Friendly explanation for common send errors (for example the 24-hour rule).
export function whatsappError(err) {
  if (err && err.code === 131047) return "WhatsApp only allows free-form replies within 24 hours of the customer's last message.";
  if (err && (err.code === 190 || /token/i.test(err.message || ""))) return "The WhatsApp access token is invalid or expired. Update WHATSAPP_TOKEN on Vercel.";
  return "WhatsApp could not deliver the message: " + ((err && err.message) || "unknown error");
}
