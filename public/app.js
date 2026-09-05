/*
 * live-chat demo client — Twitch-style chat.
 *
 * Plain ES modules, no framework and no CDN: the Worker's ASSETS binding is the
 * only thing in front of it, so everything has to work offline.
 *
 * Two server behaviours shape this file:
 *  - a `send` is acked separately from the fanout, so every outgoing message is
 *    an optimistic row keyed by `cid` until an `ack` or a `rejected` resolves it;
 *  - a reply carries only the parent id; the shard resolves the author and the
 *    excerpt, so nothing here may invent them.
 */
import { mountConsole } from "./console.js";
import {
  EMOTE_SETS,
  GIF_SET,
  EMOJI_RUN,
  lookupEmote,
  lookupGif,
  searchEmotes,
} from "/emotes.js";

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const PING_INTERVAL_MS = 20_000;
const RANKING_REFRESH_MS = 15_000;
const MAX_RENDERED_MESSAGES = 300;
const HISTORY_LIMIT = 50;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const RECENT_EMOTES_KEY = "live-chat-recent-emotes";
const QUICK_REACTIONS = ["❤️", "😂", "😮", "🔥", "👏", "💀"];
const PRIVILEGED_ROLES = ["moderator", "admin", "system"];
/** One room for the demo; the link is all anyone needs to start watching. */
const ROOM_ID = "demo";

const REJECT_LABELS = {
  unauthenticated: "você não está autenticado",
  forbidden: "ação não permitida",
  banned: "você está banido desta sala",
  muted: "você está silenciado",
  room_closed: "a sala está fechada",
  room_full: "a sala está cheia",
  rate_limited: "calma — muitas mensagens seguidas",
  slow_mode: "modo lento ativo",
  spam: "marcada como spam",
  blocked_content: "bloqueada pela moderação",
  too_long: "mensagem longa demais",
  empty: "mensagem vazia",
  malformed: "mensagem malformada",
  internal: "erro no servidor",
};

/**
 * Twitch gives every chatter a colour so names are scannable in a fast stream.
 * These are picked to stay legible on #18181b — the dark half of Twitch's own
 * defaults would disappear against it.
 */
const NAME_COLORS = [
  "#ff4a80", "#ff7f50", "#4fa8ff", "#00c8af", "#9acd32", "#ff69b4",
  "#b39dff", "#ffb000", "#5bcefa", "#8ae234", "#ff6b6b", "#00e0c7",
  "#c792ea", "#ffd866", "#7fdbff", "#f78c6c",
];

const $ = (id) => document.getElementById(id);

const dom = {
  leaveBtn: $("leave-btn"),
  viewers: $("viewers-count"),
  board: $("board"),
  boardToggle: $("board-toggle"),
  boardStripList: $("board-strip-list"),
  boardPanel: $("board-panel"),
  boardList: $("board-list"),
  boardSub: $("board-sub"),
  boardCollapse: $("board-collapse"),
  pinned: $("pinned"),
  pinnedBody: $("pinned-body"),
  stream: $("stream"),
  streamEmpty: $("stream-empty"),
  jump: $("jump"),
  replyChip: $("reply-chip"),
  replyChipName: $("reply-chip-name"),
  replyCancel: $("reply-cancel"),
  notice: $("notice"),
  composer: $("composer"),
  body: $("body-input"),
  pickerBtn: $("picker-btn"),
  mentionMenu: $("mention-menu"),
  settingsBtn: $("settings-btn"),
  slowPill: $("slow-pill"),
  samplePill: $("sample-pill"),
  charCount: $("char-count"),
  send: $("send-btn"),
  picker: $("picker"),
  pickerSearch: $("picker-search"),
  pickerClose: $("picker-close"),
  pickerScroll: $("picker-scroll"),
  pickerRail: $("picker-rail"),
  tabEmotes: $("tab-emotes"),
  tabGifs: $("tab-gifs"),
  settings: $("settings"),
  settingsClose: $("settings-close"),
  settingsHint: $("settings-hint"),
  factUser: $("fact-user"),
  factShard: $("fact-shard"),
  factPing: $("fact-ping"),
  factConfig: $("fact-config"),
  modForm: $("mod-form"),
  slowModeInput: $("slowmode-input"),
  subroomInput: $("subroom-input"),
  closedInput: $("closed-input"),
  gate: $("gate"),
  gateBtn: $("gate-btn"),
  join: $("join"),
  joinClose: $("join-close"),
  joinForm: $("join-form"),
  name: $("name-input"),
  moderator: $("mod-input"),
  connect: $("connect-btn"),
  joinHint: $("join-hint"),
  toast: $("toast"),
};

const session = {
  roomId: "",
  userId: "",
  name: "",
  roles: [],
  token: "",
  tokenExpiresAt: 0,
  ws: null,
  wanted: false,
  attempt: 0,
  reconnectTimer: 0,
  pingTimer: 0,
  rankingTimer: 0,
  slowModeTimer: 0,
  toastTimer: 0,
  lastPingAt: 0,
  /** Last measured round trip; the console feeds it into the health verdict. */
  latencyMs: 0,
  config: null,
  shardIndex: 0,
  selectedSub: null,
  seq: 0,
  replyTo: null,
  pickerTab: "emotes",
  pickerGroup: "channel",
  /** Watching without a nickname: the stream is readable, the composer is not. */
  anonymous: true,
};

const rows = { byCid: new Map(), byId: new Map() };
/** Everyone seen in this room, for the `@` autocomplete. */
const chatters = new Map();

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function colorFor(userId) {
  return NAME_COLORS[fnv1a(userId) % NAME_COLORS.length];
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function isPrivileged() {
  return session.roles.some((role) => PRIVILEGED_ROLES.includes(role));
}

function newCid() {
  session.seq += 1;
  return `c${Date.now().toString(36)}-${session.seq}`;
}

function toast(text) {
  dom.toast.textContent = text;
  dom.toast.hidden = false;
  clearTimeout(session.toastTimer);
  session.toastTimer = setTimeout(() => {
    dom.toast.hidden = true;
  }, 2600);
}

function setNotice(text, tone) {
  if (!text) {
    dom.notice.hidden = true;
    return;
  }
  dom.notice.hidden = false;
  dom.notice.textContent = text;
  if (tone) dom.notice.dataset.tone = tone;
  else delete dom.notice.dataset.tone;
}

function setHint(el, text, tone) {
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

/** One JSON call that never throws: a missing route becomes a hint, not a crash. */
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
      /* 204 or a non-JSON error page */
    }
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: String(error) };
  }
}

