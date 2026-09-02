/*
 * live-chat demo client.
 *
 * Plain ES modules, no framework and no CDN — the file is served by the
 * Worker's ASSETS binding and has to work with no network beyond the Worker
 * itself. It speaks the whole of `src/shared/protocol.ts`.
 *
 * Two things drive the shape of this file:
 *  - the server acks a `send` before (and separately from) fanning the message
 *    out, so every outgoing message lives as an optimistic row keyed by `cid`
 *    until an `ack` (or a `rejected`) resolves it;
 *  - several routes belong to slices that may not be implemented yet, so every
 *    HTTP call degrades to a hint instead of breaking the screen.
 */

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const PING_INTERVAL_MS = 20_000;
const RANKING_REFRESH_MS = 15_000;
const MAX_RENDERED_MESSAGES = 300;
/** Re-mint the dev token when this little of its lifetime is left. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Roles `defaultRoomConfig` exempts from slow-mode; used only as a UI hint. */
const PRIVILEGED_ROLES = ["moderator", "admin", "system"];

const REJECT_LABELS = {
  unauthenticated: "not authenticated",
  forbidden: "not allowed",
  banned: "you are banned from this room",
  muted: "you are muted",
  room_closed: "the room is closed",
  room_full: "the room is full",
  rate_limited: "too fast — rate limited",
  slow_mode: "slow mode is on",
  spam: "flagged as spam",
  blocked_content: "blocked by moderation",
  too_long: "message is too long",
  empty: "message is empty",
  malformed: "malformed message",
  internal: "server error",
};

const $ = (id) => document.getElementById(id);

const dom = {
  status: $("conn-status"),
  themeToggle: $("theme-toggle"),
  joinForm: $("join-form"),
  room: $("room-input"),
  name: $("name-input"),
  moderator: $("mod-input"),
  connect: $("connect-btn"),
  disconnect: $("disconnect-btn"),
  joinHint: $("join-hint"),
  factUser: $("fact-user"),
  factRoles: $("fact-roles"),
  factShard: $("fact-shard"),
  factPresence: $("fact-presence"),
  factSlowMode: $("fact-slowmode"),
  factMaxLen: $("fact-maxlen"),
  factConfigVersion: $("fact-configversion"),
  factPing: $("fact-ping"),
  roomBadge: $("room-badge"),
  slowModeBadge: $("slowmode-badge"),
  closedBadge: $("closed-badge"),
  messages: $("messages"),
  messagesEmpty: $("messages-empty"),
  composer: $("composer"),
  body: $("body-input"),
  emoji: $("emoji-select"),
  send: $("send-btn"),
  rankingList: $("ranking-list"),
  rankingHint: $("ranking-hint"),
  rankingRefresh: $("ranking-refresh"),
  modPanel: $("mod-panel"),
  slowModeInput: $("slowmode-input"),
  closedInput: $("closed-input"),
  configApply: $("config-apply"),
  banUser: $("ban-user-input"),
  banReason: $("ban-reason-input"),
  banApply: $("ban-apply"),
  deleteId: $("delete-id-input"),
  deleteApply: $("delete-apply"),
  modHint: $("mod-hint"),
};

const session = {
  roomId: "",
  userId: "",
  name: "",
  roles: [],
  token: "",
  tokenExpiresAt: 0,
  ws: null,
  /** Set while the user asked to be connected; drives the reconnect loop. */
  wanted: false,
  attempt: 0,
  reconnectTimer: 0,
  countdownTimer: 0,
  pingTimer: 0,
  rankingTimer: 0,
  slowModeTimer: 0,
  lastPingAt: 0,
  config: null,
  nextSendAt: 0,
  seq: 0,
};

/** Rendered rows, addressable by both keys a row can have during its life. */
const rows = { byCid: new Map(), byId: new Map() };

/* ------------------------------------------------------------------ */
/* theme                                                               */
/* ------------------------------------------------------------------ */

const THEMES = ["auto", "light", "dark"];

function applyTheme(theme) {
  // "auto" means: remove the attribute and let prefers-color-scheme decide.
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  dom.themeToggle.textContent = `theme: ${theme}`;
  dom.themeToggle.setAttribute(
    "aria-label",
    theme === "auto" ? "Colour theme: follow system" : `Colour theme: ${theme}`,
  );
  try {
    localStorage.setItem("live-chat-theme", theme);
  } catch {
    /* private mode — the choice just does not persist */
  }
}

