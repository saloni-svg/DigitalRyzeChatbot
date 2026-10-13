/*!
 * DigitalRYZE website chat widget
 * Embed: <script src="https://YOUR-PROJECT.vercel.app/widget.js" defer></script>
 * Optional attributes: data-color="#2F5BFF" data-api="https://.../api/chat"
 */
(function () {
  if (window.__drChatLoaded) return;
  window.__drChatLoaded = true;

  var script = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var base = script ? new URL(script.src).origin : "";
  var API = (script && script.getAttribute("data-api")) || base + "/api/chat";
  var LIVE_API = API.replace(/\/api\/chat$/, "/api/live");
  var WAIT_MS = 120000; // how long a visitor waits for a team member
  var ACCENT = (script && script.getAttribute("data-color")) || "#2F5BFF";
  var BOOK_URL = "https://calendly.com/digitalryze/virtual-coffee-with-digitalryze-team";
  var STORE = "dr-chat-v1";
  // Team members reply in English. Visitors whose browser uses another language can translate those replies.
  var VISITOR_LANG = String(navigator.language || "en").split("-")[0].toLowerCase();
  var LANG_NAME = (function () {
    try { var n = new Intl.DisplayNames([VISITOR_LANG], { type: "language" }).of(VISITOR_LANG); return n.charAt(0).toUpperCase() + n.slice(1); }
    catch (e) { return VISITOR_LANG; }
  })();

  var GREETING = "Hi, I'm the DigitalRYZE assistant. Tell me what you're trying to improve (leads, ad costs, Google visibility, your website) and I'll point you in the right direction.";
  var CHIPS = [
    "My ad costs are too high",
    "I need more leads",
    "White label for my agency",
    "Book a strategy call",
    "Other"
  ];

  // ---------- state ----------
  function newId() { return "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36); }
  function fresh(open) { return { sessionId: newId(), messages: [], leadSaved: false, open: !!open, handoff: null, handoffAt: 0, live: [], liveAfter: 0, agent: "" }; }
  var state = load() || fresh(false);
  state.live = state.live || []; state.liveAfter = state.liveAfter || 0;
  var busy = false, pollTimer = null;

  function load() {
    try { return JSON.parse(sessionStorage.getItem(STORE)); } catch (e) { return null; }
  }
  function save() {
    try { sessionStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {}
  }

  // ---------- DOM ----------
  var host = document.createElement("div");
  host.id = "dr-chat-root";
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });

  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:Inter,"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif}' +
    '.wrap{--accent:' + ACCENT + ';--ink:#14213D;--muted:#5B6478;--mist:#F2F4F8;--line:#E3E7EF;--paper:#FFFFFF;' +
      'position:fixed;right:20px;bottom:20px;z-index:2147483000;color:var(--ink)}' +
    '.launch{display:flex;align-items:center;gap:10px;height:52px;padding:0 20px 0 14px;border:0;border-radius:26px;' +
      'background:var(--ink);color:#fff;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px rgba(20,33,61,.28)}' +
    '.launch:hover{background:#1d2d52}' +
    '.mark{width:28px;height:28px;border-radius:50%;background:var(--accent);display:grid;place-items:center}' +
    '.panel{position:absolute;right:0;bottom:66px;width:380px;height:min(620px,calc(100vh - 110px));background:var(--paper);' +
      'border-radius:18px;box-shadow:0 18px 50px rgba(20,33,61,.25);display:none;flex-direction:column;overflow:hidden;border:1px solid var(--line)}' +
    '.wrap.open .panel{display:flex}' +
    '.head{background:var(--ink);color:#fff;padding:16px 16px 14px;display:flex;align-items:flex-start;gap:12px}' +
    '.head h2{margin:0;font-size:16px;font-weight:700;line-height:1.3;white-space:nowrap}' +
    '.head p{margin:3px 0 0;font-size:12.5px;color:#C7CFE0;line-height:1.4}' +
    '.head .t{flex:1;min-width:0}' +
    '.x{background:transparent;border:0;color:#fff;width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:20px;line-height:1}' +
    '.new{display:inline-flex;align-items:center;gap:5px;height:32px;padding:0 10px;border:1px solid rgba(255,255,255,.22);background:transparent;' +
      'color:#fff;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:600;white-space:nowrap}' +
    '.new:hover{background:rgba(255,255,255,.12)}' +
    '.new[hidden]{display:none}' +
    '.x:hover{background:rgba(255,255,255,.12)}' +
    '.book{display:block;margin:0;padding:10px 16px;background:var(--mist);border-bottom:1px solid var(--line);font-size:13.5px;' +
      'color:var(--ink);text-decoration:none;font-weight:600}' +
    '.book span{color:var(--accent)}' +
    '.book:hover{background:#E9EDF5}' +
    '.log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;background:var(--paper)}' +
    '.msg{max-width:85%;padding:10px 13px;border-radius:14px;font-size:14.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}' +
    '.bot{align-self:flex-start;background:var(--mist);border-bottom-left-radius:4px}' +
    '.me{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:4px}' +
    '.msg a{color:inherit;text-decoration:underline;text-underline-offset:2px}' +
    '.transbtn{align-self:flex-start;border:0;background:none;color:var(--accent);padding:2px 4px;font-size:11px;cursor:pointer}' +
    '.translation{font-size:12.5px;color:var(--muted);background:#F7F8FB;border-left:2px solid var(--accent);padding:6px 8px;white-space:pre-wrap}' +
    '.bot a{color:var(--accent);font-weight:600}' +
    '.chips{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 12px}' +
    '.chip{border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:16px;padding:7px 12px;font-size:13px;cursor:pointer}' +
    '.chip:hover{border-color:var(--accent);color:var(--accent)}' +
    '.typing{align-self:flex-start;background:var(--mist);border-radius:14px;padding:12px 14px;display:flex;gap:4px}' +
    '.typing i{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:b 1.2s infinite}' +
    '.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}' +
    '@keyframes b{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}' +
    '@media (prefers-reduced-motion:reduce){.typing i{animation:none;opacity:.6}}' +
    '.form{display:flex;gap:8px;padding:12px;border-top:1px solid var(--line);background:#fff}' +
    '.form textarea{flex:1;resize:none;border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-size:14.5px;' +
      'line-height:1.4;max-height:110px;color:var(--ink);outline:none}' +
    '.form textarea:focus{border-color:var(--accent)}' +
    '.send{width:44px;border:0;border-radius:12px;background:var(--accent);color:#fff;cursor:pointer;display:grid;place-items:center}' +
    '.send:disabled{opacity:.45;cursor:default}' +
    '.foot{font-size:11px;color:var(--muted);text-align:center;padding:0 12px 10px;background:#fff}' +
    '.sys{align-self:center;max-width:90%;font-size:12px;color:var(--muted);background:#F4F5F8;padding:5px 12px;border-radius:999px;text-align:center}' +
    '.agentwrap{align-self:flex-start;max-width:85%;display:flex;flex-direction:column;gap:3px}' +
    '.agentname{font-size:11.5px;font-weight:700;color:#0E8A5F;padding-left:4px}' +
    '.agent{background:#E7F6EF;border-bottom-left-radius:4px;max-width:100%}' +
    '.agent a{color:#0E8A5F;font-weight:600}' +
    '.wait{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 16px 12px;padding:10px 12px;border-radius:12px;' +
      'background:#FFF7E8;color:#7A4B00;font-size:13px}' +
    '.wait button{border:0;background:none;color:#7A4B00;font-weight:700;text-decoration:underline;cursor:pointer;font-size:12.5px;padding:0;white-space:nowrap}' +
    '.dot{width:8px;height:8px;border-radius:50%;background:#F5A524;flex:none;animation:pulse 1.4s infinite}' +
    '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}' +
    '.live{display:flex;align-items:center;gap:8px;margin:0 16px 12px;padding:8px 12px;border-radius:12px;background:#E7F6EF;color:#0E6B4A;font-size:13px;font-weight:600}' +
    '.live .dot{background:#0E8A5F}' +
    'button:focus-visible,a:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
    '@media (max-width:480px){' +
      '.wrap{right:14px;bottom:14px}' +
      '.launch .lbl{display:none}.launch{padding:0 12px;width:52px;justify-content:center}' +
      '.wrap.open .launch{display:none}' +
      '.panel{position:fixed;inset:0;width:100%;height:100%;border-radius:0;bottom:0;padding-bottom:env(safe-area-inset-bottom,0)}' +
    '}' +
    '</style>' +
    '<div class="wrap" part="wrap">' +
      '<div class="panel" role="dialog" aria-label="DigitalRYZE chat">' +
        '<div class="head"><div class="t"><h2>DigitalRYZE assistant</h2>' +
          '<p>Answers right away. Our strategists reply within one business day.</p></div>' +
          '<button class="new" type="button" aria-label="Start a new chat" title="Start a new chat" hidden>' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>New chat</button>' +
          '<button class="x" aria-label="Close chat">&times;</button></div>' +
        '<a class="book" target="_blank" rel="noopener">Book a free 30-minute strategy call <span>&#8250;</span></a>' +
        '<div class="log" aria-live="polite"></div>' +
        '<div class="chips"></div>' +
        '<div class="status"></div>' +
        '<form class="form"><textarea rows="1" placeholder="Type your message" aria-label="Your message" maxlength="1500"></textarea>' +
          '<button class="send" type="submit" aria-label="Send message">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>' +
          '</button></form>' +
        '<div class="foot">AI assistant. Chats are saved so our team can follow up.</div>' +
      '</div>' +
      '<button class="launch" aria-label="Open DigitalRYZE chat"><span class="mark">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 15l7-7 7 7"/></svg>' +
      '</span><span class="lbl">Ask DigitalRYZE</span></button>' +
    '</div>';

  var wrap = root.querySelector(".wrap");
  var log = root.querySelector(".log");
  var chips = root.querySelector(".chips");
  var form = root.querySelector(".form");
  var input = root.querySelector("textarea");
  var sendBtn = root.querySelector(".send");
  var newBtn = root.querySelector(".new");
  var statusEl = root.querySelector(".status");
  root.querySelector(".book").href = BOOK_URL;

  // ---------- rendering ----------
  function esc(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function linkify(text) {
    var html = esc(text);
    html = html.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    html = html.replace(/(^|[\s(])((?:www\.)?digitalryze\.com(?:\/[^\s<]*[^\s<.,;:!?)])?)/g, function (m, pre, url) {
      return pre + '<a href="https://' + url.replace(/^https?:\/\//, "") + '" target="_blank" rel="noopener">' + url + "</a>";
    });
    html = html.replace(/(\+91[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{4})/g, function (m) {
      return '<a href="tel:' + m.replace(/[\s-]/g, "") + '">' + m + "</a>";
    });
    return html;
  }
  function bubble(role, text, name) {
    var d = document.createElement("div");
    if (role === "system") {
      d.className = "sys"; d.textContent = text;
    } else if (role === "agent") {
      d.className = "agentwrap";
      d.innerHTML = '<span class="agentname">' + esc(name || "DigitalRYZE team") + '</span><div class="msg agent">' + linkify(text) + "</div>";
      // Team replies are already translated into the visitor's language on the server, so no translate button is needed.
    } else {
      d.className = "msg " + (role === "user" || role === "visitor" ? "me" : "bot");
      d.innerHTML = linkify(text);
      var wrap = document.createElement("div"); wrap.style.cssText = "display:flex;flex-direction:column;max-width:85%;align-self:" + (d.classList.contains("me") ? "flex-end" : "flex-start");
      wrap.appendChild(d); log.appendChild(wrap); log.scrollTop = log.scrollHeight; return; // the AI already replies in the visitor's language
    }
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }
  function addTranslate(parent, text) {
    var b = document.createElement("button"); b.type = "button"; b.className = "transbtn"; var label = "Translate (" + LANG_NAME + ")"; b.textContent = label; b.setAttribute("data-translate", "1");
    var out = document.createElement("div"); out.className = "translation"; out.hidden = true;
    b.addEventListener("click", function () {
      if (!out.hidden) { out.hidden = true; b.textContent = label; return; }
      b.disabled = true; b.textContent = "Translating…";
      fetch(base + "/api/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text, target: VISITOR_LANG }) })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error); return d; }); })
        .then(function (d) { out.textContent = d.translation; out.hidden = false; b.textContent = "Hide translation"; if (d.already_target) b.hidden = true; })
        .catch(function () { out.textContent = "Translation failed. Please try again."; out.hidden = false; b.textContent = "Try translation again"; })
        .then(function () { b.disabled = false; });
    });
    parent.appendChild(b); parent.appendChild(out);
  }
  function renderAll() {
    log.innerHTML = "";
    bubble("assistant", GREETING);
    var items = state.messages.filter(function (m) { return !m.ctx; }).map(function (m, i) { return { role: m.role, content: m.content, ts: m.ts || i }; })
      .concat(state.live.map(function (m) { return { role: m.role, content: m.content, ts: m.ts, name: m.name }; }));
    items.sort(function (a, b) { return a.ts - b.ts; });
    items.forEach(function (m) { bubble(m.role, m.content, m.name); });
    renderChips();
    renderStatus();
  }
  function renderStatus() {
    if (state.handoff === "requested") {
      statusEl.innerHTML = '<div class="wait"><span style="display:flex;align-items:center;gap:8px"><span class="dot"></span>Waiting for a team member...</span>' +
        '<button type="button" class="stopwait">Keep chatting with AI</button></div>';
      statusEl.querySelector(".stopwait").onclick = function () { giveUp(true); };
      input.disabled = true; sendBtn.disabled = true;
      input.placeholder = "A team member will join shortly";
    } else if (state.handoff === "live") {
      statusEl.innerHTML = '<div class="live"><span class="dot"></span>You are chatting with ' + esc(state.agent || "our team") + "</div>";
      input.disabled = false; sendBtn.disabled = busy;
      input.placeholder = "Message " + (state.agent || "our team");
    } else {
      statusEl.innerHTML = "";
      input.disabled = false; sendBtn.disabled = busy;
      input.placeholder = "Type your message";
    }
  }
  function renderChips() {
    newBtn.hidden = state.messages.length === 0;
    chips.innerHTML = "";
    if (state.messages.length) return;
    CHIPS.forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = c;
      b.onclick = c === "Other"
        ? function () {   // "Other": let the visitor type their own question
            input.placeholder = "Tell us what you need help with";
            input.focus();
          }
        : function () { send(c); };
      chips.appendChild(b);
    });
  }
  function typing(on) {
    var t = log.querySelector(".typing");
    if (on && !t) {
      t = document.createElement("div");
      t.className = "typing";
      t.setAttribute("aria-label", "Assistant is typing");
      t.innerHTML = "<i></i><i></i><i></i>";
      log.appendChild(t);
      log.scrollTop = log.scrollHeight;
    } else if (!on && t) t.remove();
  }

  // ---------- behaviour ----------
  function setOpen(open) {
    state.open = open;
    wrap.classList.toggle("open", open);
    save();
    if (open) setTimeout(function () { input.focus(); }, 50);
  }

  function send(text) {
    text = (text || "").trim();
    if (!text || busy || state.handoff === "requested") return;
    if (state.handoff === "live") return sendLive(text);
    busy = true;
    sendBtn.disabled = true;
    state.messages.push({ role: "user", content: text, ts: Date.now() });
    save();
    newBtn.hidden = false;
    bubble("user", text);
    chips.innerHTML = "";
    input.value = "";
    autosize();
    typing(true);

    fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: state.messages,
        sessionId: state.sessionId,
        leadSaved: state.leadSaved,
        page: location.href
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var reply = (data && data.reply) || "Sorry, something went wrong. You can call +91 760 044 3625.";
        if (data && data.leadSaved) state.leadSaved = true;
        state.messages.push({ role: "assistant", content: reply, ts: Date.now() });
        save();
        typing(false);
        bubble("assistant", reply);
        if (data && data.handoff) startWaiting();
      })
      .catch(function () {
        typing(false);
        var msg = "I can't connect right now. You can book a call at " + BOOK_URL + " or call +91 760 044 3625.";
        bubble("assistant", msg);
      })
      .then(function () {
        busy = false;
        renderStatus();
        if (!input.disabled) input.focus();
      });
  }

  // ---------- live chat with a team member ----------
  function addLive(role, content, name, ts) {
    var item = { role: role, content: content, name: name || "", ts: ts || Date.now() };
    state.live.push(item); save();
    bubble(role, content, name);
  }
  function sendLive(text) {
    input.value = ""; autosize();
    addLive("visitor", text);
    fetch(LIVE_API, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: state.sessionId, action: "send", content: text }) })
      .then(function (r) { if (r.status === 409) poll(); })
      .catch(function () { bubble("system", "Message not sent. Check your connection."); });
  }
  function startWaiting() {
    state.handoff = "requested"; state.handoffAt = Date.now(); save();
    renderStatus(); startPolling();
  }
  function startPolling() {
    stopPolling();
    poll();
    pollTimer = setInterval(poll, 3000);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function poll() {
    if (!state.handoff) return stopPolling();
    fetch(LIVE_API + "?session=" + encodeURIComponent(state.sessionId) + "&after=" + state.liveAfter)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        (d.messages || []).forEach(function (m) {
          if (m.id <= state.liveAfter) return; // already shown (two checks overlapped)
          state.liveAfter = Math.max(state.liveAfter, m.id);
          if (m.role === "visitor") return; // already shown when sent
          addLive(m.role, m.content, d.agent, new Date(m.created_at).getTime());
        });
        save();
        if (d.status === "accepted" && state.handoff !== "live") {
          state.handoff = "live"; state.agent = d.agent || "our team"; save();
          if (!state.open) setOpen(true);
          renderStatus(); input.focus();
        } else if (d.status === "rejected" || d.status === "missed") {
          giveUp(false);
        } else if (d.status === "ended" && state.handoff === "live") {
          state.handoff = null;
          // Give the AI the live conversation (not shown twice), so it can continue where the team member left off.
          state.live.forEach(function (m) {
            if (m.synced || (m.role !== "visitor" && m.role !== "agent")) return;
            state.messages.push({ role: m.role === "visitor" ? "user" : "assistant", ts: m.ts, ctx: true,
              content: (m.role === "agent" ? "[" + (m.name || "Team member") + " from DigitalRYZE said]: " : "") + m.content });
            m.synced = true;
          });
          save(); stopPolling();
          // The server sends the handover message in the visitor's language; older servers don't, so say it here.
          if (!(d.messages || []).some(function (m) { return m.role === "assistant"; })) {
            botSays("I'm the DigitalRYZE AI assistant, and I'll continue helping you from here. What else can I help you with?");
          }
          renderStatus();
        } else if (state.handoff === "requested" && Date.now() - state.handoffAt > WAIT_MS) {
          fetch(LIVE_API, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session: state.sessionId, action: "timeout" }) }).catch(function () {});
          giveUp(false);
        }
      })
      .catch(function () {});
  }
  function botSays(text) {
    state.messages.push({ role: "assistant", content: text, ts: Date.now() }); save();
    bubble("assistant", text);
  }
  function giveUp(byVisitor) {
    if (state.handoff !== "requested") return;
    state.handoff = null; save(); stopPolling();
    if (byVisitor) {
      fetch(LIVE_API, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: state.sessionId, action: "timeout" }) }).catch(function () {});
      botSays("No problem, I'm still here. What else can I help you with?");
    } else {
      botSays("Sorry, our team isn't available right now. We'll contact you shortly." +
        (state.leadSaved ? " A DigitalRYZE strategist will reach out within one business day."
          : " Could you share your name and your email or phone number so we can reach you?"));
    }
    renderStatus();
  }

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 110) + "px";
  }

  root.querySelector(".launch").onclick = function () { setOpen(!state.open); };
  // Lets a page open the chat, optionally with a first message: DigitalRYZEChat.open("I need more leads")
  window.DigitalRYZEChat = {
    open: function (text) {
      setOpen(true);
      if (text && state.handoff !== "live" && state.handoff !== "waiting") send(String(text));
    }
  };
  root.querySelector(".x").onclick = function () { setOpen(false); };
  newBtn.onclick = function () {
    if (busy) return;
    // The old chat stays saved in the dashboard; this just starts a fresh one.
    stopPolling();
    state = fresh(true);
    save();
    renderAll();
    input.value = "";
    autosize();
    input.focus();
  };
  form.onsubmit = function (e) { e.preventDefault(); send(input.value); };
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input.value); }
  });
  root.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.open) setOpen(false);
  });

  renderAll();
  if (state.open) setOpen(true);
  if (state.handoff) startPolling();
})();
