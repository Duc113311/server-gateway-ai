/* Dashboard behaviour. Plain DOM — the page is small, and a framework here
   would be a build step and a CDN dependency for no gain. */

const $ = (id) => document.getElementById(id);
const PAGE = 50;

const state = { csrf: '', offset: 0, total: 0, promptsLogged: true };

// ── Formatting ──────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat();
const num = (n) => nf.format(n ?? 0);

function timeLabel(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function ms(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;
}

/** Everything the user types reaches the DOM as text, never as markup. */
function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text ?? '';
  return td;
}

// ── Filters ─────────────────────────────────────────────────────────────────

function filterParams() {
  const hours = Number($('f-range').value);
  const p = new URLSearchParams();
  if (hours > 0) p.set('from', String(Date.now() - hours * 3600_000));
  for (const [key, id] of [
    ['feature', 'f-feature'],
    ['model', 'f-model'],
    ['status', 'f-status'],
    ['uid', 'f-uid'],
    ['search', 'f-search'],
  ]) {
    const v = $(id).value.trim();
    if (v) p.set(key, v);
  }
  return p;
}

async function api(path, params) {
  const qs = params ? `?${params.toString()}` : '';
  const res = await fetch(`/admin/api/${path}${qs}`);
  if (res.status === 401) { location.href = '/admin/login'; throw new Error('signed out'); }
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}

// ── Tiles ───────────────────────────────────────────────────────────────────

function renderTiles(s) {
  const errRate = s.requests ? Math.round((s.errors / s.requests) * 100) : 0;
  const tiles = [
    { k: 'Requests', v: num(s.requests), d: `${num(s.errors)} failed (${errRate}%)` },
    { k: 'Input tokens', v: num(s.inputTokens), d: 'billed on every turn' },
    { k: 'Output tokens', v: num(s.outputTokens), d: 'generated' },
    { k: 'Users', v: num(s.uniqueUsers), d: 'distinct uids' },
    { k: 'Latency', v: ms(s.avgLatencyMs), d: `p95 ${ms(s.p95LatencyMs)}` },
  ];

  $('tiles').innerHTML = '';
  for (const t of tiles) {
    const el = document.createElement('div');
    el.className = 'tile';
    const k = document.createElement('div'); k.className = 'k'; k.textContent = t.k;
    const v = document.createElement('div'); v.className = 'v'; v.textContent = t.v;
    const d = document.createElement('div'); d.className = 'd'; d.textContent = t.d;
    el.append(k, v, d);
    $('tiles').appendChild(el);
  }
}

// ── Hourly chart ────────────────────────────────────────────────────────────

