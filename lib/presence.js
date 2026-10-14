// "Who's on this chat right now?" — team members viewing or typing in a chat, and the visitor typing.
// One row per (chat, person) in chat_presence, refreshed every few seconds while the chat is open.
import { enc } from "./db.js";

export const VIEW_MS = 20000;   // seen in the last 20 s = viewing
export const TYPE_MS = 7000;    // typed in the last 7 s = typing

export async function touch(db, { session_id, user_id, name, typing, left }) {
  const now = new Date().toISOString();
  const row = { session_id, user_id: String(user_id), name: String(name || "").slice(0, 60),
    updated_at: left ? "1970-01-01T00:00:00Z" : now };
  if (typing === true) row.typing_at = now;
  if (typing === false || left) row.typing_at = null;
  await db.upsert("chat_presence", row, "session_id,user_id");
}

const fresh = (iso, ms) => iso && Date.now() - new Date(iso).getTime() < ms;

// Everyone on one chat (except `exceptId`): [{ name, typing }], plus whether the visitor is typing.
export async function presenceOf(db, session, exceptId) {
  const since = new Date(Date.now() - VIEW_MS).toISOString();
  const rows = (await db.get(`chat_presence?select=user_id,name,typing_at,updated_at&session_id=eq.${enc(session)}&updated_at=gt.${enc(since)}`).catch(() => [])) || [];
  return {
    team: rows.filter(r => r.user_id !== "visitor" && r.user_id !== String(exceptId))
              .map(r => ({ name: r.name, typing: !!fresh(r.typing_at, TYPE_MS) })),
    visitor_typing: rows.some(r => r.user_id === "visitor" && fresh(r.typing_at, TYPE_MS))
  };
}

// For the chat list: { session_id: ["Zafar", …] } — team members viewing each chat (except `exceptId`).
export async function viewersByChat(db, exceptId) {
  const since = new Date(Date.now() - VIEW_MS).toISOString();
  const rows = (await db.get(`chat_presence?select=session_id,user_id,name&updated_at=gt.${enc(since)}&user_id=neq.visitor&limit=500`).catch(() => [])) || [];
  const map = {};
  rows.forEach(r => { if (r.user_id !== String(exceptId)) (map[r.session_id] = map[r.session_id] || []).push(String(r.name || "").split(" ")[0]); });
  return map;
}

// For the visitor: the first name of a team member typing right now, or "".
export async function agentTyping(db, session) {
  const since = new Date(Date.now() - TYPE_MS).toISOString();
  const rows = (await db.get(`chat_presence?select=name&session_id=eq.${enc(session)}&user_id=neq.visitor&typing_at=gt.${enc(since)}&limit=1`).catch(() => [])) || [];
  return rows.length ? String(rows[0].name || "").split(" ")[0] : "";
}
