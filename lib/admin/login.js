// POST /api/admin/login { email, password } -> { token, user }
import { login, signToken, publicUser } from "../auth.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  const user = await login(body.email, body.password);
  if (!user) {
    await new Promise(r => setTimeout(r, 600)); // slow down guessing
    return res.status(401).json({ error: "Wrong email or password." });
  }
  return res.status(200).json({ token: signToken(user), user: publicUser(user) });
}