function initTheme() {
  let stored = "auto";
  try {
    stored = localStorage.getItem("live-chat-theme") ?? "auto";
  } catch {
    /* ignore */
  }
  applyTheme(THEMES.includes(stored) ? stored : "auto");
  dom.themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") ?? "auto";
    applyTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
  });
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function setHint(el, text, tone) {
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function setStatus(state, text) {
  dom.status.dataset.state = state;
  dom.status.textContent = text;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function isPrivileged() {
  return session.roles.some((role) => PRIVILEGED_ROLES.includes(role));
}

function newCid() {
  session.seq += 1;
  return `c${Date.now().toString(36)}-${session.seq}`;
}

/**
 * One JSON call. Never throws: callers render `status`/`error` instead, which
 * is what keeps a missing slice (404) from taking the page down.
 */
async function api(method, path, { body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth && session.token) headers.authorization = `Bearer ${session.token}`;
  try {
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* empty or non-JSON body (204, HTML 404 page, …) */
    }
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: String(error) };
  }
}

function apiErrorText(result, fallback) {
  if (result.status === 404) return "route not available yet (404)";
  if (result.status === 0) return `network error: ${result.error ?? "unreachable"}`;
  const message = result.data?.error?.message ?? result.data?.error?.code;
  return message ? `${result.status}: ${message}` : `${fallback} (${result.status})`;
}

/* ------------------------------------------------------------------ */
/* message list                                                        */
/* ------------------------------------------------------------------ */

function hideEmptyPlaceholder() {
  if (dom.messagesEmpty.isConnected) dom.messagesEmpty.remove();
}

function atBottom() {
  const el = dom.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function appendRow(el) {
  hideEmptyPlaceholder();
  const stick = atBottom();
  dom.messages.append(el);
  while (dom.messages.children.length > MAX_RENDERED_MESSAGES) {
    dom.messages.firstElementChild?.remove();
  }
  if (stick) dom.messages.scrollTop = dom.messages.scrollHeight;
}

function systemLine(text, tone) {
  const li = document.createElement("li");
  li.className = "system";
  if (tone) li.dataset.tone = tone;
  li.textContent = text;
  appendRow(li);
}

function createRow({ cid, mine, author, roles, ts, body, state }) {
  const li = document.createElement("li");
  li.className = "msg";
  li.dataset.state = state;
  li.dataset.mine = String(Boolean(mine));

  const head = document.createElement("div");
  head.className = "msg-head";

  const who = document.createElement("span");
  who.className = "msg-author";
  who.textContent = author;
  head.append(who);

  for (const role of roles ?? []) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = role;
    head.append(badge);
  }

  const time = document.createElement("time");
  time.textContent = ts ? formatTime(ts) : "sending…";
  head.append(time);

  const bodyEl = document.createElement("p");
  bodyEl.className = "msg-body";
  bodyEl.textContent = body;

  const foot = document.createElement("div");
  foot.className = "msg-foot";

  li.append(head, bodyEl, foot);

  const row = {
    cid,
    id: null,
    el: li,
    timeEl: time,
    bodyEl,
    footEl: foot,
    noteEl: null,
    reactions: new Map(),
    chips: new Map(),
    userId: null,
  };
  return row;
}

function setNote(row, text, tone) {
  if (!row.noteEl) {
    row.noteEl = document.createElement("span");
    row.noteEl.className = "system";
    row.footEl.prepend(row.noteEl);
  }
  row.noteEl.textContent = text;
  if (tone) row.noteEl.dataset.tone = tone;
}

/** Buttons only make sense once the message has a server id. */
function addActions(row) {
  if (row.el.querySelector(".msg-actions")) return;
  const wrap = document.createElement("span");
  wrap.className = "msg-actions";

  const react = document.createElement("button");
  react.type = "button";
  react.className = "ghost";
  react.textContent = "react";
  react.addEventListener("click", () => sendReaction(row.id));
  wrap.append(react);

  if (isPrivileged()) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = "delete";
    del.addEventListener("click", () => moderatorDelete(row.id));
    wrap.append(del);

    if (row.userId) {
      const ban = document.createElement("button");
      ban.type = "button";
      ban.className = "ghost";
      ban.textContent = "ban";
      ban.addEventListener("click", () => moderatorBan(row.userId, "banned from the demo client"));
      wrap.append(ban);
    }
  }

  row.footEl.append(wrap);
}