function apiErrorText(result, fallback) {
  if (result.status === 0) return `sem conexão: ${result.error ?? "inalcançável"}`;
  if (result.status === 404) return "rota indisponível (404)";
  return result.data?.error?.message ?? `${fallback} (${result.status})`;
}

/* ------------------------------------------------------------------ */
/* message body rendering                                              */
/* ------------------------------------------------------------------ */

const BODY_TOKENS = new RegExp(
  `(?<gif>\\[gif:[a-z0-9_-]{1,24}\\])|(?<mention>@[a-z0-9_.-]{1,25})|(?<emoji>${EMOJI_RUN.source})`,
  "giu",
);

/**
 * The token a display name becomes inside a mention.
 *
 * A mention travels as plain text in the body and is matched by
 * `[a-z0-9_.-]{1,25}`, so a name with a space or an accent — "peixoto oficial",
 * "josé" — cannot be written as one verbatim. Folding it to that alphabet is
 * what lets someone be mentioned by the name they are shown under instead of by
 * an internal id nobody recognises.
 *
 * Returns "" when nothing survives the fold; callers fall back to the user id.
 */
function mentionHandle(name) {
  return (name ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 25);
}

/** Every form someone may legitimately be addressed by. */
function myMentionHandles() {
  const handles = new Set();
  if (session.userId) handles.add(session.userId.toLowerCase());
  if (session.name) {
    handles.add(session.name.toLowerCase());
    const folded = mentionHandle(session.name);
    if (folded) handles.add(folded);
  }
  return handles;
}

function mentionsMe(text) {
  if (!session.userId) return false;
  const needles = myMentionHandles();
  for (const match of text.matchAll(/@([a-z0-9_.-]{1,25})/gi)) {
    if (needles.has(match[1].toLowerCase())) return true;
  }
  return false;
}

/**
 * Builds the message body as DOM nodes. User text is only ever set through
 * `textContent`; the single `innerHTML` is a sticker this module authored.
 */
function renderBody(target, text) {
  target.replaceChildren();
  let cursor = 0;
  BODY_TOKENS.lastIndex = 0;

  for (const match of text.matchAll(BODY_TOKENS)) {
    const at = match.index ?? 0;
    if (at > cursor) target.append(document.createTextNode(text.slice(cursor, at)));
    cursor = at + match[0].length;
    const groups = match.groups ?? {};

    if (groups.gif) {
      const gif = lookupGif(match[0].slice(5, -1).toLowerCase());
      if (!gif) {
        target.append(document.createTextNode(match[0]));
        continue;
      }
      const holder = document.createElement("span");
      holder.className = "gif";
      holder.innerHTML = gif.svg;
      target.append(holder);
      continue;
    }

    if (groups.mention) {
      const handle = match[0].slice(1);
      const span = document.createElement("span");
      span.className = "mention";
      span.textContent = match[0];
      if (myMentionHandles().has(handle.toLowerCase())) span.classList.add("mention--me");
      target.append(span);
      continue;
    }

    const emote = document.createElement("span");
    emote.className = "emote";
    emote.textContent = match[0];
    target.append(emote);
  }

  if (cursor < text.length) target.append(document.createTextNode(text.slice(cursor)));
}

/* ------------------------------------------------------------------ */
/* the stream                                                          */
/* ------------------------------------------------------------------ */

function hideEmpty() {
  if (dom.streamEmpty.isConnected) dom.streamEmpty.remove();
}

