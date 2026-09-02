/*
 * The observability console: the two columns the chat cannot show about itself.
 *
 * Everything here is read-only and driven by one endpoint. The server does a
 * fan-in over the room's shards and answers with the audit delta *and* the
 * live counters in the same payload, because both need the same round trip —
 * so this file polls once and paints twice.
 *
 * It is honest about being a poll: the header says "atualiza a cada 1s" rather
 * than implying a push. A WebSocket would not be fresher — the events live in
 * shard memory and something has to go ask.
 */

const POLL_ACTIVE_MS = 1_000;
const POLL_IDLE_MS = 5_000;
/** Cloudflare's analytics buckets by the minute; polling faster burns quota. */
const POLL_CLOUDFLARE_MS = 60_000;
/** Identical decisions inside this window collapse into one counted row. */
const COALESCE_WINDOW_MS = 3_000;
const MAX_ROWS = 500;
const SPARK_SAMPLES = 60;
const SPARK_W = 300;
const SPARK_H = 68;

/**
 * Four categories, not seven kinds. The hues were validated for colour-vision
 * deficiency against the white surface; `lifecycle` is a deliberate neutral
 * carrying an icon rather than a hue, so it never competes with the three that
 * mean something went differently than planned.
 */
const CATEGORIES = {
  lifecycle: { label: "Conexões", color: "var(--dim)", wash: "var(--panel-3)" },
  reject: { label: "Rejeições", color: "#d92d20", wash: "#fdecea" },
  shadow: { label: "Shadow", color: "#0e9384", wash: "#e6f6f4" },
  moderation: { label: "Moderação", color: "#7e62f0", wash: "var(--brand-wash)" },
};

const KIND_CATEGORY = {
  connect: "lifecycle",
  disconnect: "lifecycle",
  reject: "reject",
  shadow: "shadow",
  mute: "moderation",
  kick: "moderation",
  delete: "moderation",
};

const KIND_LABEL = {
  connect: "entrou",
  disconnect: "saiu",
  reject: "rejeitada",
  shadow: "shadow",
  mute: "mute",
  kick: "kick",
  delete: "delete",
};

const VERDICT = {
  ok: { icon: "#i-check-circle", head: "Chat em pleno funcionamento" },
  warn: { icon: "#i-alert", head: "Funcionando com ressalvas" },
  down: { icon: "#i-down-circle", head: "Sala fora do ar" },
};

const $ = (id) => document.getElementById(id);

const el = {
  console: $("console"),
  tabs: $("console-tabs"),
  auditSub: $("audit-sub"),
  auditFilters: $("audit-filters"),
  auditList: $("audit-list"),
  auditEmpty: $("audit-empty"),
  lock: $("audit-lock"),
  lockText: $("audit-lock-text"),
  opsSub: $("ops-sub"),
  verdict: $("verdict"),
  verdictIcon: $("verdict-icon"),
  verdictHead: $("verdict-head"),
  verdictChecks: $("verdict-checks"),
  tiles: $("tiles"),
  sparkArea: $("spark-area"),
  sparkLine: $("spark-line"),
  sparkCursor: $("spark-cursor"),
  sparkMarker: $("spark-marker"),
  sparkTip: $("spark-tip"),
  sparkBox: $("spark"),
  sparkNow: $("spark-now"),
  sparkPeak: $("spark-peak"),
  shardsBody: $("shards-body"),
  shardsNote: $("shards-note"),
  shardsEmpty: $("shards-empty"),
  cfNote: $("cf-note"),
  cfBody: $("cf-body"),
  loadtest: $("loadtest"),
  loadtestNote: $("loadtest-note"),
  loadtestFill: $("loadtest-fill"),
  loadtestBody: $("loadtest-body"),
};

const state = {
  roomId: "",
  cursor: "",
  rows: 0,
  /** signature -> live row, so a repeat bumps a counter instead of adding a line. */
  live: new Map(),
  hidden: new Set(),
  samples: [],
  /** shardIndex -> accepted count at the previous poll. */
  lastByShard: new Map(),
  lastAt: 0,
  timer: 0,
  cloudflareTimer: 0,
  frozen: null,
  context: null,
};

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

