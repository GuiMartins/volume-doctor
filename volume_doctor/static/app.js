"use strict";
// ---------------------------------------------------------------- estado
const S = {
  tracks: [], byId: new Map(), settings: { target_lufs: -14, clip_limit: true }, saved: null,
  job: null, wasRunning: false, sel: new Set(), page: 0, pageSize: 100,
  sort: { key: "lufs", asc: false }, range: null, list: [], playingId: null, ab: "fix",
};
const $ = (id) => document.getElementById(id);
const TOL = 0.05;

// ---------------------------------------------------------------- formatação
const nf1 = (v) => v.toFixed(1).replace(".", ",").replace("-", "−");
const fmtDb = (v) => (v > 0.049 ? "+" : "") + nf1(v) + " dB";
const fmtTime = (s) => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const basename = (p) => p.split("/").pop().replace(/\.[^.]+$/, "");
const dirname = (p) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";

// ---------------------------------------------------------------- cálculo (espelho de gains.py)
function limit(gain, peakDb, clip) {
  if (clip && gain > 0) { const c = Math.max(0, Math.min(gain, -peakDb)); return [c, c < gain - 0.005]; }
  return [gain, false];
}
const r2 = (v) => Math.round(v * 100) / 100;
function computeAll() {
  const target = Number(S.settings.target_lufs), clip = !!S.settings.clip_limit;
  const groups = new Map();
  for (const t of S.tracks) {
    t.calc = null;
    if (t.lufs == null) continue;
    const k = dirname(t.path) + "\0" + (t.album || "").trim().toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  for (const lst of groups.values()) {
    let tot = 0, en = 0, ap = -Infinity;
    for (const t of lst) { const d = t.duration || 1; tot += d; en += d * 10 ** (t.lufs / 10); ap = Math.max(ap, t.peak_db); }
    const al = 10 * Math.log10(en / tot);
    const [agBase] = limit(target - al, ap, clip);
    for (const t of lst) {
      const [tgBase, limited] = limit(target - t.lufs, t.peak_db, clip);
      const off = t.offset_db || 0;
      t.calc = { tg: r2(tgBase + off), ag: r2(agBase + off), limited, want: target - t.lufs };
    }
  }
  for (const t of S.tracks) {
    const c = t.calc;
    t.pending = !!c && (t.file_tg == null || Math.abs(t.file_tg - c.tg) > TOL ||
      t.file_ag == null || Math.abs(t.file_ag - c.ag) > TOL || t.file_tp == null || t.file_ap == null);
    t.status = t.error ? "erro" : t.lufs == null ? "não medida" : t.pending ? "a corrigir" : "ok";
    t.gain = c ? c.tg : null;
    t.after = c ? t.lufs + c.tg : null;
  }
}

// ---------------------------------------------------------------- API
async function api(path, body) {
  const opt = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(path, opt);
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch (_) {} throw new Error(m); }
  return r.json();
}
function toast(msg, bad = false, details = []) {
  const el = $("toast");
  el.className = "toast" + (bad ? " bad" : "");
  el.innerHTML = esc(msg) + (details.length ? `<details><summary>${details.length} erro(s)</summary>${details.map(esc).join("<br>")}</details>` : "");
  el.hidden = false;
  clearTimeout(el._t);
  if (!details.length) el._t = setTimeout(() => (el.hidden = true), 9000);
}
async function loadTracks() {
  S.tracks = await api("/api/tracks");
  S.byId = new Map(S.tracks.map((t) => [t.id, t]));
  for (const id of [...S.sel]) if (!S.byId.has(id)) S.sel.delete(id);
  refresh();
}
async function pollState() {
  try {
    const st = await api("/api/state");
    if (!S.saved) { S.saved = { ...st.settings }; S.settings = { ...st.settings }; syncSettingsUI(); }
    S.job = st.job;
    $("music-dir").textContent = st.music_dir;
    $("last-scan").textContent = st.last_scan ? "último scan: " + new Date(st.last_scan).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "";
    renderJob();
    if (S.wasRunning && !st.job.running) {
      toast(st.job.message || "Concluído.", /Falhou/.test(st.job.message), st.job.errors || []);
      await loadTracks();
    } else if (st.job.running && st.job.kind === "scan" && st.job.phase === "Medindo loudness" && (Date.now() - (S._lastLive || 0) > 20000)) {
      S._lastLive = Date.now(); loadTracks(); // gráficos vão enchendo durante o scan
    }
    S.wasRunning = st.job.running;
  } catch (e) { console.error(e); }
  setTimeout(pollState, S.job && S.job.running ? 1500 : 8000);
}