function atBottom() {
  const el = dom.stream;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

function stickToBottom() {
  dom.stream.scrollTop = dom.stream.scrollHeight;
  dom.jump.hidden = true;
}

function appendRow(el) {
  hideEmpty();
  const stick = atBottom();
  dom.stream.append(el);
  while (dom.stream.children.length > MAX_RENDERED_MESSAGES) {
    dom.stream.firstElementChild?.remove();
  }
  if (stick) stickToBottom();
  else dom.jump.hidden = false;
}

/** History is older than anything on screen, so it goes above it. */
function prependRow(el) {
  hideEmpty();
  dom.stream.prepend(el);
  while (dom.stream.children.length > MAX_RENDERED_MESSAGES) {
    dom.stream.lastElementChild?.remove();
  }
}

function systemLine(text, tone) {
  const li = document.createElement("li");
  li.className = "sys";
  if (tone) li.dataset.tone = tone;
  li.textContent = text;
  appendRow(li);
}

function badgeFor(roles) {
  if (roles?.includes("admin")) return { cls: "msg__badge--admin", glyph: "★", label: "Admin" };
  if (roles?.includes("moderator")) return { cls: "msg__badge--mod", glyph: "⚔", label: "Moderador" };
  return null;
}

function iconButton(icon, tip, onClick, extraClass) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-btn${extraClass ? ` ${extraClass}` : ""}`;
  button.dataset.tip = tip;
  button.dataset.tipBelow = "";
  button.setAttribute("aria-label", tip);
  button.innerHTML = `<svg aria-hidden="true"><use href="#${icon}" /></svg>`;
  button.addEventListener("click", onClick);
  return button;
}

function createRow({ cid, author, userId, roles, ts, body, state, replyTo }) {
  const li = document.createElement("li");
  li.className = "msg";
  if (state === "pending") li.classList.add("msg--pending");
  if (mentionsMe(body)) li.classList.add("msg--mentioned");

  const row = {
    el: li,
    cid,
    id: null,
    userId: userId ?? "",
    author,
    pendingBody: state === "pending" ? body : null,
    reactions: new Map(),
    chips: new Map(),
  };

  if (replyTo) li.append(replyBlock(replyTo));

  const line = document.createElement("div");
  line.className = "msg__line";

  const time = document.createElement("span");
  time.className = "msg__ts";
  time.textContent = ts ? formatTime(ts) : "…";
  line.append(time);
  row.timeEl = time;

  const badge = badgeFor(roles);
  if (badge) {
    const chip = document.createElement("span");
    chip.className = `msg__badge ${badge.cls}`;
    chip.textContent = badge.glyph;
    chip.title = badge.label;
    line.append(chip);
  }

  const name = document.createElement("span");
  name.className = "msg__name";
  name.style.color = colorFor(userId || author);
  name.textContent = author;
  line.append(name);

  const sep = document.createElement("span");
  sep.className = "msg__sep";
  sep.textContent = ":";
  line.append(sep);

  const text = document.createElement("span");
  text.className = "msg__text";
  renderBody(text, body);
  line.append(text);
  row.bodyEl = text;

  li.append(line);

  const reactions = document.createElement("div");
  reactions.className = "msg__reactions";
  li.append(reactions);
  row.reactionsEl = reactions;

  return row;
}

function markRoomWide(row) {
  if (row.el.querySelector(".msg__wide")) return;
  const badge = document.createElement("span");
  badge.className = "msg__wide";
  badge.textContent = "para todos";
  badge.title = "Mensagem enviada a todas as sub-salas";
  row.bodyEl.before(badge);
}

/** Inserts or replaces the quoted parent above a row. */
function setReplyBlock(row, ref) {
  const existing = row.el.querySelector(".msg__reply");
  if (!ref) {
    existing?.remove();
    return;
  }
  const block = replyBlock(ref);
  if (existing) existing.replaceWith(block);
  else row.el.prepend(block);
}

function replyBlock(ref) {
  const wrap = document.createElement("div");
  wrap.className = "msg__reply";
  wrap.innerHTML = '<svg aria-hidden="true"><use href="#i-reply" /></svg>';
  const label = document.createElement("span");
  const who = document.createElement("b");
  who.textContent = ref.name;
  label.append("Respondendo a ", who, `: ${ref.body}`);
  wrap.append(label);
  return wrap;
}

function setNote(row, text, tone) {
  let note = row.noteEl;
  if (!note) {
    note = document.createElement("div");
    note.className = "msg__note";
    row.el.append(note);
    row.noteEl = note;
  }
  note.textContent = text;
  if (tone) note.dataset.tone = tone;
  else delete note.dataset.tone;
}

/**
 * Icon-only tools, revealed on hover or keyboard focus. Reply and react are for
 * everyone; delete, timeout and ban only exist for a moderator.
 */
function addTools(row) {
  if (row.toolsEl || !row.id) return;
  const tools = document.createElement("div");
  tools.className = "msg__tools";

  tools.append(
    iconButton("i-reply", "Responder", () => startReply(row)),
    iconButton("i-react", "Reagir", (event) => openReactStrip(row, event.currentTarget)),
  );

  if (isPrivileged()) {
    tools.append(
      iconButton("i-timeout", "Silenciar por 5 min", () => moderatorMute(row)),
      iconButton("i-trash", "Apagar mensagem", () => moderatorDelete(row), "icon-btn--danger"),
      iconButton("i-ban", "Banir usuário", () => moderatorBan(row), "icon-btn--danger"),
    );
  }

  row.el.append(tools);
  row.toolsEl = tools;
}

function bumpReaction(row, emoji, delta) {
  const next = (row.reactions.get(emoji) ?? 0) + delta;
  if (next <= 0) {
    row.reactions.delete(emoji);
    row.chips.get(emoji)?.remove();
    row.chips.delete(emoji);
    return;
  }
  row.reactions.set(emoji, next);
  let chip = row.chips.get(emoji);
  if (!chip) {
    chip = document.createElement("span");
    chip.className = "reaction";
    const glyph = document.createElement("span");
    glyph.textContent = emoji;
    const count = document.createElement("span");
    chip.append(glyph, count);
    chip.countEl = count;
    row.chips.set(emoji, chip);
    row.reactionsEl.append(chip);
  }
  chip.countEl.textContent = String(next);
}

function rowForId(id) {
  return rows.byId.get(id) ?? null;
}

/* ------------------------------------------------------------------ */
/* reply + reactions                                                   */
/* ------------------------------------------------------------------ */

function startReply(row) {
  // The excerpt is only for the optimistic row; the server's copy replaces it
  // the moment the message comes back through the fanout.
  session.replyTo = {
    id: row.id,
    name: row.author,
    userId: row.userId,
    body: row.bodyEl.textContent.slice(0, 120),
  };
  dom.replyChipName.textContent = row.author;
  dom.replyChip.hidden = false;
  // Twitch prefills the mention too, so the reply still reads as one in
  // clients that only see the text.
  const handle = `@${row.userId || row.author} `;
  if (!dom.body.value.startsWith(handle)) dom.body.value = handle + dom.body.value;
  dom.body.focus();
  autoGrow();
}

function cancelReply() {
  session.replyTo = null;
  dom.replyChip.hidden = true;
}

let openStrip = null;

function closeReactStrip() {
  openStrip?.remove();
  openStrip = null;
}

function openReactStrip(row, anchor) {
  closeReactStrip();
  const strip = document.createElement("div");
  strip.className = "react-strip";
  for (const emoji of QUICK_REACTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = emoji;
    button.setAttribute("aria-label", `Reagir com ${emoji}`);
    button.addEventListener("click", () => {
      sendReaction(row.id, emoji);
      closeReactStrip();
    });
    strip.append(button);
  }
  row.el.append(strip);
  openStrip = strip;
  strip.querySelector("button")?.focus();
  anchor?.setAttribute("aria-expanded", "true");
}

document.addEventListener("click", (event) => {
  if (openStrip && !openStrip.contains(event.target) && !event.target.closest(".msg__tools")) {
    closeReactStrip();
  }
});

/* ------------------------------------------------------------------ */
/* protocol handlers                                                   */
/* ------------------------------------------------------------------ */

function rememberChatter(userId, name) {
  if (!userId) return;
  chatters.set(userId, name || userId);
}

function onHello(msg) {
  session.userId = msg.userId;
  session.name = msg.name;
  session.roles = msg.roles ?? [];
  session.shardIndex = msg.shardIndex;
  session.attempt = 0;
  applyConfig(msg.config);
  dom.factUser.textContent = `${msg.name} (${msg.userId})`;
  dom.factShard.textContent = `#${msg.shardIndex}`;
  dom.subroomInput.value = String(msg.shardIndex);
  dom.modForm.hidden = !isPrivileged();
  dom.join.hidden = true;
  dom.leaveBtn.classList.toggle("is-invisible", session.anonymous);
  applyGate();
  if (!session.anonymous) {
    systemLine(`Você entrou como ${msg.name}.`);
  }
  refreshRanking();
  loadHistory();
}