function clockOf(ts) {
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function compact(value) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Cloudflare reports cpuTime and wallTime in microseconds (confirmed against
 * the GraphQL schema's own field descriptions). A hibernating WebSocket
 * Durable Object stays open for seconds, so a fixed unit is unreadable at one
 * end or the other of that range — the unit follows the magnitude.
 */
function micros(value) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value < 1_000) return `${Math.round(value)} µs`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} ms`;
  return `${(value / 1_000_000).toFixed(2)} s`;
}

function bytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB"];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/* ------------------------------------------------------------------ */
/* the audit feed                                                      */
/* ------------------------------------------------------------------ */

function buildFilters() {
  for (const [key, meta] of Object.entries(CATEGORIES)) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.setAttribute("aria-pressed", "true");
    chip.dataset.cat = key;
    chip.innerHTML = `<span class="chip__dot" style="--kind:${meta.color}"></span>${meta.label}`;
    chip.addEventListener("click", () => {
      const on = chip.getAttribute("aria-pressed") === "true";
      chip.setAttribute("aria-pressed", on ? "false" : "true");
      if (on) state.hidden.add(key);
      else state.hidden.delete(key);
      el.auditList.dataset.off = [...state.hidden].join(" ");
    });
    el.auditFilters.append(chip);
  }
}

/** The signature that decides whether a new event is "the same thing again". */
function signatureOf(event) {
  return [event.kind, event.gate ?? "", event.code ?? "", event.userId].join("|");
}

function entryRow(event) {
  const category = KIND_CATEGORY[event.kind] ?? "lifecycle";
  const meta = CATEGORIES[category];
  const row = document.createElement("li");
  row.className = category === "lifecycle" ? "entry entry--muted" : "entry";
  row.dataset.cat = category;
  row.style.setProperty("--kind", meta.color);
  row.style.setProperty("--kind-wash", meta.wash);

  const time = document.createElement("span");
  time.className = "entry__time";
  time.textContent = clockOf(event.ts);

  const dot = document.createElement("span");
  dot.className = "entry__dot";

  const body = document.createElement("div");
  body.className = "entry__body";

  const line = document.createElement("div");
  line.className = "entry__line";

  // The gate name is spelled out, so the colour is never the only signal.
  const gate = document.createElement("span");
  gate.className = "entry__gate";
  gate.textContent = event.gate || KIND_LABEL[event.kind] || event.kind;

  const user = document.createElement("span");
  user.className = "entry__user";
  user.textContent = event.name || event.userId;

  line.append(gate, user);

  const shard = document.createElement("span");
  shard.className = "entry__shard";
  shard.textContent = `#${event.shardIndex}`;
  line.append(shard);
  body.append(line);

  const detail = [KIND_LABEL[event.kind], event.reason].filter(Boolean).join(" · ");
  if (detail) {
    const reason = document.createElement("span");
    reason.className = "entry__reason";
    reason.textContent =
      event.count && event.count > 1 ? `${detail} (${event.count} itens)` : detail;
    body.append(reason);
  }

  const counter = document.createElement("span");
  counter.className = "entry__count";
  counter.hidden = true;
  counter.textContent = "×1";

  row.append(time, dot, body, counter);
  row.__counter = counter;
  return row;
}