function bumpReaction(row, emoji, delta) {
  const next = (row.reactions.get(emoji) ?? 0) + delta;
  row.reactions.set(emoji, next);
  let chip = row.chips.get(emoji);
  if (!chip) {
    chip = document.createElement("span");
    chip.className = "badge reaction";
    row.chips.set(emoji, chip);
    // Chips go before the action buttons so the row keeps a stable layout.
    row.footEl.prepend(chip);
  }
  chip.textContent = `${emoji} ${next}`;
}

function rowForId(id) {
  return rows.byId.get(id) ?? null;
}

/* ------------------------------------------------------------------ */
/* protocol handlers                                                   */
/* ------------------------------------------------------------------ */

function onHello(msg) {
  session.userId = msg.userId;
  session.roles = msg.roles ?? [];
  session.attempt = 0;
  applyConfig(msg.config);
  dom.factUser.textContent = `${msg.name} (${msg.userId})`;
  dom.factRoles.textContent = session.roles.length ? session.roles.join(", ") : "—";
  dom.factShard.textContent = `#${msg.shardIndex}`;
  dom.roomBadge.textContent = msg.roomId;
  dom.modPanel.hidden = !isPrivileged();
  setStatus("online", `connected to ${msg.roomId}`);
  systemLine(`connected as ${msg.name} on shard #${msg.shardIndex}`);
  refreshRanking();
}

function applyConfig(config) {
  session.config = config;
  dom.factSlowMode.textContent = config.slowModeMs ? `${config.slowModeMs} ms` : "off";
  dom.factMaxLen.textContent = `${config.maxMessageLength}`;
  dom.factConfigVersion.textContent = `${config.version}`;
  dom.slowModeBadge.hidden = config.slowModeMs === 0;
  dom.slowModeBadge.textContent = `slow mode ${Math.round(config.slowModeMs / 100) / 10}s`;
  dom.closedBadge.hidden = !config.closed;
  dom.body.maxLength = config.maxMessageLength;
  if (document.activeElement !== dom.slowModeInput) {
    dom.slowModeInput.value = String(Math.round(config.slowModeMs / 1000));
  }
  if (document.activeElement !== dom.closedInput) dom.closedInput.checked = config.closed;
}

function onChat(m) {
  const known = rowForId(m.id);
  if (known) {
    // Our own optimistic row, now confirmed by the fanout: adopt the server
    // copy so a masked body or a rewritten name is what stays on screen.
    known.bodyEl.textContent = m.body;
    known.timeEl.textContent = formatTime(m.ts);
    known.userId = m.userId;
    if (m.masked) setNote(known, "masked by moderation", "error");
    return;
  }

  const row = createRow({
    cid: null,
    mine: m.userId === session.userId,
    author: m.name,
    roles: m.roles,
    ts: m.ts,
    body: m.body,
    state: "live",
  });
  row.id = m.id;
  row.userId = m.userId;
  rows.byId.set(m.id, row);
  if (m.masked) setNote(row, "masked by moderation", "error");
  addActions(row);
  appendRow(row.el);
}

function onAck(msg) {
  const row = rows.byCid.get(msg.cid);
  if (!row) return;
  rows.byCid.delete(msg.cid);
  row.id = msg.id;
  row.userId = session.userId;
  row.el.dataset.state = "live";
  row.timeEl.textContent = formatTime(msg.ts);
  rows.byId.set(msg.id, row);
  addActions(row);
  startSlowModeCountdown(session.config?.slowModeMs ?? 0);
}

function onRejected(msg) {
  const row = rows.byCid.get(msg.cid);
  const label = REJECT_LABELS[msg.code] ?? msg.code;
  const detail = msg.reason && msg.reason !== label ? ` — ${msg.reason}` : "";
  if (row) {
    rows.byCid.delete(msg.cid);
    row.el.dataset.state = "rejected";
    row.timeEl.textContent = "rejected";
    setNote(row, `${label}${detail}`, "error");
  } else {
    systemLine(`rejected: ${label}${detail}`, "error");
  }
  if (msg.retryAfterMs) startSlowModeCountdown(msg.retryAfterMs);
}