// ---------------------------------------------------------------- job / topo
function renderJob() {
  const j = S.job, run = j && j.running;
  $("job").hidden = !run;
  $("btn-scan").disabled = $("btn-rescan").disabled = run;
  $("btn-apply").disabled = run; $("btn-revert").disabled = run;
  if (!run) return;
  $("job-phase").textContent = j.phase || "…";
  $("job-count").textContent = j.total ? `${j.done}/${j.total}` : "";
  $("job-msg").textContent = j.message || "";
  $("job-bar").style.width = j.total ? (100 * j.done / j.total).toFixed(1) + "%" : "0";
}
async function startScan(force) {
  if (force && !confirm("Medir a biblioteca inteira de novo? Demora tanto quanto o primeiro scan.")) return;
  try { S.job = await api("/api/scan", { force }); S.wasRunning = true; renderJob(); } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------- render geral
function refresh() {
  computeAll();
  const has = S.tracks.length > 0;
  $("empty").hidden = has; $("content").hidden = !has;
  if (!has) return;
  renderStats(); renderSummary(); drawHist(); drawScatter(); renderTable(); updatePlayerGain();
}
function pct(arr, p) { if (!arr.length) return NaN; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; }
function renderStats() {
  const m = S.tracks.filter((t) => t.lufs != null);
  const before = m.map((t) => t.lufs), after = m.map((t) => t.after);
  const spread = (a) => pct(a, 0.95) - pct(a, 0.05);
  const items = [
    ["Faixas", S.tracks.length],
    ["Medidas", m.length],
    ["A corrigir", S.tracks.filter((t) => t.pending).length, true],
    ["Gravadas pelo app", S.tracks.filter((t) => t.written_at).length],
    ["Variação hoje", m.length ? nf1(spread(before)) + " LU" : "—"],
    ["Variação depois", m.length ? nf1(spread(after)) + " LU" : "—", true],
  ];
  const err = S.tracks.filter((t) => t.error).length;
  if (err) items.push(["Com erro", err]);
  $("stats").innerHTML = items.map(([l, v, hl]) => `<div class="stat${hl ? " hl" : ""}"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("") ;
  $("stats").title = "Variação = distância entre a faixa mais baixa e a mais alta, ignorando os 5% extremos de cada lado";
}
function renderSummary() {
  const m = S.tracks.filter((t) => t.calc);
  const down = m.filter((t) => t.calc.tg < -TOL), up = m.filter((t) => t.calc.tg > TOL);
  const lim = m.filter((t) => t.calc.limited);
  const avg = (a) => a.reduce((s, t) => s + t.calc.tg, 0) / (a.length || 1);
  const pend = S.tracks.filter((t) => t.pending).length;
  const dirty = isDirty();
  $("corr-summary").innerHTML =
    `Com alvo <b>${nf1(Number(S.settings.target_lufs))} LUFS</b>: <b class="down">${down.length}</b> faixas descem (média ${fmtDb(avg(down))}), ` +
    `<b class="up">${up.length}</b> sobem (média ${fmtDb(avg(up))})` +
    (S.settings.clip_limit ? `, <b class="lim">${lim.length}</b> sobem menos do que precisariam por falta de folga.` : ".") +
    ` ${pend ? `<b>${pend}</b> arquivos precisam de tag nova.` : "Tudo gravado."}` +
    (dirty ? ` <span class="muted">(prévia, alvo ainda não salvo)</span>` : "");
  $("btn-apply").textContent = pend ? `Aplicar em ${pend} faixas` : "Nada a aplicar";
  $("btn-apply").disabled = !pend || (S.job && S.job.running);
  const w = S.tracks.filter((t) => t.written_at).length;
  $("btn-revert").textContent = `Reverter tudo (${w})`;
  $("btn-revert").disabled = !w || (S.job && S.job.running);
  $("btn-save").disabled = !dirty;
}

// ---------------------------------------------------------------- canvas helpers
function setupCanvas(cv) {
  if (!cv.dataset.h) cv.dataset.h = cv.getAttribute("height");
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = Number(cv.dataset.h);
  cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + "px";
  const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const PAD = { l: 40, r: 12, t: 10, b: 36 };
const X_MIN = -30, X_MAX = -4;
let tip;
function showTip(e, html) {
  if (!tip) { tip = document.createElement("div"); tip.className = "tooltip"; document.body.appendChild(tip); }
  if (!html) { tip.hidden = true; return; }
  tip.hidden = false; tip.innerHTML = html;
  tip.style.left = Math.min(e.clientX + 12, innerWidth - 330) + "px"; tip.style.top = e.clientY + 12 + "px";
}
function axes(ctx, w, h, xs, ys, xLabel) {
  ctx.strokeStyle = css("--line"); ctx.fillStyle = css("--muted"); ctx.font = "11px system-ui"; ctx.lineWidth = 1;
  for (const [v, x] of xs) { ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, h - PAD.b); ctx.stroke(); ctx.textAlign = "center"; ctx.fillText(v, x, h - PAD.b + 14); }
  for (const [v, y] of ys) { ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(w - PAD.r, y); ctx.stroke(); ctx.textAlign = "right"; ctx.fillText(v, PAD.l - 6, y + 4); }
  ctx.textAlign = "center"; ctx.fillText(xLabel, (PAD.l + w - PAD.r) / 2, h - 3);
}

// ---------------------------------------------------------------- histograma
const clampX = (v) => Math.max(X_MIN, Math.min(X_MAX - 0.001, v));
function drawHist() {
  const cv = $("hist"); const { ctx, w, h } = setupCanvas(cv);
  const nb = X_MAX - X_MIN, b = new Array(nb).fill(0), a = new Array(nb).fill(0);
  for (const t of S.tracks) {
    if (t.lufs == null) continue;
    b[Math.floor(clampX(t.lufs) - X_MIN)]++; a[Math.floor(clampX(t.after) - X_MIN)]++;
  }
  const max = Math.max(1, ...b, ...a);
  const sx = (v) => PAD.l + (v - X_MIN) / nb * (w - PAD.l - PAD.r);
  const sy = (n) => h - PAD.b - n / max * (h - PAD.t - PAD.b);
  const xs = []; for (let v = X_MIN; v <= X_MAX; v += 2) xs.push([v, sx(v)]);
  const step = max > 400 ? 200 : max > 150 ? 50 : max > 40 ? 20 : 5;
  const ys = []; for (let n = 0; n <= max; n += step) ys.push([n, sy(n)]);
  axes(ctx, w, h, xs, ys, "loudness (LUFS) → · ↑ nº de faixas");
  const bw = (w - PAD.l - PAD.r) / nb;
  for (let i = 0; i < nb; i++) {
    const x = PAD.l + i * bw;
    if (S.range && S.range[0] === X_MIN + i) { ctx.fillStyle = css("--chip"); ctx.fillRect(x, PAD.t, bw, h - PAD.t - PAD.b); }
    ctx.fillStyle = css("--before"); ctx.fillRect(x + 1, sy(b[i]), bw - 2, h - PAD.b - sy(b[i]));
    ctx.fillStyle = css("--accent-soft"); ctx.fillRect(x + bw * 0.25, sy(a[i]), bw * 0.5, h - PAD.b - sy(a[i]));
  }
  ctx.strokeStyle = css("--err"); ctx.lineWidth = 2; const tx = sx(Number(S.settings.target_lufs));
  ctx.beginPath(); ctx.moveTo(tx, PAD.t); ctx.lineTo(tx, h - PAD.b); ctx.stroke();
  cv._hit = (e) => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left;
    const i = Math.floor((x - PAD.l) / bw);
    return i >= 0 && i < nb ? { i, lo: X_MIN + i, b: b[i], a: a[i] } : null;
  };
}
$("hist").addEventListener("mousemove", (e) => {
  const hit = $("hist")._hit && $("hist")._hit(e);
  showTip(e, hit ? `${nf1(hit.lo)} a ${nf1(hit.lo + 1)} LUFS<br>hoje: ${hit.b} faixas · depois: ${hit.a}` : null);
});
$("hist").addEventListener("mouseleave", (e) => showTip(e, null));
$("hist").addEventListener("click", (e) => {
  const hit = $("hist")._hit(e); if (!hit) return;
  S.range = S.range && S.range[0] === hit.lo ? null : [hit.lo, hit.lo + 1];
  S.page = 0; drawHist(); renderTable();
});

// ---------------------------------------------------------------- dispersão
const Y_MIN = -20, Y_MAX = 3;
function pointColor(t) {
  const c = t.calc;
  if (c.limited) return css("--lim");
  if (c.tg > 0.5) return css("--up");
  if (c.tg < -0.5) return css("--down");
  return css("--ok");
}
function drawScatter() {
  const cv = $("scatter"); const { ctx, w, h } = setupCanvas(cv);
  const sx = (v) => PAD.l + (clampX(v) - X_MIN) / (X_MAX - X_MIN) * (w - PAD.l - PAD.r);
  const sy = (v) => h - PAD.b - (Math.max(Y_MIN, Math.min(Y_MAX, v)) - Y_MIN) / (Y_MAX - Y_MIN) * (h - PAD.t - PAD.b);
  const xs = []; for (let v = X_MIN; v <= X_MAX; v += 2) xs.push([v, sx(v)]);
  const ys = []; for (let v = -20; v <= 0; v += 5) ys.push([v, sy(v)]);
  axes(ctx, w, h, xs, ys, "loudness (LUFS) → · ↑ pico (dBFS)");
  ctx.strokeStyle = css("--muted"); ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(PAD.l, sy(0)); ctx.lineTo(w - PAD.r, sy(0)); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = css("--err"); ctx.lineWidth = 2; const tx = sx(Number(S.settings.target_lufs));
  ctx.beginPath(); ctx.moveTo(tx, PAD.t); ctx.lineTo(tx, h - PAD.b); ctx.stroke();
  const pts = [];
  ctx.globalAlpha = 0.65;
  for (const t of S.tracks) {
    if (!t.calc) continue;
    const x = sx(t.lufs), y = sy(t.peak_db);
    ctx.fillStyle = pointColor(t); ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 6.29); ctx.fill();
    pts.push([x, y, t]);
  }
  ctx.globalAlpha = 1;
  if (S.playingId != null) {
    const p = pts.find((p) => p[2].id === S.playingId);
    if (p) { ctx.strokeStyle = css("--fg"); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p[0], p[1], 6, 0, 6.29); ctx.stroke(); }
  }
  cv._hit = (e) => {
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 49;
    for (const p of pts) { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd) { bd = d; best = p[2]; } }
    return best;
  };
}
$("scatter").addEventListener("mousemove", (e) => {
  const t = $("scatter")._hit && $("scatter")._hit(e);
  showTip(e, t ? `<b>${esc(t.title || basename(t.path))}</b><br>${esc(t.artist || "")}<br>${nf1(t.lufs)} LUFS · pico ${nf1(t.peak_db)} dBFS · ganho ${fmtDb(t.calc.tg)}` : null);
});
$("scatter").addEventListener("mouseleave", (e) => showTip(e, null));
$("scatter").addEventListener("click", (e) => { const t = $("scatter")._hit(e); if (t) play(t.id); });
let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { drawHist(); drawScatter(); }, 150); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { drawHist(); drawScatter(); });

// ---------------------------------------------------------------- tabela
function filtered() {
  const q = $("q").value.trim().toLowerCase(), f = $("filter").value;
  const tests = {
    all: () => true, pending: (t) => t.pending, up: (t) => t.calc && t.calc.tg > TOL, down: (t) => t.calc && t.calc.tg < -TOL,
    limited: (t) => t.calc && t.calc.limited, offset: (t) => t.offset_db, written: (t) => t.written_at,
    error: (t) => t.error, unmeasured: (t) => t.lufs == null && !t.error,
  };
  let list = S.tracks.filter(tests[f]);
  if (S.range) list = list.filter((t) => t.lufs != null && clampX(t.lufs) >= S.range[0] && clampX(t.lufs) < S.range[1]);
  if (q) list = list.filter((t) => `${t.artist} ${t.title} ${t.album} ${t.path}`.toLowerCase().includes(q));
  const { key, asc } = S.sort, dir = asc ? 1 : -1;
  const val = (t) => key === "title" ? (t.title || basename(t.path)).toLowerCase() : t[key];
  list.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });
  return list;
}
function gainCell(t) {
  if (!t.calc) return `<span class="g-zero">—</span>`;
  const g = t.calc.tg, cls = t.calc.limited ? "g-lim" : g > TOL ? "g-up" : g < -TOL ? "g-down" : "g-zero";
  const title = t.calc.limited ? ` title="Precisaria de ${fmtDb(t.calc.want + (t.offset_db || 0))}, mas o pico não deixa"` : "";
  return `<span class="${cls}"${title}>${fmtDb(g)}${t.calc.limited ? " ⚠" : ""}</span>`;
}
function statusPill(t) {
  if (t.error) return `<span class="pill err" title="${esc(t.error)}">erro</span>`;
  if (t.lufs == null) return `<span class="pill">não medida</span>`;
  if (t.pending) return `<span class="pill pending">a corrigir</span>`;
  return `<span class="pill done">ok</span>`;
}
function renderTable() {
  S.list = filtered();
  const pages = Math.max(1, Math.ceil(S.list.length / S.pageSize));
  S.page = Math.min(S.page, pages - 1);
  const slice = S.list.slice(S.page * S.pageSize, (S.page + 1) * S.pageSize);
  $("rows").innerHTML = slice.map((t) => `
    <tr data-id="${t.id}" class="${t.id === S.playingId ? "playing" : ""}">
      <td><input type="checkbox" class="sel" ${S.sel.has(t.id) ? "checked" : ""}></td>
      <td><button class="play" title="Ouvir">▶</button></td>
      <td><div class="t-title">${esc(t.title || basename(t.path))}</div><div class="t-sub" title="${esc(t.path)}">${esc(t.artist || "?")}${t.album ? " · " + esc(t.album) : ""}</div></td>
      <td class="num">${t.lufs != null ? nf1(t.lufs) : "—"}</td>
      <td class="num">${t.peak_db != null ? nf1(t.peak_db) : "—"}</td>
      <td class="num">${gainCell(t)}</td>
      <td class="num"><input class="off${t.offset_db ? " set" : ""}" type="number" step="0.5" value="${t.offset_db ? t.offset_db : ""}" placeholder="0"></td>
      <td class="num">${t.file_tg != null ? fmtDb(t.file_tg) : '<span class="g-zero">—</span>'}</td>
      <td>${statusPill(t)}</td>
    </tr>`).join("");
  $("count").textContent = `${S.list.length} faixa(s)`;
  $("page").textContent = `${S.page + 1} / ${pages}`;
  $("prev").disabled = S.page === 0; $("next").disabled = S.page >= pages - 1;
  $("check-page").checked = slice.length > 0 && slice.every((t) => S.sel.has(t.id));
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === S.sort.key); th.classList.toggle("asc", S.sort.asc);
  });
  const rc = $("range-chip");
  rc.hidden = !S.range; if (S.range) rc.textContent = `${nf1(S.range[0])} a ${nf1(S.range[1])} LUFS ✕`;
  renderBulk();
}
function renderBulk() {
  $("bulk").hidden = S.sel.size === 0;
  $("bulk-n").textContent = `${S.sel.size} selecionada(s)`;
}
$("rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr"); if (!tr) return;
  const id = Number(tr.dataset.id);
  if (e.target.classList.contains("play")) play(id);
  if (e.target.classList.contains("sel")) { e.target.checked ? S.sel.add(id) : S.sel.delete(id); renderBulk(); }
});
$("rows").addEventListener("change", async (e) => {
  if (!e.target.classList.contains("off")) return;
  const id = Number(e.target.closest("tr").dataset.id);
  const v = e.target.value === "" ? 0 : Number(e.target.value);
  if (!isFinite(v)) return;
  await setOffset([id], v, false);
});
async function setOffset(ids, v, relative) {
  try {
    const res = await api("/api/offset", { ids, offset_db: v, relative });
    for (const [id, off] of Object.entries(res)) { const t = S.byId.get(Number(id)); if (t) t.offset_db = off; }
    refresh();
  } catch (e) { toast(e.message, true); }
}
$("check-page").addEventListener("change", (e) => {
  const slice = S.list.slice(S.page * S.pageSize, (S.page + 1) * S.pageSize);
  for (const t of slice) e.target.checked ? S.sel.add(t.id) : S.sel.delete(t.id);
  renderTable();
});
$("select-filter").addEventListener("click", (e) => { e.preventDefault(); for (const t of S.list) S.sel.add(t.id); renderTable(); });
document.querySelectorAll("#bulk [data-rel]").forEach((b) => b.addEventListener("click", () => setOffset([...S.sel], Number(b.dataset.rel), true)));
$("bulk-zero").addEventListener("click", () => setOffset([...S.sel], 0, false));
$("bulk-clear").addEventListener("click", () => { S.sel.clear(); renderTable(); });
$("bulk-apply").addEventListener("click", () => runApply([...S.sel]));
$("bulk-revert").addEventListener("click", () => runRevert([...S.sel]));
document.querySelectorAll("th[data-sort]").forEach((th) => th.addEventListener("click", () => {
  const k = th.dataset.sort; S.sort = { key: k, asc: S.sort.key === k ? !S.sort.asc : k === "title" }; renderTable();
}));
let qt; $("q").addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(() => { S.page = 0; renderTable(); }, 150); });
$("filter").addEventListener("change", () => { S.page = 0; renderTable(); });
$("range-chip").addEventListener("click", () => { S.range = null; drawHist(); renderTable(); });
$("prev").addEventListener("click", () => { S.page--; renderTable(); });
$("next").addEventListener("click", () => { S.page++; renderTable(); });

// ---------------------------------------------------------------- configurações e ações
function isDirty() { return S.saved && (Number(S.settings.target_lufs) !== Number(S.saved.target_lufs) || !!S.settings.clip_limit !== !!S.saved.clip_limit); }
function syncSettingsUI() {
  $("target").value = S.settings.target_lufs; $("target-range").value = S.settings.target_lufs; $("clip").checked = !!S.settings.clip_limit;
  document.querySelectorAll(".presets .chip").forEach((c) => c.classList.toggle("active", Number(c.dataset.t) === Number(S.settings.target_lufs)));
}
function setTarget(v) {
  v = Math.max(-30, Math.min(-5, Number(v))); if (!isFinite(v)) return;
  S.settings.target_lufs = v; syncSettingsUI(); refresh();
}
$("target-range").addEventListener("input", (e) => setTarget(e.target.value));
$("target").addEventListener("change", (e) => setTarget(e.target.value));
$("clip").addEventListener("change", (e) => { S.settings.clip_limit = e.target.checked; refresh(); });
document.querySelectorAll(".presets .chip").forEach((c) => c.addEventListener("click", () => setTarget(c.dataset.t)));
async function saveSettings() {
  const s = await api("/api/settings", { target_lufs: Number(S.settings.target_lufs), clip_limit: !!S.settings.clip_limit });
  S.saved = { ...s }; S.settings = { ...s }; refresh();
}
$("btn-save").addEventListener("click", () => saveSettings().then(() => toast("Alvo salvo.")).catch((e) => toast(e.message, true)));
async function runApply(ids) {
  const n = ids ? S.tracks.filter((t) => ids.includes(t.id) && t.pending).length : S.tracks.filter((t) => t.pending).length;
  if (!n) { toast("Nenhuma dessas faixas precisa de tag nova."); return; }
  if (!confirm(`Gravar ReplayGain em ${n} arquivo(s) com alvo ${nf1(Number(S.settings.target_lufs))} LUFS?\n\nSó as tags mudam, o áudio não. Dá pra reverter depois.`)) return;
  try {
    if (isDirty()) await saveSettings();
    S.job = await api("/api/apply", { ids: ids || null }); S.wasRunning = true; renderJob();
  } catch (e) { toast(e.message, true); }
}
async function runRevert(ids) {
  const n = S.tracks.filter((t) => t.written_at && (!ids || ids.includes(t.id))).length;
  if (!n) { toast("Nenhuma dessas faixas foi gravada pelo app."); return; }
  if (!confirm(`Restaurar as tags ReplayGain originais em ${n} arquivo(s)?`)) return;
  try { S.job = await api("/api/revert", { ids: ids || null }); S.wasRunning = true; renderJob(); } catch (e) { toast(e.message, true); }
}
$("btn-apply").addEventListener("click", () => runApply(null));
$("btn-revert").addEventListener("click", () => runRevert(null));
$("btn-scan").addEventListener("click", () => startScan(false));
$("btn-rescan").addEventListener("click", () => startScan(true));
$("btn-cancel").addEventListener("click", () => api("/api/cancel", {}).catch(() => {}));
addEventListener("beforeunload", (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ""; } });

// ---------------------------------------------------------------- player com A/B
const audio = $("audio");
let actx, gainNode;
function ensureAudioGraph() {
  if (actx) return;
  actx = new (window.AudioContext || window.webkitAudioContext)();
  const src = actx.createMediaElementSource(audio);
  gainNode = actx.createGain();
  src.connect(gainNode).connect(actx.destination);
}
function currentGainDb() {
  const t = S.byId.get(S.playingId);
  return S.ab === "fix" && t && t.calc ? t.calc.tg : 0;
}
function updatePlayerGain() {
  if (S.playingId == null) return;
  const t = S.byId.get(S.playingId), db = currentGainDb();
  $("pl-gain").textContent = t && t.calc ? fmtDb(t.calc.tg) : "";
  if (gainNode) gainNode.gain.setTargetAtTime(10 ** (db / 20), actx.currentTime, 0.02);
}
function play(id) {
  const t = S.byId.get(id); if (!t) return;
  ensureAudioGraph(); actx.resume();
  S.playingId = id;
  audio.src = `/api/audio/${id}`;
  audio.play().catch((e) => toast("Não consegui tocar: " + e.message, true));
  $("player").hidden = false;
  $("pl-title").textContent = t.title || basename(t.path);
  $("pl-sub").textContent = [t.artist, t.lufs != null ? nf1(t.lufs) + " LUFS" : null].filter(Boolean).join(" · ");
  updatePlayerGain();
  document.querySelectorAll("#rows tr").forEach((tr) => tr.classList.toggle("playing", Number(tr.dataset.id) === id));
  drawScatter();
}
function step(d) {
  const i = S.list.findIndex((t) => t.id === S.playingId);
  const n = S.list[i + d]; if (n) play(n.id);
}
$("pl-play").addEventListener("click", () => { if (audio.paused) { actx && actx.resume(); audio.play(); } else audio.pause(); });
audio.addEventListener("play", () => ($("pl-play").textContent = "⏸"));
audio.addEventListener("pause", () => ($("pl-play").textContent = "▶"));
audio.addEventListener("ended", () => step(1));
audio.addEventListener("timeupdate", () => {
  if (audio.duration) $("pl-seek").value = (1000 * audio.currentTime / audio.duration).toFixed(0);
  $("pl-time").textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`;
});
$("pl-seek").addEventListener("input", (e) => { if (audio.duration) audio.currentTime = e.target.value / 1000 * audio.duration; });
$("pl-prev").addEventListener("click", () => step(-1));
$("pl-next").addEventListener("click", () => step(1));
$("pl-close").addEventListener("click", () => { audio.pause(); $("player").hidden = true; S.playingId = null; renderTable(); drawScatter(); });
$("ab-fix").addEventListener("click", () => { S.ab = "fix"; $("ab-fix").classList.add("active"); $("ab-orig").classList.remove("active"); updatePlayerGain(); });
$("ab-orig").addEventListener("click", () => { S.ab = "orig"; $("ab-orig").classList.add("active"); $("ab-fix").classList.remove("active"); updatePlayerGain(); });
addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea") || S.playingId == null) return;
  if (e.code === "Space") { e.preventDefault(); $("pl-play").click(); }
  if (e.key === "a" || e.key === "A") (S.ab === "fix" ? $("ab-orig") : $("ab-fix")).click();
});

// ---------------------------------------------------------------- início
pollState().then(loadTracks);