function pushEvent(event) {
  const signature = signatureOf(event);
  const open = state.live.get(signature);
  /*
   * Under load the same gate refuses a dozen users in rotation, so the repeats
   * are never adjacent — matching only against the newest row would collapse
   * nothing. Every row still inside the coalescing window stays addressable,
   * and a repeat bumps its counter in place rather than jumping to the top,
   * which would make the column impossible to read while it moves.
   */
  if (open && event.ts - open.ts < COALESCE_WINDOW_MS) {
    open.times += 1;
    open.ts = event.ts;
    open.row.__counter.hidden = false;
    open.row.__counter.textContent = `×${open.times}`;
    // The row's own clock stays at the first occurrence so the column reads
    // top-to-bottom in time; recency lives on the counter, which is where a
    // reader looks to see whether it is still happening.
    open.row.__counter.title = `última às ${clockOf(event.ts)}`;
    return;
  }

  const row = entryRow(event);
  el.auditList.prepend(row);
  state.live.set(signature, { ts: event.ts, times: 1, row });
  state.rows += 1;

  // The map only has to cover one window; sweeping in bulk keeps the push path
  // O(1) amortised instead of scanning on every event.
  if (state.live.size > 256) {
    const cutoff = event.ts - COALESCE_WINDOW_MS;
    for (const [key, entry] of state.live) {
      if (entry.ts < cutoff) state.live.delete(key);
    }
  }

  while (state.rows > MAX_ROWS) {
    el.auditList.lastElementChild?.remove();
    state.rows -= 1;
  }
  el.auditEmpty.hidden = true;
}

function noteGap(dropped) {
  const gap = document.createElement("li");
  gap.className = "audit__gap";
  gap.textContent = `${dropped} evento(s) perderam a janela do shard — o buffer é volátil e cabe ${dropped > 250 ? "menos" : "pouco"} mais que isto.`;
  el.auditList.prepend(gap);
  state.live.clear();
  state.rows += 1;
}

/* ------------------------------------------------------------------ */
/* the panel                                                           */
/* ------------------------------------------------------------------ */

function renderVerdict(health) {
  const meta = VERDICT[health.level] ?? VERDICT.down;
  el.verdict.dataset.level = health.level;
  el.verdictIcon.firstElementChild.setAttribute("href", meta.icon);
  el.verdictHead.textContent = meta.head;
  el.verdictChecks.replaceChildren(
    ...health.checks.map((check) => {
      const item = document.createElement("li");
      item.className = "verdict__check";
      item.dataset.level = check.level;
      const label = document.createElement("b");
      label.textContent = `${check.label}:`;
      item.append(label, document.createTextNode(` ${check.detail}`));
      return item;
    }),
  );
}

function tile(label, value, foot, tone) {
  const box = document.createElement("div");
  box.className = "tile";
  if (tone) box.dataset.tone = tone;
  const name = document.createElement("div");
  name.className = "tile__label";
  name.textContent = label;
  const number = document.createElement("div");
  number.className = "tile__value";
  number.textContent = value;
  box.append(name, number);
  if (foot) {
    const note = document.createElement("div");
    note.className = "tile__foot";
    note.textContent = foot;
    box.append(note);
  }
  return box;
}

function renderTiles(snapshot) {
  const { totals, stats } = snapshot;
  const stalledPersistence =
    snapshot.health.checks.find((check) => check.id === "persistence")?.level !== "ok";
  const inbound = totals.accepted + totals.rejected;
  const rejectShare = inbound === 0 ? 0 : (totals.rejected / inbound) * 100;
  el.tiles.replaceChildren(
    tile("Conexões", compact(totals.connections), `coordinator vê ${compact(totals.coordinatorConnections)}`),
    tile("Aceitas", compact(totals.accepted), "desde o último isolate"),
    tile(
      "Rejeitadas",
      compact(totals.rejected),
      `${rejectShare.toFixed(1)}% do que entrou`,
      rejectShare > 25 ? "warn" : undefined,
    ),
    tile(
      "Buffer",
      compact(totals.buffered),
      "aguardando a fila de persistência",
      // Messages waiting for the next flush are the design, not a fault. Only
      // the health rule — which knows whether the flush has actually stopped —
      // gets to colour this one.
      stalledPersistence ? "warn" : undefined,
    ),
    tile("Publicadas", compact(totals.messagesPublished), "fanout do coordinator"),
    tile(
      "Shards",
      `${totals.shardsReachable}/${totals.shardsRegistered}`,
      `config v${stats?.configVersion ?? "—"}`,
      totals.shardsReachable < totals.shardsRegistered ? "warn" : undefined,
    ),
  );
}