function applyConfig(config) {
  session.config = config;
  dom.factConfig.textContent = `v${config.version}`;
  dom.body.maxLength = config.maxMessageLength;

  const notes = [];
  if (config.slowModeMs > 0) notes.push(`Modo lento: 1 mensagem a cada ${Math.round(config.slowModeMs / 1000)}s.`);
  if (config.closed) notes.push("A sala está fechada para novas mensagens.");
  dom.pinned.hidden = notes.length === 0;
  dom.pinnedBody.textContent = notes.join(" ");

  dom.slowPill.hidden = config.slowModeMs === 0;
  dom.slowPill.textContent = `lento ${Math.round(config.slowModeMs / 1000)}s`;

  if (document.activeElement !== dom.slowModeInput) {
    dom.slowModeInput.value = String(Math.round(config.slowModeMs / 1000));
  }
  if (document.activeElement !== dom.closedInput) dom.closedInput.checked = config.closed;
}

/**
 * The shard acks only after the coordinator round trip, so our own message
 * usually arrives back through the fanout *before* its ack. Without this the
 * optimistic row and the fanout copy would both stay on screen.
 */
function adoptPending(m) {
  if (m.userId !== session.userId) return null;
  for (const [cid, row] of rows.byCid) {
    if (row.pendingBody === m.body) {
      rows.byCid.delete(cid);
      return row;
    }
  }
  // Moderation may have rewritten the body; fall back to the oldest pending row.
  if (!m.masked) return null;
  const oldest = rows.byCid.entries().next();
  if (oldest.done) return null;
  rows.byCid.delete(oldest.value[0]);
  return oldest.value[1];
}

function onChat(m) {
  rememberChatter(m.userId, m.name);
  const known = rowForId(m.id) ?? adoptPending(m);
  if (known) {
    // Adopt the server's copy: a masked body or a rewritten name is what stays.
    renderBody(known.bodyEl, m.body);
    known.timeEl.textContent = formatTime(m.ts);
    known.userId = m.userId;
    known.pendingBody = null;
    known.el.classList.remove("msg--pending");
    setReplyBlock(known, m.replyTo ?? null);
    if (mentionsMe(m.body)) known.el.classList.add("msg--mentioned");
    if (!known.id) {
      known.id = m.id;
      rows.byId.set(m.id, known);
      addTools(known);
    }
    if (m.masked) setNote(known, "editada pela moderação", "error");
    if (m.roomWide) markRoomWide(known);
    return;
  }

  const row = createRow({
    cid: null,
    author: m.name,
    userId: m.userId,
    roles: m.roles,
    ts: m.ts,
    body: m.body,
    state: "live",
    replyTo: m.replyTo,
  });
  row.id = m.id;
  rows.byId.set(m.id, row);
  if (m.masked) setNote(row, "editada pela moderação", "error");
  if (m.roomWide) markRoomWide(row);
  addTools(row);
  appendRow(row.el);
}

function onAck(msg) {
  const row = rows.byCid.get(msg.cid);
  // The fanout may already have adopted this row; the ack is then only the
  // signal that starts the slow-mode countdown.
  if (!row) {
    startSlowModeCountdown(session.config?.slowModeMs ?? 0);
    return;
  }
  rows.byCid.delete(msg.cid);
  row.pendingBody = null;
  row.id = msg.id;
  row.userId = session.userId;
  row.el.classList.remove("msg--pending");
  row.timeEl.textContent = formatTime(msg.ts);
  rows.byId.set(msg.id, row);
  addTools(row);
  startSlowModeCountdown(session.config?.slowModeMs ?? 0);
}

function onRejected(msg) {
  const row = rows.byCid.get(msg.cid);
  const label = REJECT_LABELS[msg.code] ?? msg.code;
  const detail = msg.reason && msg.reason !== label ? ` — ${msg.reason}` : "";
  if (row) {
    rows.byCid.delete(msg.cid);
    row.el.classList.remove("msg--pending");
    row.el.classList.add("msg--rejected");
    row.timeEl.textContent = "✕";
    setNote(row, `${label}${detail}`, "error");
  } else {
    systemLine(`recusada: ${label}${detail}`, "error");
  }
  if (msg.retryAfterMs) startSlowModeCountdown(msg.retryAfterMs);
}

function onDelete(msg) {
  for (const id of msg.ids) {
    const row = rowForId(id);
    if (!row) continue;
    row.el.classList.add("msg--deleted");
    setNote(row, msg.reason ? `apagada: ${msg.reason}` : "apagada por um moderador", "error");
  }
}

function onReaction(msg) {
  const row = rowForId(msg.messageId);
  if (row) bumpReaction(row, msg.emoji, msg.count);
}

function onPresence(msg) {
  dom.viewers.textContent =
    session.config?.scope === "subroom" && typeof msg.sub === "number"
      ? `${msg.count} assistindo · sala #${session.shardIndex} · ${msg.sub} aqui`
      : String(msg.count);
}

/**
 * How much of the room this viewer is actually seeing.
 *
 * Counted over a rolling 10s window rather than shown per batch: a single
 * "3 dropped" tells you nothing, while "mostrando 20 de 340 msg/s" is the whole
 * story of a room too big to deliver in full.
 */
const sampling = { shown: 0, dropped: 0, since: 0 };

function onSampled(dropped) {
  sampling.dropped += dropped;
}

function noteShown(count) {
  sampling.shown += count;
}

function refreshSamplePill() {
  const now = Date.now();
  if (!sampling.since) sampling.since = now;
  const seconds = (now - sampling.since) / 1000;
  if (seconds < 2) return;
  const total = sampling.shown + sampling.dropped;
  if (sampling.dropped === 0) {
    dom.samplePill.hidden = true;
  } else {
    dom.samplePill.hidden = false;
    dom.samplePill.textContent = `mostrando ${Math.round(sampling.shown / seconds)} de ${Math.round(total / seconds)} msg/s`;
    dom.samplePill.title =
      "A sala recebe mais mensagens do que uma tela consegue mostrar, então cada espectador vê uma amostra. A sua própria mensagem nunca é amostrada.";
  }
  sampling.shown = 0;
  sampling.dropped = 0;
  sampling.since = now;
}

setInterval(refreshSamplePill, 2000);

function onSystem(msg) {
  systemLine(`${msg.code}${msg.reason ? ` — ${msg.reason}` : ""}`, "error");
  if (msg.code === "banned") {
    session.wanted = false;
    setNotice("Você foi banido desta sala.", "error");
  }
}