function onDelete(msg) {
  for (const id of msg.ids) {
    const row = rowForId(id);
    if (!row) continue;
    row.el.dataset.state = "deleted";
    setNote(row, msg.reason ? `deleted: ${msg.reason}` : "deleted by a moderator", "error");
  }
}

function onReaction(msg) {
  const row = rowForId(msg.messageId);
  // A reaction for a message we never rendered (history, other shard) is not an
  // error — there is simply nothing to update.
  if (row) bumpReaction(row, msg.emoji, msg.count);
}

function onPresence(msg) {
  dom.factPresence.textContent = `${msg.count}`;
}

function onSystem(msg) {
  systemLine(`server: ${msg.code}${msg.reason ? ` — ${msg.reason}` : ""}`, "error");
  if (msg.code === "banned") {
    // A ban is final: stop the reconnect loop instead of hammering the edge.
    session.wanted = false;
    setStatus("error", "banned from this room");
  }
}

function onPong() {
  if (session.lastPingAt) {
    dom.factPing.textContent = `${Date.now() - session.lastPingAt} ms`;
    session.lastPingAt = 0;
  }
}

function dispatch(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.t) {
    case "hello":
      return onHello(msg);
    case "msg":
      return onChat(msg.m);
    case "ack":
      return onAck(msg);
    case "rejected":
      return onRejected(msg);
    case "delete":
      return onDelete(msg);
    case "reaction":
      return onReaction(msg);
    case "presence":
      return onPresence(msg);
    case "config":
      return applyConfig(msg.config);
    case "sys":
      return onSystem(msg);
    case "pong":
      return onPong(msg);
    default:
      // The protocol is additive: unknown frames must be ignored, not fatal.
      return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* connection                                                          */
/* ------------------------------------------------------------------ */

async function mintToken() {
  const roles = dom.moderator.checked ? ["moderator"] : [];
  const name = dom.name.value.trim() || "anonymous";
  const result = await api("POST", "/api/dev/token", {
    body: { userId: session.userId || name, name, roles },
  });
  if (!result.ok || !result.data?.token) {
    setHint(dom.joinHint, `could not mint a token — ${apiErrorText(result, "token failed")}`, "error");
    return false;
  }
  session.token = result.data.token;
  session.name = result.data.identity?.name ?? name;
  session.userId = result.data.identity?.userId ?? name;
  session.roles = result.data.identity?.roles ?? roles;
  session.tokenExpiresAt = (result.data.identity?.expiresAt ?? 0) * 1000;
  setHint(dom.joinHint, `token ready for ${session.userId}`, "ok");
  return true;
}

function socketUrl() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws/${encodeURIComponent(session.roomId)}?token=${encodeURIComponent(session.token)}`;
}

async function openSocket() {
  if (!session.wanted) return;
  clearTimeout(session.reconnectTimer);
  clearInterval(session.countdownTimer);

  const expiringSoon = session.tokenExpiresAt - Date.now() < TOKEN_REFRESH_MARGIN_MS;
  if (!session.token || expiringSoon) {
    const ok = await mintToken();
    if (!ok) return scheduleReconnect();
  }

  setStatus("connecting", session.attempt === 0 ? "connecting…" : "reconnecting…");
  let ws;
  try {
    ws = new WebSocket(socketUrl());
  } catch (error) {
    systemLine(`could not open the socket: ${String(error)}`, "error");
    return scheduleReconnect();
  }
  session.ws = ws;

  ws.addEventListener("message", (event) => dispatch(event.data));

  ws.addEventListener("open", () => {
    session.attempt = 0;
    dom.body.disabled = false;
    dom.send.disabled = false;
    dom.rankingRefresh.disabled = false;
    startPing();
    startRankingRefresh();
  });

  ws.addEventListener("close", (event) => {
    stopPing();
    stopRankingRefresh();
    session.ws = null;
    dom.body.disabled = true;
    dom.send.disabled = true;
    // 4403 is the shard's ban close code; `sys` already explained it.
    if (!session.wanted) {
      setStatus("offline", "disconnected");
      return;
    }
    systemLine(`connection lost (${event.code}${event.reason ? `: ${event.reason}` : ""})`);
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // The close event always follows; it owns the reconnect decision.
    setStatus("error", "connection error");
  });
}

function scheduleReconnect() {
  if (!session.wanted) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** session.attempt);
  // Jitter keeps a room full of demo tabs from reconnecting in lockstep.
  const wait = delay + Math.floor(Math.random() * 250);
  session.attempt += 1;

  let remaining = Math.ceil(wait / 1000);
  setStatus("reconnecting", `reconnecting in ${remaining}s (attempt ${session.attempt})`);
  clearInterval(session.countdownTimer);
  session.countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      setStatus("reconnecting", `reconnecting in ${remaining}s (attempt ${session.attempt})`);
    }
  }, 1000);

  clearTimeout(session.reconnectTimer);
  session.reconnectTimer = setTimeout(() => {
    clearInterval(session.countdownTimer);
    void openSocket();
  }, wait);
}

function startPing() {
  stopPing();
  session.pingTimer = setInterval(() => {
    if (session.ws?.readyState !== WebSocket.OPEN) return;
    session.lastPingAt = Date.now();
    // Exactly the frame the shard registered as a hibernation auto-response, so
    // a quiet tab never wakes the Durable Object just to be told it is alive.
    session.ws.send('{"t":"ping"}');
  }, PING_INTERVAL_MS);
}

function stopPing() {
  clearInterval(session.pingTimer);
  session.pingTimer = 0;
}

function disconnect() {
  session.wanted = false;
  clearTimeout(session.reconnectTimer);
  clearInterval(session.countdownTimer);
  stopPing();
  stopRankingRefresh();
  try {
    session.ws?.close(1000, "client left");
  } catch {
    /* already closed */
  }
  session.ws = null;
  dom.connect.disabled = false;
  dom.disconnect.disabled = true;
  dom.body.disabled = true;
  dom.send.disabled = true;
  dom.rankingRefresh.disabled = true;
  setStatus("offline", "disconnected");
}

/* ------------------------------------------------------------------ */
/* sending                                                             */
/* ------------------------------------------------------------------ */

function startSlowModeCountdown(ms) {
  if (!ms || isPrivileged()) return;
  session.nextSendAt = Date.now() + ms;
  clearInterval(session.slowModeTimer);
  const tick = () => {
    const left = session.nextSendAt - Date.now();
    if (left <= 0) {
      clearInterval(session.slowModeTimer);
      session.slowModeTimer = 0;
      dom.send.disabled = session.ws?.readyState !== WebSocket.OPEN;
      dom.send.textContent = "Send";
      return;
    }
    dom.send.disabled = true;
    dom.send.textContent = `Wait ${Math.ceil(left / 1000)}s`;
  };
  tick();
  session.slowModeTimer = setInterval(tick, 200);
}

function sendMessage(body) {
  if (session.ws?.readyState !== WebSocket.OPEN) return;
  const cid = newCid();
  const row = createRow({
    cid,
    mine: true,
    author: session.name,
    roles: session.roles,
    ts: 0,
    body,
    state: "pending",
  });
  rows.byCid.set(cid, row);
  appendRow(row.el);
  session.ws.send(JSON.stringify({ t: "send", cid, body }));
}

function sendReaction(messageId) {
  if (!messageId || session.ws?.readyState !== WebSocket.OPEN) return;
  session.ws.send(
    JSON.stringify({ t: "react", cid: newCid(), messageId, emoji: dom.emoji.value }),
  );
}

/* ------------------------------------------------------------------ */
/* ranking                                                             */
/* ------------------------------------------------------------------ */

function renderRanking(snapshot) {
  dom.rankingList.replaceChildren();
  const top = snapshot?.top ?? [];
  if (top.length === 0) {
    setHint(dom.rankingHint, "no ranking data yet.");
    return;
  }
  top.forEach((entry, index) => {
    const li = document.createElement("li");

    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = `${index + 1}.`;

    const who = document.createElement("span");
    who.className = "who";
    who.textContent = entry.name ?? entry.userId;

    const score = document.createElement("span");
    score.className = "score";
    score.textContent = `${entry.messages ?? 0}m / ${entry.reactions ?? 0}r`;

    li.append(rank, who, score);
    dom.rankingList.append(li);
  });
  const at = snapshot.generatedAt ? formatTime(snapshot.generatedAt) : "just now";
  setHint(dom.rankingHint, `updated ${at}`, "ok");
}

async function refreshRanking() {
  if (!session.roomId) return;
  const result = await api("GET", `/api/rooms/${encodeURIComponent(session.roomId)}/ranking`);
  if (!result.ok) {
    dom.rankingList.replaceChildren();
    setHint(dom.rankingHint, `ranking unavailable — ${apiErrorText(result, "failed")}`);
    return;
  }
  // The ranking slice may answer with the snapshot directly or wrapped.
  renderRanking(result.data?.ranking ?? result.data?.snapshot ?? result.data);
}

function startRankingRefresh() {
  stopRankingRefresh();
  session.rankingTimer = setInterval(refreshRanking, RANKING_REFRESH_MS);
}

function stopRankingRefresh() {
  clearInterval(session.rankingTimer);
  session.rankingTimer = 0;
}

/* ------------------------------------------------------------------ */
/* moderator actions                                                   */
/* ------------------------------------------------------------------ */

async function applyRoomConfig() {
  const seconds = Number.parseInt(dom.slowModeInput.value, 10);
  const patch = {
    slowModeMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
    closed: dom.closedInput.checked,
  };
  const result = await api("PATCH", `/api/rooms/${encodeURIComponent(session.roomId)}/config`, {
    body: patch,
    auth: true,
  });
  if (!result.ok) {
    setHint(dom.modHint, `config not applied — ${apiErrorText(result, "failed")}`, "error");
    return;
  }
  setHint(dom.modHint, "configuration applied.", "ok");
  // The coordinator also fans a `config` event out; this just avoids the wait.
  if (result.data?.config) applyConfig(result.data.config);
}

async function moderatorBan(userId, reason) {
  if (!userId) {
    setHint(dom.modHint, "a user id is required to ban.", "error");
    return;
  }
  const result = await api("POST", `/api/rooms/${encodeURIComponent(session.roomId)}/bans`, {
    body: { userId, reason: reason || "banned by a moderator" },
    auth: true,
  });
  setHint(
    dom.modHint,
    result.ok ? `banned ${userId}.` : `ban failed — ${apiErrorText(result, "failed")}`,
    result.ok ? "ok" : "error",
  );
}

async function moderatorDelete(messageId) {
  if (!messageId) {
    setHint(dom.modHint, "a message id is required to delete.", "error");
    return;
  }
  const result = await api(
    "POST",
    `/api/rooms/${encodeURIComponent(session.roomId)}/moderation/delete`,
    { body: { messageIds: [messageId], reason: "removed by a moderator" }, auth: true },
  );
  setHint(
    dom.modHint,
    result.ok ? `delete requested for ${messageId}.` : `delete failed — ${apiErrorText(result, "failed")}`,
    result.ok ? "ok" : "error",
  );
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

dom.joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const room = dom.room.value.trim();
  const name = dom.name.value.trim();
  if (!room || !name) return;

  disconnect();
  rows.byCid.clear();
  rows.byId.clear();
  dom.messages.replaceChildren();

  session.roomId = room;
  session.userId = name;
  session.token = "";
  session.attempt = 0;
  session.wanted = true;
  dom.connect.disabled = true;
  dom.disconnect.disabled = false;
  dom.roomBadge.textContent = room;
  await openSocket();
});

dom.disconnect.addEventListener("click", () => {
  disconnect();
  systemLine("you left the room");
});

dom.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const body = dom.body.value.trim();
  if (!body) return;
  sendMessage(body);
  dom.body.value = "";
  dom.body.focus();
});

dom.body.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    dom.composer.requestSubmit();
  }
});

dom.rankingRefresh.addEventListener("click", refreshRanking);
dom.configApply.addEventListener("click", applyRoomConfig);
dom.banApply.addEventListener("click", () =>
  moderatorBan(dom.banUser.value.trim(), dom.banReason.value.trim()),
);
dom.deleteApply.addEventListener("click", () => moderatorDelete(dom.deleteId.value.trim()));

window.addEventListener("beforeunload", () => {
  session.wanted = false;
  session.ws?.close();
});

initTheme();
dom.name.value = `guest-${Math.floor(Math.random() * 9000 + 1000)}`;
setStatus("offline", "disconnected");