function renderShards(shards) {
  el.shardsEmpty.hidden = shards.length > 0;
  el.shardsNote.textContent = shards.length === 0 ? "—" : `${shards.length} registrado(s)`;
  el.shardsBody.replaceChildren(
    ...shards.map((shard) => {
      const row = document.createElement("tr");
      row.dataset.reachable = String(shard.reachable);
      const cells = [
        `<span class="shard-id">#${shard.shardIndex}</span>`,
        shard.reachable ? compact(shard.connections) : "—",
        shard.reachable ? compact(shard.acceptedCount) : "—",
        shard.reachable ? compact(shard.rejectedCount) : "—",
        shard.reachable ? compact(shard.bufferedMessages) : "—",
        shard.reachable ? `v${shard.configVersion}` : "—",
        // Uptime is the isolate's, not the shard's: it resets on every
        // hibernation, which is exactly the thing worth seeing.
        shard.reachable ? duration(shard.uptimeMs) : "sem resposta",
      ];
      row.innerHTML = cells.map((cell, i) => `<td>${i === 0 ? cell : cell}</td>`).join("");
      return row;
    }),
  );
}

/* ------------------------------------------------------------------ */
/* sparkline                                                           */
/* ------------------------------------------------------------------ */

/*
 * Throughput has to be summed per shard, not taken off the room total.
 * Shards register and hand their slot back as the room empties and fills, so
 * the total jumps by a whole shard's accumulated counter the moment one
 * rejoins — which would draw a spike of thousands of messages a second that
 * never happened. Only shards present in both samples contribute, and a
 * counter that went backwards (a fresh isolate after hibernation) contributes
 * nothing rather than a negative rate.
 */
function pushSample(shards, at) {
  const current = new Map(
    shards.filter((shard) => shard.reachable).map((shard) => [shard.shardIndex, shard.acceptedCount]),
  );

  if (state.lastByShard.size > 0 && at > state.lastAt) {
    let delta = 0;
    for (const [shardIndex, accepted] of current) {
      const previous = state.lastByShard.get(shardIndex);
      if (previous === undefined) continue;
      delta += Math.max(0, accepted - previous);
    }
    state.samples.push({ v: (delta * 1000) / (at - state.lastAt), at });
    if (state.samples.length > SPARK_SAMPLES) state.samples.shift();
  }

  state.lastByShard = current;
  state.lastAt = at;
}

function sparkGeometry() {
  const samples = state.samples;
  if (samples.length < 2) return null;
  const peak = Math.max(1, ...samples.map((sample) => sample.v));
  // Spread whatever samples exist across the full width: a window that is
  // still filling should look like a short history, not like a broken chart
  // hugging the right edge.
  const step = SPARK_W / (samples.length - 1);
  const points = samples.map((sample, i) => {
    const x = i * step;
    const y = SPARK_H - 1 - (sample.v / peak) * (SPARK_H - 6);
    return { x, y, sample };
  });
  return { points, peak, step };
}

function renderSpark() {
  const geometry = sparkGeometry();
  if (!geometry) {
    el.sparkLine.setAttribute("d", "");
    el.sparkArea.setAttribute("d", "");
    return;
  }
  const { points, peak } = geometry;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  el.sparkLine.setAttribute("d", line);
  el.sparkArea.setAttribute(
    "d",
    `${line} L${points[points.length - 1].x.toFixed(1)} ${SPARK_H - 1} L${points[0].x.toFixed(1)} ${SPARK_H - 1} Z`,
  );
  const current = points[points.length - 1].sample.v;
  el.sparkNow.textContent = `agora ${current.toFixed(current < 10 ? 1 : 0)} msg/s`;
  el.sparkPeak.textContent = `pico ${peak.toFixed(peak < 10 ? 1 : 0)} msg/s`;
}

/**
 * The window scrolls once a second, so a tooltip that tracked a moving sample
 * would show a different number under a stationary cursor. Hovering freezes
 * the drawing (collection continues) and the reading stays true.
 */