const SVG = 'http://www.w3.org/2000/svg';
const node = (name, attrs) => {
  const el = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/**
 * One series, so no legend — the panel heading names it. Bars are anchored to
 * the baseline with rounded tops, and a transparent hit rectangle spans the
 * full height so a one-pixel bar is still hoverable.
 */
function renderChart(buckets) {
  const svg = $('chart');
  svg.innerHTML = '';
  if (buckets.length === 0) {
    $('chart-cap').textContent = 'No requests in this range.';
    return;
  }
  $('chart-cap').textContent = 'Local time. Hover a bar for the exact count.';

  const W = svg.clientWidth || 900;
  const H = 190;
  const padL = 40, padR = 8, padT = 10, padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const max = Math.max(...buckets.map((b) => b.requests), 1);
  // A round ceiling keeps the gridline labels readable.
  const ceil = max <= 5 ? max : Math.ceil(max / 5) * 5;

  // Recessive gridlines, drawn first so bars sit above them.
  for (let i = 0; i <= 2; i++) {
    const v = Math.round((ceil / 2) * i);
    const y = padT + plotH - (v / ceil) * plotH;
    svg.appendChild(node('line', { class: 'grid-line', x1: padL, x2: W - padR, y1: y, y2: y }));
    const t = node('text', { class: 'axis-text', x: padL - 6, y: y + 3, 'text-anchor': 'end' });
    t.textContent = String(v);
    svg.appendChild(t);
  }

  // 2px of surface between neighbours, so adjacent bars never merge.
  const slot = plotW / buckets.length;
  const barW = Math.max(1, Math.min(28, slot - 2));

  buckets.forEach((b, i) => {
    const h = (b.requests / ceil) * plotH;
    const x = padL + i * slot + (slot - barW) / 2;
    const y = padT + plotH - h;

    const hit = node('rect', { class: 'hit', x: padL + i * slot, y: padT, width: slot, height: plotH });
    const bar = node('rect', {
      class: 'bar', x, y: h > 0 ? y : padT + plotH - 1,
      width: barW, height: Math.max(h, b.requests > 0 ? 2 : 0),
      rx: Math.min(4, barW / 2),
    });

    const show = (e) => {
      bar.classList.add('hot');
      const tip = $('tooltip');
      tip.hidden = false;
      tip.textContent =
        `${b.key} · ${num(b.requests)} request(s) · ${num(b.inputTokens + b.outputTokens)} tokens`;
      const r = tip.getBoundingClientRect();
      tip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - r.width - 8)}px`;
      tip.style.top = `${Math.max(8, e.clientY - r.height - 10)}px`;
    };
    hit.addEventListener('mousemove', show);
    hit.addEventListener('mouseleave', () => {
      bar.classList.remove('hot');
      $('tooltip').hidden = true;
    });

    svg.append(hit, bar);
  });

  // Only the ends and the middle are labelled: an axis label under every hour
  // collides at any realistic width.
  const marks = buckets.length <= 3
    ? buckets.map((_, i) => i)
    : [0, Math.floor(buckets.length / 2), buckets.length - 1];
  for (const i of marks) {
    const t = node('text', {
      class: 'axis-text',
      x: padL + i * slot + slot / 2,
      y: H - 8,
      'text-anchor': i === 0 ? 'start' : i === buckets.length - 1 ? 'end' : 'middle',
    });
    t.textContent = buckets[i].key.slice(5);
    svg.appendChild(t);
  }
}

// ── Ranked breakdowns ───────────────────────────────────────────────────────

function renderRank(id, buckets) {
  const ul = $(id);
  ul.innerHTML = '';
  if (buckets.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Nothing yet.';
    ul.appendChild(li);
    return;
  }
  const max = Math.max(...buckets.map((b) => b.requests), 1);

  for (const b of buckets.slice(0, 8)) {
    const li = document.createElement('li');
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = `${(b.requests / max) * 100}%`;

    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = b.key;
    lbl.title = b.key;

    const n = document.createElement('span');
    n.className = 'num';
    n.textContent = `${num(b.requests)} · ${num(b.inputTokens + b.outputTokens)} tok`;

    li.append(fill, lbl, n);
    ul.appendChild(li);
  }
}

// ── Table ───────────────────────────────────────────────────────────────────

function renderRows(page) {
  const tbody = $('rows');
  tbody.innerHTML = '';
  $('empty').hidden = page.entries.length > 0;

  for (const e of page.entries) {
    const tr = document.createElement('tr');
    tr.append(
      cell(timeLabel(e.ts)),
      cell(e.uid.length > 14 ? `${e.uid.slice(0, 12)}…` : e.uid, 'mono'),
      cell(e.feature),
      cell(`${e.provider}/${e.model}`, 'mono'),
      cell(state.promptsLogged ? (e.prompt ?? '') : '— not logged —', 'msg'),
      cell(num(e.inputTokens), 'num'),
      cell(num(e.outputTokens), 'num'),
      cell(ms(e.latencyMs), 'num'),
    );

    const st = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `pill ${e.status === 'ok' ? 'ok' : 'err'}`;
    pill.textContent = e.status === 'ok' ? 'ok' : (e.errorCode || 'error');
    st.appendChild(pill);
    tr.appendChild(st);

    tr.addEventListener('click', () => openDetail(e));
    tbody.appendChild(tr);
  }

  const from = page.total === 0 ? 0 : state.offset + 1;
  const to = Math.min(state.offset + PAGE, page.total);
  $('page-info').textContent = `${num(from)}–${num(to)} of ${num(page.total)}`;
  $('prev').disabled = state.offset === 0;
  $('next').disabled = to >= page.total;
}

function openDetail(e) {
  $('d-title').textContent = `${e.feature} · ${e.provider}/${e.model}`;
  $('d-meta').textContent =
    `${timeLabel(e.ts)} · uid ${e.uid} · ${num(e.inputTokens)} in / ` +
    `${num(e.outputTokens)} out · ${ms(e.latencyMs)}` +
    `${e.stream ? ' · streamed' : ''}${e.locale ? ` · ${e.locale}` : ''}` +
    `${e.status === 'error' ? ` · ${e.errorCode}` : ''}`;
  $('d-prompt').textContent = e.prompt ?? '— prompt logging is off —';
  $('d-reply').textContent = e.replyPreview ?? '—';
  $('detail').showModal();
}

// ── Load ────────────────────────────────────────────────────────────────────

let loading = false;

async function load(resetPage) {
  if (loading) return;
  loading = true;
  if (resetPage) state.offset = 0;

  try {
    const base = filterParams();
    const listParams = new URLSearchParams(base);
    listParams.set('limit', String(PAGE));
    listParams.set('offset', String(state.offset));

    const [s, page] = await Promise.all([
      api('stats', base),
      api('requests', listParams),
    ]);

    state.total = page.total;
    renderTiles(s);
    renderChart(s.byHour);
    renderRank('by-model', s.byModel);
    renderRank('by-user', s.byUser);
    renderRows(page);
  } catch (e) {
    if (e.message !== 'signed out') console.error(e);
  } finally {
    loading = false;
  }
}

function fillSelect(id, values) {
  const el = $(id);
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    el.appendChild(opt);
  }
}

/** Runs the handler after typing stops, so each keystroke is not a request. */
function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

async function main() {
  const me = await api('me');
  state.csrf = me.csrf;
  state.promptsLogged = me.promptsLogged;

  $('who').textContent =
    `${me.username}${me.lastLoginAt ? ` · last sign-in ${timeLabel(me.lastLoginAt)}` : ''}` +
    `${me.recoveryCodesLeft <= 3 ? ` · only ${me.recoveryCodesLeft} recovery codes left` : ''}`;

  if (!me.promptsLogged) {
    $('table-cap').textContent =
      'Message text is not stored (ADMIN_LOG_PROMPTS=false). Counts and models still are.';
  } else {
    $('table-cap').textContent =
      `Click a row for the full message and reply. Kept for ${me.retentionDays} days.`;
  }

  fillSelect('f-feature', me.facets.features);
  fillSelect('f-model', me.facets.models);

  for (const id of ['f-range', 'f-feature', 'f-model', 'f-status']) {
    $(id).addEventListener('change', () => load(true));
  }
  for (const id of ['f-uid', 'f-search']) {
    $(id).addEventListener('input', debounce(() => load(true), 300));
  }

  $('prev').addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - PAGE);
    load(false);
  });
  $('next').addEventListener('click', () => {
    state.offset += PAGE;
    load(false);
  });

  $('btn-refresh').addEventListener('click', () => load(false));
  $('btn-export').addEventListener('click', () => {
    location.href = `/admin/api/export.csv?${filterParams().toString()}`;
  });
  $('btn-logout').addEventListener('click', async () => {
    await fetch('/admin/logout', { method: 'POST', headers: { 'x-csrf-token': state.csrf } });
    location.href = '/admin/login';
  });

  $('d-close').addEventListener('click', () => $('detail').close());

  // Re-laying the bars out on resize keeps the labels from colliding.
  window.addEventListener('resize', debounce(() => load(false), 200));

  await load(true);
}

main().catch((e) => console.error(e));
