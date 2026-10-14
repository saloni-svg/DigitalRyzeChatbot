// One serverless function for every /api/admin/... endpoint (keeps the project within Vercel Hobby's 12-function limit).
import actions from "../../lib/admin/actions.js";
import analyze from "../../lib/admin/analyze.js";
import calendar from "../../lib/admin/calendar.js";
import chats from "../../lib/admin/chats.js";
import followups from "../../lib/admin/followups.js";
import insights from "../../lib/admin/insights.js";
import live from "../../lib/admin/live.js";
import login from "../../lib/admin/login.js";
import ml from "../../lib/admin/ml.js";
import outcomes from "../../lib/admin/outcomes.js";
import push from "../../lib/admin/push.js";
import scoring from "../../lib/admin/scoring.js";
import summary from "../../lib/admin/summary.js";
import team from "../../lib/admin/team.js";
import users from "../../lib/admin/users.js";

const routes = { actions, analyze, calendar, chats, followups, insights, live, login, ml, outcomes, push, scoring, summary, team, users };

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const name = String((req.query && req.query.route) || "").replace(/\.js$/, "");
  const fn = Object.prototype.hasOwnProperty.call(routes, name) ? routes[name] : null;
  if (!fn) return res.status(404).json({ error: "Not found" });
  return fn(req, res);
}