function wireSparkHover() {
  const svg = el.sparkBox.querySelector("svg");

  const show = (event) => {
    const geometry = sparkGeometry();
    if (!geometry) return;
    const box = svg.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * SPARK_W;
    let nearest = geometry.points[0];
    for (const point of geometry.points) {
      if (Math.abs(point.x - x) < Math.abs(nearest.x - x)) nearest = point;
    }
    state.frozen = geometry;
    el.sparkCursor.hidden = false;
    el.sparkCursor.setAttribute("x1", String(nearest.x));
    el.sparkCursor.setAttribute("x2", String(nearest.x));
    el.sparkMarker.hidden = false;
    el.sparkMarker.setAttribute("cx", String(nearest.x));
    el.sparkMarker.setAttribute("cy", String(nearest.y));
    el.sparkTip.hidden = false;
    el.sparkTip.style.left = `${(nearest.x / SPARK_W) * 100}%`;
    el.sparkTip.style.top = `${(nearest.y / SPARK_H) * 100}%`;
    el.sparkTip.textContent = `${nearest.sample.v.toFixed(1)} msg/s · ${clockOf(nearest.sample.at)}`;
  };

  const hide = () => {
    state.frozen = null;
    el.sparkCursor.hidden = true;
    el.sparkMarker.hidden = true;
    el.sparkTip.hidden = true;
    renderSpark();
  };

  svg.addEventListener("pointermove", show);
  svg.addEventListener("pointerleave", hide);
}

/* ------------------------------------------------------------------ */
/* Cloudflare account analytics                                        */
/* ------------------------------------------------------------------ */

function renderCloudflare(payload) {
  if (!payload || payload.available !== true) {
    el.cfNote.textContent = "somente local";
    const note = document.createElement("div");
    note.className = "cf-note";
    note.innerHTML = `<svg style="width:16px;height:16px;flex:none;fill:var(--dim)" aria-hidden="true"><use href="#i-shield" /></svg><span></span>`;
    note.querySelector("span").textContent =
      payload?.reason ??
      "analytics da conta indisponível — defina CF_API_TOKEN e CF_ACCOUNT_ID em .dev.vars";
    el.cfBody.replaceChildren(note);
    return;
  }

  const age = Math.max(0, Date.now() - payload.fetchedAt);
  el.cfNote.textContent = `janela de ${payload.windowMinutes} min · atraso da API ~1-5 min · lido há ${duration(age) === "—" ? "instantes" : duration(age)}`;
  const grid = document.createElement("div");
  grid.className = "tiles";
  grid.append(
    tile("Requests do Worker", compact(payload.worker.requests), payload.scriptName),
    tile(
      "Erros do Worker",
      compact(payload.worker.errors),
      "no período",
      payload.worker.errors > 0 ? "down" : undefined,
    ),
    tile("CPU p99", micros(payload.worker.cpuTimeP99), `p50 ${micros(payload.worker.cpuTimeP50)}`),
    tile("Requests em DOs", compact(payload.durableObjects.requests), "coordinator + shards"),
    tile(
      "Erros em DOs",
      compact(payload.durableObjects.errors),
      "no período",
      payload.durableObjects.errors > 0 ? "down" : undefined,
    ),
    tile(
      "Wall time p99",
      micros(payload.durableObjects.wallTimeP99),
      `p50 ${micros(payload.durableObjects.wallTimeP50)}`,
    ),
    tile(
      "Active time",
      `${payload.durableObjects.activeTimeSeconds.toFixed(1)} s`,
      "o que a hibernação evita",
    ),
    tile(
      "Storage",
      compact(
        payload.durableObjects.storageReadUnits + payload.durableObjects.storageWriteUnits,
      ),
      `${compact(payload.durableObjects.storageReadUnits)} leituras · ${compact(payload.durableObjects.storageWriteUnits)} escritas`,
    ),
    tile("Saída dos DOs", bytes(payload.durableObjects.responseBodyBytes), "response body"),
  );
  el.cfBody.replaceChildren(grid);
}