function onPong() {
  if (session.lastPingAt) {
    session.latencyMs = Date.now() - session.lastPingAt;
    dom.factPing.textContent = `${session.latencyMs} ms`;
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
  return apply(msg);
}

function apply(msg) {
  switch (msg.t) {
    // A coalesced window: the events inside are ordinary frames, in order.
    case "batch": {
      if (msg.dropped > 0) onSampled(msg.dropped);
      for (const inner of msg.events) apply(inner);
      return undefined;
    }
    case "hello": return onHello(msg);
    case "msg":
      noteShown(1);
      return onChat(msg.m);
    case "ack": return onAck(msg);
    case "rejected": return onRejected(msg);
    case "delete": return onDelete(msg);
    case "reaction": return onReaction(msg);
    case "presence": return onPresence(msg);
    case "config": return applyConfig(msg.config);
    case "sys": return onSystem(msg);
    case "pong": return onPong(msg);
    // The protocol is additive: an unknown frame is ignored, never fatal.
    default: return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* history                                                             */
/* ------------------------------------------------------------------ */

async function loadHistory() {
  const roomId = session.roomId;
  const result = await api(
    "GET",
    `/api/rooms/${encodeURIComponent(roomId)}/messages?limit=${HISTORY_LIMIT}${session.config?.scope === "subroom" ? `&sub=${session.shardIndex}` : ""}`,
  );
  if (!result.ok || session.roomId !== roomId) return;
  const messages = result.data?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;

  // The API answers newest first, so prepending in that order leaves the oldest
  // at the top whatever arrived over the socket meanwhile.
  for (const m of messages) {
    if (!m?.id || rowForId(m.id)) continue;
    rememberChatter(m.userId, m.name);
    const row = createRow({
      cid: null,
      author: m.name,
      userId: m.userId,
      roles: m.roles,
      ts: m.ts,
      body: m.body,
      state: "history",
      replyTo: m.replyTo,
    });
    row.id = m.id;
    rows.byId.set(m.id, row);
    if (m.masked) setNote(row, "editada pela moderação", "error");
    if (m.roomWide) markRoomWide(row);
    addTools(row);
    prependRow(row.el);
  }
  stickToBottom();
}

/* ------------------------------------------------------------------ */
/* connection                                                          */
/* ------------------------------------------------------------------ */

async function mintToken() {
  const roles = session.anonymous || !dom.moderator.checked ? [] : ["moderator"];
  const name = session.anonymous ? "Anônimo" : dom.name.value.trim() || "convidado";
  const result = await api("POST", "/api/dev/token", {
    body: { userId: session.userId || name, name, roles },
  });
  if (!result.ok || !result.data?.token) {
    setHint(dom.joinHint, `não foi possível entrar — ${apiErrorText(result, "falhou")}`, "error");
    return false;
  }
  session.token = result.data.token;
  session.name = result.data.identity?.name ?? name;
  session.userId = result.data.identity?.userId ?? name;
  session.roles = result.data.identity?.roles ?? roles;
  session.tokenExpiresAt = (result.data.identity?.expiresAt ?? 0) * 1000;
  return true;
}

function socketUrl() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${scheme}//${location.host}/ws/${encodeURIComponent(session.roomId)}`);
  url.searchParams.set("token", session.token);
  if (session.selectedSub !== null) url.searchParams.set("sub", String(session.selectedSub));
  return url.toString();
}

function setComposerEnabled(enabled) {
  const allowed = enabled && !session.anonymous;
  dom.body.disabled = !allowed;
  dom.send.disabled = !allowed;
  dom.pickerBtn.disabled = !allowed;
}

/** Anonymous: show the nickname gate instead of the input. */
function applyGate() {
  dom.gate.hidden = !session.anonymous;
  dom.composer.hidden = session.anonymous;
  dom.charCount.hidden = session.anonymous;
  dom.send.hidden = session.anonymous;
  dom.slowPill.hidden = session.anonymous || !(session.config?.slowModeMs > 0);
  setComposerEnabled(session.ws?.readyState === WebSocket.OPEN);
}

async function openSocket() {
  if (!session.wanted) return;
  clearTimeout(session.reconnectTimer);

  const expiringSoon = session.tokenExpiresAt - Date.now() < TOKEN_REFRESH_MARGIN_MS;
  if (!session.token || expiringSoon) {
    if (!(await mintToken())) return scheduleReconnect();
  }

  setNotice(session.attempt === 0 ? "Conectando…" : "Reconectando…");
  let ws;
  try {
    ws = new WebSocket(socketUrl());
  } catch (error) {
    setNotice(`Não foi possível abrir o socket: ${String(error)}`, "error");
    return scheduleReconnect();
  }
  session.ws = ws;

  ws.addEventListener("message", (event) => {
    if (session.ws === ws) dispatch(event.data);
  });

  ws.addEventListener("open", () => {
    session.attempt = 0;
    setNotice("");
    setComposerEnabled(true);
    applyGate();
    startPing();
    startRankingRefresh();
  });

  ws.addEventListener("close", (event) => {
    // A socket we replaced on purpose (signing in, signing out) is not a drop.
    if (session.ws !== ws) return;
    stopPing();
    stopRankingRefresh();
    session.ws = null;
    setComposerEnabled(false);
    if (!session.wanted) return;
    systemLine(`Conexão perdida (${event.code}${event.reason ? `: ${event.reason}` : ""}).`);
    scheduleReconnect();
  });

  // The close event always follows an error and owns the reconnect decision.
  ws.addEventListener("error", () => {
    if (session.ws === ws) setNotice("Erro de conexão.", "error");
  });
}

function scheduleReconnect() {
  if (!session.wanted) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** session.attempt);
  // Jitter keeps a room full of demo tabs from reconnecting in lockstep.
  const wait = delay + Math.floor(Math.random() * 250);
  session.attempt += 1;
  setNotice(`Reconectando em ${Math.ceil(wait / 1000)}s…`);
  clearTimeout(session.reconnectTimer);
  session.reconnectTimer = setTimeout(() => void openSocket(), wait);
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

function resetStream() {
  rows.byCid.clear();
  rows.byId.clear();
  chatters.clear();
  dom.stream.replaceChildren();
}

/**
 * Opens the socket for whoever `session` currently describes. Anyone landing on
 * the link starts here as an anonymous viewer; picking a nickname runs it again
 * with a real identity.
 */
async function connectAs({ anonymous, userId }) {
  closeSocket();
  resetStream();
  session.selectedSub = null;
  session.anonymous = anonymous;
  session.roomId = ROOM_ID;
  session.userId = userId;
  session.token = "";
  session.attempt = 0;
  session.wanted = true;
  applyGate();
  await openSocket();
}

function closeSocket() {
  session.wanted = false;
  clearTimeout(session.reconnectTimer);
  stopPing();
  stopRankingRefresh();
  try {
    session.ws?.close(1000, "saiu da sala");
  } catch {
    /* already closed */
  }
  session.ws = null;
  setComposerEnabled(false);
  setNotice("");
}

/* ------------------------------------------------------------------ */
/* sending                                                             */
/* ------------------------------------------------------------------ */

function startSlowModeCountdown(ms) {
  if (!ms || isPrivileged()) return;
  const until = Date.now() + ms;
  clearInterval(session.slowModeTimer);
  const tick = () => {
    const left = until - Date.now();
    if (left <= 0) {
      clearInterval(session.slowModeTimer);
      session.slowModeTimer = 0;
      dom.send.disabled = session.ws?.readyState !== WebSocket.OPEN;
      dom.send.textContent = "Chat";
      return;
    }
    dom.send.disabled = true;
    dom.send.textContent = `${Math.ceil(left / 1000)}s`;
  };
  tick();
  session.slowModeTimer = setInterval(tick, 200);
}

function sendMessage(body) {
  if (session.ws?.readyState !== WebSocket.OPEN) return;
  const cid = newCid();
  const replyTo = session.replyTo;
  const row = createRow({
    cid,
    author: session.name,
    userId: session.userId,
    roles: session.roles,
    ts: 0,
    body,
    state: "pending",
    replyTo: replyTo ? { id: replyTo.id, name: replyTo.name, body: replyTo.body ?? "" } : null,
  });
  rows.byCid.set(cid, row);
  appendRow(row.el);
  const frame = { t: "send", cid, body };
  if (replyTo?.id) frame.replyTo = replyTo.id;
  session.ws.send(JSON.stringify(frame));
  cancelReply();
}

function sendReaction(messageId, emoji) {
  if (!messageId || session.ws?.readyState !== WebSocket.OPEN) return;
  session.ws.send(JSON.stringify({ t: "react", cid: newCid(), messageId, emoji }));
}

function autoGrow() {
  dom.body.style.height = "auto";
  dom.body.style.height = `${Math.min(dom.body.scrollHeight, 100)}px`;
  const max = session.config?.maxMessageLength ?? 500;
  const used = dom.body.value.length;
  dom.charCount.textContent = used > max - 80 ? `${used}/${max}` : "";
}

/* ------------------------------------------------------------------ */
/* @ mention autocomplete                                              */
/* ------------------------------------------------------------------ */

let mentionState = null;

function closeMentionMenu() {
  mentionState = null;
  dom.mentionMenu.hidden = true;
  dom.mentionMenu.replaceChildren();
}

function openMentionMenu() {
  const value = dom.body.value;
  const caret = dom.body.selectionStart ?? value.length;
  const upto = value.slice(0, caret);
  const match = /(^|\s)@([a-z0-9_.-]*)$/i.exec(upto);
  if (!match) return closeMentionMenu();

  const query = match[2].toLowerCase();
  const hits = [...chatters.entries()]
    .filter(([userId, name]) =>
      userId.toLowerCase().includes(query) || name.toLowerCase().includes(query),
    )
    .slice(0, 6);
  if (hits.length === 0) return closeMentionMenu();

  mentionState = { start: caret - match[2].length - 1, end: caret, index: 0, hits };
  dom.mentionMenu.replaceChildren();
  hits.forEach(([userId, name], i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(i === 0));
    const dot = document.createElement("span");
    dot.textContent = name;
    dot.style.color = colorFor(userId);
    button.append(dot);
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      applyMention(i);
    });
    dom.mentionMenu.append(button);
  });
  dom.mentionMenu.hidden = false;
}

function highlightMention(delta) {
  if (!mentionState) return;
  const buttons = [...dom.mentionMenu.children];
  buttons[mentionState.index]?.setAttribute("aria-selected", "false");
  mentionState.index = (mentionState.index + delta + buttons.length) % buttons.length;
  buttons[mentionState.index]?.setAttribute("aria-selected", "true");
  buttons[mentionState.index]?.scrollIntoView({ block: "nearest" });
}

function applyMention(index) {
  if (!mentionState) return;
  const [userId, name] = mentionState.hits[index ?? mentionState.index];
  const value = dom.body.value;
  // The menu shows the display name, so that is what has to land in the box —
  // inserting the internal id put a string nobody recognises into the message.
  const inserted = `@${mentionHandle(name) || userId} `;
  dom.body.value = value.slice(0, mentionState.start) + inserted + value.slice(mentionState.end);
  const caret = mentionState.start + inserted.length;
  dom.body.setSelectionRange(caret, caret);
  closeMentionMenu();
  dom.body.focus();
  autoGrow();
}

/* ------------------------------------------------------------------ */
/* emote + gif picker                                                  */
/* ------------------------------------------------------------------ */

function recentEmotes() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_EMOTES_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.slice(0, 21) : [];
  } catch {
    return [];
  }
}

function rememberEmote(glyph) {
  const next = [glyph, ...recentEmotes().filter((g) => g !== glyph)].slice(0, 21);
  try {
    localStorage.setItem(RECENT_EMOTES_KEY, JSON.stringify(next));
  } catch {
    /* private mode: recents just do not persist */
  }
}

function insertAtCaret(text) {
  const value = dom.body.value;
  const caret = dom.body.selectionStart ?? value.length;
  dom.body.value = value.slice(0, caret) + text + value.slice(dom.body.selectionEnd ?? caret);
  const next = caret + text.length;
  dom.body.setSelectionRange(next, next);
  dom.body.focus();
  autoGrow();
}

function emoteGrid(emotes) {
  const grid = document.createElement("div");
  grid.className = "picker__grid";
  for (const emote of emotes) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = emote.glyph;
    button.title = `:${emote.code}:`;
    button.setAttribute("aria-label", emote.code);
    button.addEventListener("click", () => {
      insertAtCaret(emote.glyph);
      rememberEmote(emote.glyph);
    });
    grid.append(button);
  }
  return grid;
}