/* ------------------------------------------------------------------ */
/* polling                                                             */
/* ------------------------------------------------------------------ */

function applySnapshot(snapshot) {
  // Kept so the load-test panel can put the room's own connection count next to
  // what the generator claims, without polling observability a second time.
  state.lastSnapshot = snapshot;
  const revealed = snapshot.revealed === true;
  el.lock.dataset.revealed = String(revealed);
  el.lockText.textContent = revealed ? "moderador" : "anônimo";
  el.lock.firstElementChild.firstElementChild.setAttribute(
    "href",
    revealed ? "#i-unlock" : "#i-lock",
  );
  el.lock.title = revealed
    ? "Você vê os identificadores reais"
    : "Entre como moderador para ver quem é cada usuário";

  if (snapshot.dropped > 0) noteGap(snapshot.dropped);
  for (const event of snapshot.events) pushEvent(event);
  state.cursor = snapshot.cursor ?? state.cursor;

  el.auditSub.textContent =
    state.rows === 0
      ? "aguardando o primeiro evento"
      : `${state.rows} linha(s) · ${revealed ? "identificados" : "pseudonimizados"} · atualiza a cada 1s`;

  renderVerdict(snapshot.health);
  renderTiles(snapshot);
  renderShards(snapshot.shards);
  pushSample(snapshot.shards, snapshot.now);
  if (!state.frozen) renderSpark();

  el.opsSub.textContent = `sala ${snapshot.roomId} · ${snapshot.totals.shardsReachable} shard(s) respondendo · atualiza a cada 1s`;
}

async function poll() {
  const context = state.context?.() ?? {};
  const url = new URL(`/api/rooms/${state.roomId}/observability`, location.origin);
  if (state.cursor) url.searchParams.set("since", state.cursor);
  if (Number.isFinite(context.pingMs) && context.pingMs > 0) {
    url.searchParams.set("pingMs", String(Math.round(context.pingMs)));
  }
  try {
    const res = await fetch(url, {
      headers: context.token ? { authorization: `Bearer ${context.token}` } : {},
    });
    if (res.ok) {
      const body = await res.json();
      if (body?.snapshot) applySnapshot(body.snapshot);
    } else {
      el.opsSub.textContent = `o endpoint de observabilidade respondeu ${res.status}`;
    }
  } catch (error) {
    // A console that stops polling on the first blip is worse than one that
    // shows a stale number and says so.
    el.opsSub.textContent = `sem conexão com o Worker — ${String(error)}`;
  }
  schedule();
}

function schedule() {
  clearTimeout(state.timer);
  const delay = document.hidden ? POLL_IDLE_MS : POLL_ACTIVE_MS;
  state.timer = setTimeout(poll, delay);
}

/* ------------------------------------------------------------------ */
/* load test                                                           */
/* ------------------------------------------------------------------ */

const PHASE_LABEL = {
  ramp: "subindo",
  hold: "no máximo",
  drain: "desconectando",
  done: "encerrado",
};

/**
 * The panel that makes a run legible while it happens.
 *
 * Two counts are always shown side by side and that is the whole point: what
 * the *generator* believes it opened, and what the *room* reports. They should
 * agree; when they do not, the gap is the finding, and hiding it behind one
 * averaged number would throw away the most interesting thing on the page.
 */