function groupTitle(text) {
  const title = document.createElement("p");
  title.className = "picker__group-title";
  title.textContent = text;
  return title;
}

function renderPicker() {
  dom.pickerScroll.replaceChildren();
  dom.pickerRail.replaceChildren();

  if (session.pickerTab === "gifs") {
    const grid = document.createElement("div");
    grid.className = "picker__grid picker__grid--gifs";
    for (const gif of GIF_SET) {
      const button = document.createElement("button");
      button.type = "button";
      button.title = gif.label;
      button.setAttribute("aria-label", gif.label);
      button.innerHTML = gif.svg;
      button.addEventListener("click", () => {
        insertAtCaret(`[gif:${gif.id}] `);
        closePicker();
      });
      grid.append(button);
    }
    dom.pickerScroll.append(groupTitle("Stickers da sala"), grid);
    return;
  }

  const query = dom.pickerSearch.value;
  const found = searchEmotes(query);
  if (found) {
    dom.pickerScroll.append(groupTitle(`Resultados para "${query.trim()}"`));
    if (found.length === 0) {
      const empty = document.createElement("p");
      empty.className = "picker__empty";
      empty.textContent = "Nenhum emote com esse nome.";
      dom.pickerScroll.append(empty);
    } else {
      dom.pickerScroll.append(emoteGrid(found));
    }
    return;
  }

  const recents = recentEmotes();
  const groups = [
    ...(recents.length
      ? [{ id: "recent", label: "Usados recentemente", icon: "🕘", emotes: recents.map((g) => ({ code: g, glyph: g })) }]
      : []),
    ...EMOTE_SETS,
  ];

  for (const group of groups) {
    const section = document.createElement("section");
    section.id = `emote-group-${group.id}`;
    section.append(groupTitle(group.label), emoteGrid(group.emotes));
    dom.pickerScroll.append(section);

    const railButton = document.createElement("button");
    railButton.type = "button";
    railButton.textContent = group.icon;
    railButton.title = group.label;
    railButton.setAttribute("aria-label", group.label);
    railButton.setAttribute("aria-current", String(group.id === session.pickerGroup));
    railButton.addEventListener("click", () => {
      session.pickerGroup = group.id;
      section.scrollIntoView({ block: "start", behavior: "smooth" });
      for (const other of dom.pickerRail.children) other.setAttribute("aria-current", "false");
      railButton.setAttribute("aria-current", "true");
    });
    dom.pickerRail.append(railButton);
  }
}

function openPicker() {
  dom.settings.hidden = true;
  dom.settingsBtn.setAttribute("aria-expanded", "false");
  dom.picker.hidden = false;
  dom.pickerBtn.setAttribute("aria-expanded", "true");
  renderPicker();
  dom.pickerSearch.focus();
}

function closePicker() {
  dom.picker.hidden = true;
  dom.pickerBtn.setAttribute("aria-expanded", "false");
  dom.body.focus();
}

/* ------------------------------------------------------------------ */
/* ranking                                                             */
/* ------------------------------------------------------------------ */

/** Strip when collapsed, full standing when open — one dataset, two shapes. */
function renderLeaderboard(snapshot) {
  const entries = snapshot?.top ?? [];
  dom.board.hidden = entries.length === 0;
  if (entries.length === 0) return;

  dom.boardStripList.replaceChildren();
  for (const [index, entry] of entries.slice(0, 8).entries()) {
    const li = document.createElement("li");
    const rank = document.createElement("span");
    rank.className = "board__rank";
    rank.textContent = String(index + 1);
    const who = document.createElement("span");
    who.className = "board__name";
    who.textContent = entry.name ?? entry.userId;
    who.style.color = colorFor(entry.userId ?? entry.name ?? "");
    const score = document.createElement("span");
    score.className = "board__score";
    score.textContent = String(entry.score ?? entry.messages ?? 0);
    li.append(rank, who, score);
    dom.boardStripList.append(li);
  }

  dom.boardList.replaceChildren();
  for (const [index, entry] of entries.slice(0, 20).entries()) {
    const place = index + 1;
    const li = document.createElement("li");
    li.className = "board__row";

    if (place <= 3) {
      const medal = document.createElement("span");
      medal.className = "board__medal";
      medal.dataset.place = String(place);
      medal.textContent = String(place);
      li.append(medal);
    } else {
      const number = document.createElement("span");
      number.className = "board__place";
      number.textContent = String(place);
      li.append(number);
    }

    const who = document.createElement("span");
    who.className = "board__who";
    who.textContent = entry.name ?? entry.userId;
    who.style.color = colorFor(entry.userId ?? entry.name ?? "");

    const metric = document.createElement("span");
    metric.className = "board__metric";
    metric.innerHTML = '<svg aria-hidden="true"><use href="#i-bubble" /></svg>';
    const count = document.createElement("span");
    count.textContent = String(entry.score ?? entry.messages ?? 0);
    metric.append(count);

    li.title = `${entry.messages ?? 0} mensagens, ${entry.reactions ?? 0} reações`;
    li.append(who, metric);
    dom.boardList.append(li);
  }

  const windowMinutes = Math.round((snapshot?.windowMs ?? 900_000) / 60_000);
  dom.boardSub.textContent = `Últimos ${windowMinutes} minutos`;
}

function toggleBoard(open) {
  const next = open ?? dom.boardPanel.hidden;
  dom.boardPanel.hidden = !next;
  // The panel carries its own title, so the strip would only repeat itself.
  dom.boardToggle.hidden = next;
  dom.boardToggle.setAttribute("aria-expanded", String(next));
  if (!next) dom.boardToggle.focus();
}