function renderLoadTest(payload, snapshot) {
  const run = payload?.run;
  if (!run) {
    el.loadtest.hidden = true;
    return;
  }
  el.loadtest.hidden = false;

  const target = run.targetConnections || 1;
  const claimed = run.progress.open;
  const observed = snapshot?.totals?.connections ?? 0;
  const share = Math.min(1, claimed / target);
  el.loadtestFill.style.width = `${(share * 100).toFixed(1)}%`;

  const elapsed = Math.round((Date.now() - run.startedAt) / 1000);
  el.loadtestNote.textContent =
    `preset ${run.preset} · ${PHASE_LABEL[run.phase] ?? run.phase} · ${elapsed}s · ` +
    `rampa ${run.rampSeconds}s + ${run.holdSeconds}s no topo`;

  const grid = document.createElement("div");
  grid.className = "tiles";
  grid.append(
    tile("Conexões (gerador)", compact(claimed), `de ${compact(target)} · ${(share * 100).toFixed(1)}%`),
    tile(
      "Conexões (sala)",
      compact(observed),
      claimed > 0 && Math.abs(observed - claimed) / claimed > 0.01
        ? `diverge do gerador em ${compact(Math.abs(observed - claimed))}`
        : "confere com o gerador",
      claimed > 0 && Math.abs(observed - claimed) / claimed > 0.01 ? "down" : undefined,
    ),
    tile("Remetentes", compact(run.targetTalkers), "planejados"),
    tile("Enviadas", compact(run.progress.sent), `${compact(run.progress.acked)} confirmadas`),
    tile(
      "Rejeitadas",
      compact(run.progress.rejected),
      "pelos gates",
      run.progress.rejected > 0 ? "warn" : undefined,
    ),
    tile("Handshakes perdidos", compact(run.progress.failed), "no gerador", run.progress.failed > 0 ? "down" : undefined),
  );

  const children = [grid];
  if (run.bypass) {
    // A number obtained with the connection limiter switched off must never be
    // mistaken for a normal one, so the page says so while it is happening.
    const warning = document.createElement("div");
    warning.className = "cf-note";
    warning.innerHTML = `<svg style="width:16px;height:16px;flex:none;fill:var(--warn,#d99a2b)" aria-hidden="true"><use href="#i-alert" /></svg><span></span>`;
    warning.querySelector("span").textContent =
      "Este run passa por cima do limite de conexões da borda. As pessoas na sala pública continuam sujeitas a ele.";
    children.push(warning);
  }
  if (run.note) {
    const note = document.createElement("p");
    note.className = "card__note";
    note.textContent = run.note;
    children.push(note);
  }
  el.loadtestBody.replaceChildren(...children);
}

async function pollLoadTest() {
  try {
    const res = await fetch(`/api/rooms/${state.roomId}/loadtest`);
    const body = res.ok ? await res.json() : null;
    renderLoadTest(body, state.lastSnapshot);
  } catch {
    // A run that cannot be read is indistinguishable from no run; leave the
    // panel as it is rather than flapping it off and on.
  }
}

async function pollCloudflare() {
  try {
    const res = await fetch(`/api/rooms/${state.roomId}/observability/cloudflare`);
    const body = res.ok ? await res.json() : null;
    renderCloudflare(body?.cloudflare);
  } catch {
    renderCloudflare(null);
  }
}

/* ------------------------------------------------------------------ */
/* mount                                                               */
/* ------------------------------------------------------------------ */

function wireTabs() {
  for (const button of el.tabs.querySelectorAll("button")) {
    button.addEventListener("click", () => {
      el.console.dataset.view = button.dataset.view;
      for (const other of el.tabs.querySelectorAll("button")) {
        other.setAttribute("aria-pressed", String(other === button));
      }
    });
  }
}

/**
 * @param {object} options
 * @param {string} options.roomId
 * @param {() => {token?: string, pingMs?: number}} options.context  live session facts
 * @param {() => void} options.onRequestModerator  opens the join sheet
 */
export function mountConsole({ roomId, context, onRequestModerator }) {
  state.roomId = roomId;
  state.context = context;
  buildFilters();
  wireTabs();
  wireSparkHover();
  el.lock.addEventListener("click", () => onRequestModerator());
  document.addEventListener("visibilitychange", schedule);
  void poll();
  void pollCloudflare();
  void pollLoadTest();
  state.cloudflareTimer = setInterval(pollCloudflare, POLL_CLOUDFLARE_MS);
  // Polled over HTTP rather than pushed over the socket: telemetry about a load
  // test must not compete with the load test for the shard's attention.
  state.loadTestTimer = setInterval(pollLoadTest, POLL_ACTIVE_MS);
}