async function refreshRanking() {
  if (!session.roomId) return;
  const result = await api("GET", `/api/rooms/${encodeURIComponent(session.roomId)}/ranking`);
  if (!result.ok) {
    dom.board.hidden = true;
    return;
  }
  renderLeaderboard(result.data?.ranking ?? result.data?.snapshot ?? result.data);
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

async function applyRoomConfig(event) {
  event.preventDefault();
  const seconds = Number.parseInt(dom.slowModeInput.value, 10);
  const result = await api("PATCH", `/api/rooms/${encodeURIComponent(session.roomId)}/config`, {
    body: {
      slowModeMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
      closed: dom.closedInput.checked,
    },
    auth: true,
  });
  if (!result.ok) {
    setHint(dom.settingsHint, `não aplicado — ${apiErrorText(result, "falhou")}`, "error");
    return;
  }
  setHint(dom.settingsHint, "Configuração aplicada.", "ok");
  // The coordinator fans a `config` event out too; this only avoids the wait.
  if (result.data?.config) applyConfig(result.data.config);
}

async function moderatorDelete(row) {
  const result = await api(
    "POST",
    `/api/rooms/${encodeURIComponent(session.roomId)}/moderation/delete`,
    { body: { messageIds: [row.id], reason: "removida por um moderador" }, auth: true },
  );
  toast(result.ok ? "Mensagem apagada." : `Falhou — ${apiErrorText(result, "erro")}`);
}

async function moderatorBan(row) {
  const result = await api("POST", `/api/rooms/${encodeURIComponent(session.roomId)}/bans`, {
    body: { userId: row.userId, reason: "banido por um moderador" },
    auth: true,
  });
  toast(result.ok ? `${row.author} foi banido.` : `Falhou — ${apiErrorText(result, "erro")}`);
}

async function moderatorMute(row) {
  const result = await api(
    "POST",
    `/api/rooms/${encodeURIComponent(session.roomId)}/moderation/mute`,
    { body: { userId: row.userId, ms: 300_000, reason: "silenciado por um moderador" }, auth: true },
  );
  toast(result.ok ? `${row.author} silenciado por 5 min.` : `Falhou — ${apiErrorText(result, "erro")}`);
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

dom.joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = dom.name.value.trim();
  if (!name) return;
  setHint(dom.joinHint, "Entrando…");
  await connectAs({ anonymous: false, userId: name });
});

dom.boardToggle.addEventListener("click", () => toggleBoard());
dom.boardCollapse.addEventListener("click", () => toggleBoard(false));

dom.gateBtn.addEventListener("click", () => {
  dom.picker.hidden = true;
  dom.settings.hidden = true;
  dom.join.hidden = false;
  dom.name.focus();
});

dom.joinClose.addEventListener("click", () => {
  dom.join.hidden = true;
});

dom.leaveBtn.addEventListener("click", () => {
  void watchAnonymously();
  systemLine("Você voltou a assistir como anônimo.");
});

dom.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const body = dom.body.value.trim();
  if (!body) return;
  sendMessage(body);
  dom.body.value = "";
  autoGrow();
  dom.body.focus();
});

dom.body.addEventListener("keydown", (event) => {
  if (mentionState && !dom.mentionMenu.hidden) {
    if (event.key === "ArrowDown") return event.preventDefault(), highlightMention(1);
    if (event.key === "ArrowUp") return event.preventDefault(), highlightMention(-1);
    if (event.key === "Enter" || event.key === "Tab") return event.preventDefault(), applyMention();
    if (event.key === "Escape") return closeMentionMenu();
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    dom.composer.requestSubmit();
  }
  if (event.key === "Escape" && session.replyTo) cancelReply();
});

dom.body.addEventListener("input", () => {
  autoGrow();
  openMentionMenu();
});

dom.body.addEventListener("blur", () => setTimeout(closeMentionMenu, 120));

dom.replyCancel.addEventListener("click", cancelReply);
dom.jump.addEventListener("click", stickToBottom);
dom.stream.addEventListener("scroll", () => {
  if (atBottom()) dom.jump.hidden = true;
});

dom.pickerBtn.addEventListener("click", () => {
  if (dom.picker.hidden) openPicker();
  else closePicker();
});
dom.pickerClose.addEventListener("click", closePicker);
dom.pickerSearch.addEventListener("input", renderPicker);

for (const tab of [dom.tabEmotes, dom.tabGifs]) {
  tab.addEventListener("click", () => {
    session.pickerTab = tab.dataset.tab;
    for (const other of [dom.tabEmotes, dom.tabGifs]) {
      const active = other === tab;
      other.classList.toggle("is-active", active);
      other.setAttribute("aria-selected", String(active));
    }
    renderPicker();
  });
}

dom.settingsBtn.addEventListener("click", () => {
  const opening = dom.settings.hidden;
  dom.picker.hidden = true;
  dom.pickerBtn.setAttribute("aria-expanded", "false");
  dom.settings.hidden = !opening;
  dom.settingsBtn.setAttribute("aria-expanded", String(opening));
});
dom.settingsClose.addEventListener("click", () => {
  dom.settings.hidden = true;
  dom.settingsBtn.setAttribute("aria-expanded", "false");
});
dom.modForm.addEventListener("submit", applyRoomConfig);
dom.subroomInput.addEventListener("change", () => {
  if (!isPrivileged()) return;
  const next = Number(dom.subroomInput.value);
  if (!Number.isInteger(next) || next < 0 || next === session.shardIndex) return;
  session.selectedSub = next;
  resetStream();
  const previous = session.ws;
  session.ws = null;
  previous?.close(1000, "mudando de sub-sala");
  void openSocket();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!dom.picker.hidden) return closePicker();
  if (!dom.settings.hidden) {
    dom.settings.hidden = true;
    dom.settingsBtn.setAttribute("aria-expanded", "false");
  }
});

window.addEventListener("beforeunload", () => {
  session.wanted = false;
  session.ws?.close();
});

/**
 * Landing on the link is enough to read the room: connect as a throwaway
 * anonymous identity, which is also what gives the viewer a shard and a place
 * in the presence count.
 */
async function watchAnonymously() {
  await connectAs({
    anonymous: true,
    userId: `anon-${Math.random().toString(36).slice(2, 10)}`,
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!dom.join.hidden) dom.join.hidden = true;
  else if (!dom.boardPanel.hidden) toggleBoard(false);
});

applyGate();
autoGrow();

/*
 * The console reads the room over HTTP and knows nothing about the socket, so
 * it is handed the two live facts only this file has: the token that decides
 * whether the audit column is allowed to name people, and the round trip the
 * socket last measured.
 */
mountConsole({
  roomId: ROOM_ID,
  context: () => ({ token: session.token, pingMs: session.latencyMs }),
  onRequestModerator: () => {
    dom.picker.hidden = true;
    dom.settings.hidden = true;
    dom.join.hidden = false;
    dom.moderator.checked = true;
    dom.name.focus();
  },
});

void watchAnonymously();
