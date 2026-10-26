import * as C from './core.js';

const $ = s => document.querySelector(s);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = s => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const icon = name => `<svg class="i"><use href="icons.svg#${name}"/></svg>`;
const view = $('#view'), ctx = view.getContext('2d');
const off = document.createElement('canvas'), offCtx = off.getContext('2d');

const doc = C.newDoc(32, 32); // mutated in place, never reassigned
const hist = new C.History();
let frame = 0, layer = 0, tool = 'pencil', size = 1;
let dyn = 'size', gamma = 1, grid = true, onion = false, playing = null, fingers = true;
let zoom = 8, panX = 0, panY = 0;
let sel = null; // selection rect in doc pixels, null = nothing selected
// color = foreground (what tools paint with), bg = background; the picker edits whichever is `editing`.
// hsv mirrors the edited color but is kept as its own state so hue survives greys and black.
let color = C.rgba(0, 0, 0), bg = C.rgba(255, 255, 255), editing = 'fg', hsv = { h: 0, s: 0, v: 0 }, sliderMode = 'rgb';

// ---------- canvas rendering ----------

const checker = (() => {
  const c = document.createElement('canvas'), x = c.getContext('2d');
  c.width = c.height = 16;
  x.fillStyle = '#9a9aa2'; x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#c4c4ca'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
  return ctx.createPattern(c, 'repeat');
})();

function blit(f, alpha) {
  if (off.width !== doc.w || off.height !== doc.h) { off.width = doc.w; off.height = doc.h; }
  offCtx.putImageData(new ImageData(new Uint8ClampedArray(C.composite(doc, f).buffer), doc.w, doc.h), 0, 0);
  ctx.globalAlpha = alpha;
  ctx.drawImage(off, panX, panY, doc.w * zoom, doc.h * zoom);
  ctx.globalAlpha = 1;
}

function render() {
  const dpr = devicePixelRatio || 1, cw = view.clientWidth, ch = view.clientHeight;
  if (view.width !== Math.round(cw * dpr) || view.height !== Math.round(ch * dpr)) {
    view.width = Math.round(cw * dpr); view.height = Math.round(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cw, ch);
  const W = doc.w * zoom, H = doc.h * zoom;
  ctx.fillStyle = '#0d0b12'; ctx.fillRect(panX + 6, panY + 6, W, H); // hard drop shadow
  ctx.save(); ctx.translate(panX, panY); ctx.fillStyle = checker; ctx.fillRect(0, 0, W, H); ctx.restore();
  if (onion && !playing) {
    if (frame > 0) blit(frame - 1, 0.3);
    if (frame < doc.frames.length - 1) blit(frame + 1, 0.15);
  }
  blit(frame, 1);
  if (grid && zoom >= 6) {
    ctx.beginPath();
    for (let x = 1; x < doc.w; x++) { ctx.moveTo(panX + x * zoom, panY); ctx.lineTo(panX + x * zoom, panY + H); }
    for (let y = 1; y < doc.h; y++) { ctx.moveTo(panX, panY + y * zoom); ctx.lineTo(panX + W, panY + y * zoom); }
    ctx.strokeStyle = 'rgba(40,40,50,.25)'; ctx.lineWidth = 1 / dpr; ctx.stroke();
  }
  ctx.strokeStyle = '#0d0b12'; ctx.lineWidth = 3; ctx.strokeRect(panX - 1.5, panY - 1.5, W + 3, H + 3);
  ctx.lineWidth = 1;
  if (sel) { // two-tone dashes so it shows on any colour
    const x = panX + sel.x * zoom + 0.5, y = panY + sel.y * zoom + 0.5, w = sel.w * zoom - 1, h = sel.h * zoom - 1;
    ctx.strokeStyle = '#fff'; ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([4, 4]); ctx.strokeStyle = '#000'; ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
  }
  // brush outline under a hovering pen / mouse
  if (hover && tool !== 'hand') {
    const s = ['pencil', 'eraser', 'line', 'rect'].includes(tool) ? size : 1, o = Math.floor(s / 2);
    const x = panX + (hover.x - o) * zoom, y = panY + (hover.y - o) * zoom;
    ctx.strokeStyle = '#000'; ctx.strokeRect(x - 0.5, y - 0.5, s * zoom + 1, s * zoom + 1);
    ctx.strokeStyle = '#fff'; ctx.strokeRect(x + 0.5, y + 0.5, s * zoom - 1, s * zoom - 1);
  }
  status();
}

function status() {
  const a = color >>> 24;
  $('#stTool').textContent = tool + ' tool';
  $('#stColor').textContent = C.u32ToHex(color) + (a < 255 ? ` ${Math.round(a / 2.55)}%` : '');
  $('#stBrush').textContent = `brush ${size}px`;
  $('#stLayer').textContent = doc.layers[layer].name;
  $('#stFrame').textContent = `frame ${frame + 1}/${doc.frames.length}`;
  $('#stSize').textContent = `${doc.w}x${doc.h}`;
  $('#stPos').textContent = hover ? `${hover.x},${hover.y}` : '';
  $('#zoom').value = Math.round(zoom);
  $('#zoomOut').textContent = Math.round(zoom * 100) + '%';
}

let queued = false;
const draw = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; render(); }); } };

// The part of the canvas not covered by floating panels, so fit() doesn't tuck the sprite under one.
function freeRect() {
  const W = view.clientWidth, H = view.clientHeight;
  let l = 0, t = 56, r = W, b = H; // t: room for the zoom bar
  if (!narrow.matches) for (const p of document.querySelectorAll('.panel:not(.hidden)')) {
    const x = p.offsetLeft, y = p.offsetTop, w = p.offsetWidth, h = p.offsetHeight;
    if (x + w / 2 < W * 0.3) l = Math.max(l, x + w);
    else if (x + w / 2 > W * 0.7) r = Math.min(r, x);
    else if (y + h / 2 > H / 2) b = Math.min(b, y);
  }
  return r - l < 120 || b - t < 120 ? { l: 0, t: 0, r: W, b: H } : { l, t, r, b };
}

function fit() {
  const { l, t, r, b } = freeRect();
  zoom = Math.max(1, Math.floor(Math.min((r - l) / doc.w, (b - t) / doc.h) * 0.9));
  panX = Math.round(l + (r - l - doc.w * zoom) / 2);
  panY = Math.round(t + (b - t - doc.h * zoom) / 2);
  draw();
}

// Point zoom at p (screen coords), default the canvas centre.
function zoomTo(z, p = { x: view.clientWidth / 2, y: view.clientHeight / 2 }) {
  z = clamp(z, 1, 64);
  panX = p.x - (p.x - panX) * z / zoom; panY = p.y - (p.y - panY) * z / zoom; zoom = z;
  draw();
}

// ---------- panels: layers, timeline, palette ----------

// Top layer first. Tapping the selected layer's name (or the rename button) edits it in place.
function renderLayers() {
  $('#layers').innerHTML = doc.layers.map((L, l) => `<div class="layer ${l === layer ? 'on' : ''}" data-l="${l}"><span class="name">${esc(L.name)}</span>`
    + `<button data-eye="${l}" title="Toggle visibility">${icon(L.visible ? 'eye' : 'eye-off')}</button></div>`).reverse().join('');
}

function startRename(l = layer) {
  const name = $(`.layer[data-l="${l}"] .name`);
  if (!name) return;
  const input = document.createElement('input');
  input.value = doc.layers[l].name;
  input.maxLength = 64;
  name.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = ok => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (ok && v && v !== doc.layers[l].name) structural(() => { doc.layers[l].name = v; });
    else renderLayers();
  };
  input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
}

// ponytail: redraws every thumbnail on each change; redraw only the edited frame if long animations lag.
function renderFrames() {
  $('#frames').replaceChildren(...doc.frames.map((_, f) => {
    const el = document.createElement('div'), c = document.createElement('canvas');
    el.className = 'frame'; el.dataset.f = f;
    c.width = doc.w; c.height = doc.h;
    c.className = 'checker';
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(C.composite(doc, f).buffer), doc.w, doc.h), 0, 0);
    el.append(c, String(f + 1));
    return el;
  }));
  markFrame();
}
const markFrame = () => document.querySelectorAll('.frame').forEach(el => el.classList.toggle('on', +el.dataset.f === frame));

function renderPalette() {
  const hex = C.u32ToHex(active());
  $('#palette').innerHTML = doc.palette.map((c, i) => `<button data-i="${i}" class="${c === hex ? 'on' : ''}" style="background:${c}"></button>`).join('')
    + `<button id="addColor" title="Add current color">${icon('plus')}</button>`;
}

function renderPanels() {
  renderLayers(); renderFrames(); renderPalette();
  $('#fps').value = doc.fps; $('#fpsOut').textContent = doc.fps;
}

function setTool(t) {
  tool = t;
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  draw();
}

// ---------- color picker (Aseprite-style: FG/BG, SV square, hue + alpha strips, RGB/HSV sliders) ----------

const active = () => (editing === 'fg' ? color : bg);
const rgbOf = c => [c & 255, c >> 8 & 255, c >> 16 & 255];
const css = c => `rgba(${rgbOf(c)},${(c >>> 24) / 255})`;
const CHECK = 'repeating-conic-gradient(#9a9aa2 0 25%, #c4c4ca 0 50%) 0 0 / 10px 10px';

function setColor(c, keepHsv) {
  c >>>= 0;
  if (editing === 'fg') color = c; else bg = c;
  if (!keepHsv) {
    const n = C.rgbToHsv(...rgbOf(c));
    if (!n.v) n.s = hsv.s;
    if (!n.s || !n.v) n.h = hsv.h;
    hsv = n;
  }
  syncColor();
}
function fromHsv(a = active() >>> 24) { setColor(C.rgba(...C.hsvToRgb(hsv.h, hsv.s, hsv.v), a), true); }

function syncColor() {
  $('#fgSw').style.background = `linear-gradient(${css(color)},${css(color)}), ${CHECK}`;
  $('#bgSw').style.background = `linear-gradient(${css(bg)},${css(bg)}), ${CHECK}`;
  $('#fgSw').classList.toggle('edit', editing === 'fg');
  $('#bgSw').classList.toggle('edit', editing === 'bg');
  if (document.activeElement !== $('#hex')) $('#hex').value = C.u32ToHex(active()).slice(1);
  drawPicker(); syncSliders(); renderPalette(); draw();
}

function fitCanvas(cv) {
  const dpr = devicePixelRatio || 1, w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return [cv.getContext('2d'), w, h, dpr];
}
function marker(x, px, py, w, h) {
  x.lineWidth = 2; x.strokeStyle = '#000'; x.strokeRect(px - w / 2, py - h / 2, w, h);
  x.strokeStyle = '#fff'; x.strokeRect(px - w / 2 + 2, py - h / 2 + 2, w - 4, h - 4);
}
function drawPicker() {
  let [x, w, h, d] = fitCanvas($('#sv'));
  x.fillStyle = `rgb(${C.hsvToRgb(hsv.h, 1, 1)})`; x.fillRect(0, 0, w, h);
  let g = x.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#fff'); g.addColorStop(1, '#fff0'); x.fillStyle = g; x.fillRect(0, 0, w, h);
  g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#0000'); g.addColorStop(1, '#000'); x.fillStyle = g; x.fillRect(0, 0, w, h);
  marker(x, hsv.s * w, (1 - hsv.v) * h, 12 * d, 12 * d);

  [x, w, h, d] = fitCanvas($('#hue'));
  g = x.createLinearGradient(0, 0, 0, h);
  for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  marker(x, w / 2, hsv.h / 360 * h, w, 8 * d);

  [x, w, h, d] = fitCanvas($('#alphaStrip'));
  const sq = 5 * d;
  for (let i = 0; i * sq < w; i++) for (let j = 0; j * sq < h; j++) { x.fillStyle = (i + j) % 2 ? '#9a9aa2' : '#c4c4ca'; x.fillRect(i * sq, j * sq, sq, sq); }
  const rgb = rgbOf(active());
  g = x.createLinearGradient(0, 0, w, 0); g.addColorStop(0, `rgba(${rgb},0)`); g.addColorStop(1, `rgb(${rgb})`);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  marker(x, (active() >>> 24) / 255 * w, h / 2, 8 * d, h);
}

const SLIDERS = { rgb: [['R', 'r', 255], ['G', 'g', 255], ['B', 'b', 255], ['A', 'a', 255]], hsv: [['H', 'h', 360], ['S', 's', 100], ['V', 'v', 100], ['A', 'a', 255]] };
function buildSliders() {
  $('#sliders').innerHTML = SLIDERS[sliderMode].map(([label, k, max]) =>
    `<div class="slider"><span>${label}</span><input type="range" data-k="${k}" min="0" max="${max}"><input type="number" data-k="${k}" min="0" max="${max}"></div>`).join('');
  syncSliders();
}
function syncSliders() {
  const c = active(), [r, g, b] = rgbOf(c), a = c >>> 24, { h, s, v } = hsv;
  const vals = { r, g, b, a, h: Math.round(h), s: Math.round(s * 100), v: Math.round(v * 100) };
  const rgb = (...c) => `rgb(${c})`, hs = (...c) => rgb(...C.hsvToRgb(...c));
  const grads = {
    r: [rgb(0, g, b), rgb(255, g, b)], g: [rgb(r, 0, b), rgb(r, 255, b)], b: [rgb(r, g, 0), rgb(r, g, 255)],
    h: [0, 60, 120, 180, 240, 300, 360].map(d => hs(d, 1, 1)), s: [hs(h, 0, v), hs(h, 1, v)], v: [hs(h, s, 0), hs(h, s, 1)],
    a: [`rgba(${r},${g},${b},0)`, rgb(r, g, b)],
  };
  for (const el of $('#sliders').querySelectorAll('input')) {
    const k = el.dataset.k;
    if (el !== document.activeElement || el.type === 'range') el.value = vals[k];
    if (el.type === 'range') el.style.background = `linear-gradient(90deg, ${grads[k]})` + (k === 'a' ? `, ${CHECK}` : '');
  }
}

// Drag handler for the picker canvases: fn gets the pointer position as 0..1 fractions.
function dragArea(el, fn) {
  const at = e => { const r = el.getBoundingClientRect(); fn(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)); };
  el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); at(e); });
  el.addEventListener('pointermove', e => { if (el.hasPointerCapture(e.pointerId)) at(e); });
}
dragArea($('#sv'), (x, y) => { hsv.s = x; hsv.v = 1 - y; fromHsv(); });
dragArea($('#hue'), (x, y) => { hsv.h = y * 360; fromHsv(); });
dragArea($('#alphaStrip'), x => fromHsv(Math.round(x * 255)));
new ResizeObserver(() => drawPicker()).observe($('#spectrum'));

$('#sliders').addEventListener('input', e => {
  const k = e.target.dataset.k, v = clamp(Math.round(+e.target.value) || 0, 0, +e.target.max), c = active();
  if (k === 'a') return fromHsv(v);
  if (k === 'h' || k === 's' || k === 'v') { hsv[k] = k === 'h' ? v : v / 100; return fromHsv(); }
  const ch = { r: c & 255, g: c >> 8 & 255, b: c >> 16 & 255 };
  ch[k] = v;
  setColor(C.rgba(ch.r, ch.g, ch.b, c >>> 24));
});
document.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  sliderMode = b.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === b));
  buildSliders();
});
$('#hex').onchange = e => {
  const v = e.target.value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(v)) setColor(C.rgba(...rgbOf(C.hexToU32('#' + v)), active() >>> 24));
  e.target.value = C.u32ToHex(active()).slice(1);
};
const editSwatch = which => { editing = which; setColor(active()); };
$('#fgSw').onclick = () => editSwatch('fg');
$('#bgSw').onclick = () => editSwatch('bg');
const swap = () => { [color, bg] = [bg, color]; setColor(active()); };
$('#swap').onclick = swap;

$('#palette').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'addColor') { const h = C.u32ToHex(active()); if (!doc.palette.includes(h)) { doc.palette.push(h); changed(); } }
  else setColor(C.hexToU32(doc.palette[b.dataset.i]));
});
$('#palette').addEventListener('contextmenu', e => {
  const i = e.target.closest('[data-i]')?.dataset.i;
  e.preventDefault();
  if (i != null) { doc.palette.splice(i, 1); changed(); }
});

// ---------- floating panels (drag by header, resize from the corner, collapse, close, remembered) ----------

const PANELS = ['tools', 'brush', 'color', 'layers', 'frames'];
const narrow = matchMedia('(max-width: 759px), (orientation: portrait) and (max-width: 1099px)'); // docked, see CSS
const panelsEl = $('#panels');
let layout = {}, topZ = 1;
try { layout = JSON.parse(localStorage.getItem('respite.panels')) || {}; } catch { /* private mode etc: defaults */ }

// Left column (tools, brush, layers), color on the right, timeline along the bottom between them.
// y and h may be functions of the panel, evaluated in PANELS order once widths are set, so they use real heights.
function defaultLayout() {
  const W = panelsEl.clientWidth, H = panelsEl.clientHeight;
  const below = id => () => { const p = $('#p-' + id); return p.offsetTop + p.offsetHeight + 12; };
  return {
    tools: { x: 12, y: 12, w: 248 },
    brush: { x: 12, y: below('tools'), w: 248, collapsed: H < 760 && !narrow.matches }, // short screens: make room for layers
    color: { x: W - 304, y: 12, w: 290 },
    layers: { x: 12, y: below('brush'), w: 248, h: el => Math.max(170, H - el.offsetTop - 12) },
    frames: { x: 272, y: el => H - el.offsetHeight - 12, w: Math.max(300, W - 272 - 316) },
  };
}

function clampPanel(el) {
  if (narrow.matches) return;
  el.style.left = clamp(el.offsetLeft, 0, Math.max(0, panelsEl.clientWidth - el.offsetWidth)) + 'px';
  el.style.top = clamp(el.offsetTop, 0, Math.max(0, panelsEl.clientHeight - el.offsetHeight)) + 'px';
}

function applyLayout() {
  const d = defaultLayout();
  for (const id of PANELS) {
    const el = $('#p-' + id), s = { ...d[id], ...layout[id] };
    el.classList.toggle('collapsed', !!s.collapsed);
    el.classList.toggle('hidden', !!s.hidden);
    Object.assign(el.style, { left: s.x + 'px', width: s.w + 'px', height: typeof s.h === 'number' ? s.h + 'px' : '' });
    el.style.top = (typeof s.y === 'function' ? s.y(el) : s.y) + 'px';
    if (typeof s.h === 'function') el.style.height = s.h(el) + 'px';
    fixMinHeight(el);
    clampPanel(el);
  }
  syncToggles();
}

// Docked panels have no meaningful position, so only their collapsed/hidden state is kept then.
function remember(el) {
  const id = el.id.slice(2), state = { collapsed: el.classList.contains('collapsed'), hidden: el.classList.contains('hidden') };
  layout[id] = narrow.matches ? { ...layout[id], ...state }
    : { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.style.height ? el.offsetHeight : undefined, ...state };
  try { localStorage.setItem('respite.panels', JSON.stringify(layout)); } catch { /* not persisted, fine */ }
  fixMinHeight(el);
  syncToggles();
}

// Layers and Color keep their controls visible and scroll only the list, so they can't get shorter than the controls.
function fixMinHeight(el) {
  const list = el.querySelector('#layers, #palette');
  if (!list || el.classList.contains('collapsed') || el.classList.contains('hidden')) return;
  const pb = el.querySelector('.pb'), cs = getComputedStyle(pb), kids = [...pb.children];
  const fixed = kids.reduce((sum, k) => sum + (k === list ? 44 : k.offsetHeight), 0) + parseFloat(cs.rowGap) * (kids.length - 1);
  el.style.minHeight = el.querySelector('.ph').offsetHeight + fixed + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 6 + 'px';
}

const syncToggles = () => document.querySelectorAll('[data-toggle]').forEach(b => b.classList.toggle('on', !$('#p-' + b.dataset.toggle).classList.contains('hidden')));

for (const id of PANELS) {
  const el = $('#p-' + id), ph = el.querySelector('.ph'), grip = el.querySelector('.grip');
  let drag = null, resize = null;
  el.addEventListener('pointerdown', () => { el.style.zIndex = ++topZ; }, true);

  ph.addEventListener('pointerdown', e => {
    if (narrow.matches || e.target.closest('button')) return;
    ph.setPointerCapture(e.pointerId);
    drag = { dx: e.clientX - el.offsetLeft, dy: e.clientY - el.offsetTop };
  });
  ph.addEventListener('pointermove', e => {
    if (!drag) return;
    el.style.left = e.clientX - drag.dx + 'px';
    el.style.top = e.clientY - drag.dy + 'px';
    clampPanel(el);
  });
  const endDrag = () => { if (drag) { drag = null; remember(el); } };
  ph.addEventListener('pointerup', endDrag);
  ph.addEventListener('pointercancel', endDrag);

  grip.addEventListener('pointerdown', e => {
    grip.setPointerCapture(e.pointerId);
    resize = { x: e.clientX, y: e.clientY, w: el.offsetWidth, h: el.offsetHeight };
  });
  grip.addEventListener('pointermove', e => {
    if (!resize) return;
    el.style.width = clamp(resize.w + e.clientX - resize.x, 150, panelsEl.clientWidth - el.offsetLeft) + 'px';
    el.style.height = clamp(resize.h + e.clientY - resize.y, 90, panelsEl.clientHeight - el.offsetTop) + 'px';
  });
  const endResize = () => { if (resize) { resize = null; remember(el); } };
  grip.addEventListener('pointerup', endResize);
  grip.addEventListener('pointercancel', endResize);

  el.querySelector('.min').onclick = () => { el.classList.toggle('collapsed'); clampPanel(el); remember(el); };
  el.querySelector('.close').onclick = () => { el.classList.add('hidden'); remember(el); };
}

$('#toggles').addEventListener('click', e => {
  const b = e.target.closest('[data-toggle]');
  if (!b) return;
  const el = $('#p-' + b.dataset.toggle);
  el.classList.toggle('hidden');
  el.style.zIndex = ++topZ;
  clampPanel(el);
  remember(el);
});

// Rotating between docked (portrait) and floating (landscape): positions computed for one are wrong for the other.
narrow.addEventListener('change', () => { applyLayout(); fit(); });
// Rotation, split screen, soft keyboard: keep every panel reachable.
new ResizeObserver(() => document.querySelectorAll('.panel').forEach(clampPanel)).observe(panelsEl);

// ---------- document changes ----------

let saveTimer;
function changed() {
  draw(); renderPanels();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
}

function clampSel() {
  frame = clamp(frame, 0, doc.frames.length - 1);
  layer = clamp(layer, 0, doc.layers.length - 1);
  sel = sel && C.clipRect(sel, doc.w, doc.h); // undo of New/Open can shrink the canvas
}

// Any edit that changes doc shape: snapshot so it can be undone. fn returning false = no-op.
function structural(fn) {
  const before = C.cloneDoc(doc);
  if (fn() === false) return;
  hist.push({ before, after: C.cloneDoc(doc) });
  clampSel(); changed();
}

const undo = () => { stopPlay(); if (hist.undo(doc)) { clampSel(); changed(); } };
const redo = () => { stopPlay(); if (hist.redo(doc)) { clampSel(); changed(); } };

// ---------- canvas input ----------

function screenPt(e) {
  const r = view.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function docPt(e) {
  const p = screenPt(e);
  return { x: Math.floor((p.x - panX) / zoom), y: Math.floor((p.y - panY) / zoom) };
}

const pointers = new Map();
let stroke = null, pinch = null, pan = null, hover = null;
let tap = null; // multi-finger tap: 2 = undo, 3 = redo

function pick(p) {
  if (p.x < 0 || p.y < 0 || p.x >= doc.w || p.y >= doc.h) return;
  const c = C.composite(doc, frame)[p.y * doc.w + p.x];
  if (c >>> 24) setColor(c);
}

// Pen pressure (0..1) shaped by the user's curve; mouse, fingers and passive styluses count as full pressure.
function dab(p, e) {
  const pr = e?.pointerType === 'pen' ? Math.pow(clamp(e.pressure, 0, 1), gamma) : 1;
  const sz = dyn.includes('size') ? Math.max(1, Math.round(size * pr)) : size;
  const a = Math.round((color >>> 24) * (dyn.includes('alpha') ? pr : 1));
  stroke.s.dab(p.x, p.y, sz, C.withAlpha(color, a), stroke.erase);
}

function beginStroke(e) {
  stopPlay();
  const p = docPt(e);
  // button 2 = stylus side button / right mouse: eyedropper while held
  if (tool === 'picker' || e.button === 2) { stroke = { pick: true }; return pick(p); }
  if (tool === 'select') { stroke = { select: true, start: p, moved: false }; return; }
  const cel = doc.frames[frame][layer];
  if (tool === 'move') { stroke = { move: true, cel, before: cel.slice(), start: p, r: sel ?? { x: 0, y: 0, w: doc.w, h: doc.h } }; return; }
  const s = new C.Stroke(cel, doc.w, doc.h, sel);
  // button 5 = the eraser end of a stylus
  stroke = { s, start: p, last: p, erase: tool === 'eraser' || e.button === 5 };
  if (tool === 'fill' && !stroke.erase) { C.fill(s.cel, doc.w, doc.h, p.x, p.y, color, sel); return endStroke(); }
  dab(p, e);
  draw();
}

function moveStroke(e) {
  const p = docPt(e);
  if (stroke.pick) return pick(p);
  if (stroke.select) {
    stroke.moved ||= p.x !== stroke.start.x || p.y !== stroke.start.y;
    sel = C.rectFrom(stroke.start.x, stroke.start.y, p.x, p.y, doc.w, doc.h);
    return draw();
  }
  if (stroke.move) {
    const dx = p.x - stroke.start.x, dy = p.y - stroke.start.y, r = stroke.r;
    C.shift(stroke.before, doc.w, doc.h, r, dx, dy, stroke.cel);
    if (sel) sel = C.clipRect({ ...r, x: r.x + dx, y: r.y + dy }, doc.w, doc.h);
    return draw();
  }
  if (tool === 'line' || tool === 'rect') {
    stroke.s.reset();
    C[tool](stroke.start.x, stroke.start.y, p.x, p.y, (x, y) => dab({ x, y }, null));
  } else {
    C.line(stroke.last.x, stroke.last.y, p.x, p.y, (x, y) => dab({ x, y }, e));
  }
  stroke.last = p;
  draw();
}

function endStroke() {
  const st = stroke;
  stroke = null;
  if (st?.select && !st.moved) sel = null; // a tap with the select tool deselects
  const cel = st?.s?.cel ?? st?.cel, before = st?.s?.before ?? st?.before;
  if (!cel) return draw();
  commitCel(cel, before);
}

// Record a cel edit for undo if anything actually changed.
function commitCel(cel, before) {
  const after = cel.slice();
  if (after.some((v, i) => v !== before[i])) { hist.push({ f: frame, l: layer, before, after }); changed(); }
  else draw();
}

function cancelStroke() {
  stroke?.s?.reset();
  if (stroke?.move) { stroke.cel.set(stroke.before); if (sel) sel = stroke.r; }
  stroke = null;
  draw();
}

const mid = (a, b) => { const p = screenPt(a), q = screenPt(b); return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; };
const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;

view.addEventListener('pointerdown', e => {
  // Palm rejection: touches are ignored while the pen is down, and the pen pre-empts any fingers.
  if (e.pointerType === 'touch' && [...pointers.values()].some(p => p.pointerType === 'pen')) return;
  if (e.pointerType === 'pen') { cancelStroke(); pinch = pan = tap = null; pointers.clear(); }
  view.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, e);
  if (e.pointerType === 'touch') {
    if (pointers.size === 1) tap = { t: e.timeStamp, n: 1, start: new Map() };
    if (tap) { tap.n = Math.max(tap.n, pointers.size); tap.start.set(e.pointerId, screenPt(e)); }
  }
  if (pointers.size === 2) {
    // second finger: the first finger's stroke was really the start of a pinch
    cancelStroke(); pan = null;
    const [a, b] = pointers.values(), c = mid(a, b);
    pinch = { d: dist(a, b), zoom, px: (c.x - panX) / zoom, py: (c.y - panY) / zoom };
    return;
  }
  if (pointers.size > 2) return;
  // Fingers (and passive styluses, which report as touch) draw unless the user turned that off.
  if (tool === 'hand' || e.button === 1 || (!fingers && e.pointerType === 'touch')) {
    const p = screenPt(e);
    pan = { x: p.x - panX, y: p.y - panY };
    return;
  }
  if (e.button === 0 || e.button === 2 || e.button === 5) beginStroke(e);
});

view.addEventListener('pointermove', e => {
  if (e.pointerType !== 'touch') { hover = docPt(e); draw(); }
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, e);
  const t0 = tap?.start.get(e.pointerId);
  if (t0) { const q = screenPt(e); if (Math.hypot(q.x - t0.x, q.y - t0.y) > 12) tap = null; }
  if (pinch) {
    const [a, b] = pointers.values(), c = mid(a, b);
    zoom = clamp(pinch.zoom * dist(a, b) / pinch.d, 1, 64);
    panX = c.x - pinch.px * zoom; panY = c.y - pinch.py * zoom;
    return draw();
  }
  if (pan) { const p = screenPt(e); panX = p.x - pan.x; panY = p.y - pan.y; return draw(); }
  if (!stroke) return;
  const evs = e.getCoalescedEvents?.();
  for (const ev of evs?.length ? evs : [e]) moveStroke(ev);
});

const pointerEnd = e => {
  if (!pointers.delete(e.pointerId)) return;
  if (!pointers.size && tap) {
    const t = tap;
    tap = null;
    if (t.n >= 2 && e.timeStamp - t.t < 300) { pinch = pan = null; return t.n === 2 ? undo() : redo(); }
  }
  if (pinch) { if (pointers.size < 2) pinch = null; return; }
  pan = null;
  endStroke();
};
view.addEventListener('pointerup', pointerEnd);
view.addEventListener('pointercancel', pointerEnd);
view.addEventListener('contextmenu', e => e.preventDefault());
view.addEventListener('pointerleave', () => { hover = null; draw(); });
view.addEventListener('wheel', e => { e.preventDefault(); zoomTo(zoom * (e.deltaY < 0 ? 1.25 : 0.8), screenPt(e)); }, { passive: false });
new ResizeObserver(draw).observe(view);

// ---------- controls ----------

$('#tools').addEventListener('click', e => { const t = e.target.closest('[data-tool]'); if (t) setTool(t.dataset.tool); });
const selectAll = () => { sel = { x: 0, y: 0, w: doc.w, h: doc.h }; draw(); };
const deselect = () => { sel = null; draw(); };
function clearSelection() {
  const cel = doc.frames[frame][layer], before = cel.slice(), r = sel ?? { x: 0, y: 0, w: doc.w, h: doc.h };
  for (let y = r.y; y < r.y + r.h; y++) cel.fill(0, y * doc.w + r.x, y * doc.w + r.x + r.w);
  commitCel(cel, before);
}
$('#selAll').onclick = selectAll;
$('#selNone').onclick = deselect;
$('#selClear').onclick = clearSelection;
$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#size').oninput = e => { size = +e.target.value; $('#sizeOut').textContent = size; draw(); };
$('#dyn').onchange = e => { dyn = e.target.value; };
$('#gamma').oninput = e => { gamma = +e.target.value; $('#gammaOut').textContent = gamma; };
$('#fingers').onchange = e => { fingers = e.target.checked; };
$('#grid').onclick = e => { grid = !grid; e.currentTarget.classList.toggle('on', grid); draw(); };
$('#zoom').oninput = e => zoomTo(+e.target.value);
$('#zoomMinus').onclick = () => zoomTo(zoom / 1.25);
$('#zoomPlus').onclick = () => zoomTo(zoom * 1.25);
$('#fit').onclick = () => fit();

$('#layers').addEventListener('click', e => {
  if (e.target.closest('input')) return;
  const d = e.target.closest('[data-eye],[data-l]')?.dataset;
  if (!d) return;
  if (d.eye != null) { const L = doc.layers[d.eye]; L.visible = !L.visible; return changed(); }
  if (+d.l === layer && e.target.closest('.name')) return startRename();
  layer = +d.l;
  draw(); renderLayers();
});
$('#renameLayer').onclick = () => startRename();
$('#frames').addEventListener('click', e => {
  const f = e.target.closest('[data-f]')?.dataset.f;
  if (f == null) return;
  stopPlay();
  frame = +f;
  draw(); markFrame();
});

$('#addLayer').onclick = () => structural(() => { C.addLayer(doc, ++layer); });
$('#delLayer').onclick = () => structural(() => C.removeLayer(doc, layer));
$('#layerUp').onclick = () => structural(() => { if (C.moveLayer(doc, layer, layer + 1) === false) return false; layer++; });
$('#layerDown').onclick = () => structural(() => { if (C.moveLayer(doc, layer, layer - 1) === false) return false; layer--; });
$('#addFrame').onclick = () => structural(() => { stopPlay(); C.addFrame(doc, ++frame); });
$('#dupFrame').onclick = () => structural(() => { stopPlay(); C.addFrame(doc, frame + 1, frame); frame++; });
$('#delFrame').onclick = () => structural(() => { stopPlay(); return C.removeFrame(doc, frame); });
$('#frameLeft').onclick = () => structural(() => { stopPlay(); if (C.moveFrame(doc, frame, frame - 1) === false) return false; frame--; });
$('#frameRight').onclick = () => structural(() => { stopPlay(); if (C.moveFrame(doc, frame, frame + 1) === false) return false; frame++; });
$('#onion').onchange = e => { onion = e.target.checked; draw(); };
$('#play').onclick = () => (playing ? stopPlay() : startPlay());
$('#fps').oninput = e => { $('#fpsOut').textContent = e.target.value; };
$('#fps').onchange = e => {
  doc.fps = clamp(Math.round(+e.target.value) || 8, 1, 60);
  if (playing) { stopPlay(); startPlay(); }
  changed();
};

function startPlay() {
  if (doc.frames.length < 2) return;
  playing = setInterval(() => { frame = (frame + 1) % doc.frames.length; draw(); markFrame(); }, 1000 / doc.fps);
  $('#play').innerHTML = icon('pause');
  $('#play').classList.add('on');
  draw();
}
function stopPlay() {
  if (!playing) return;
  clearInterval(playing);
  playing = null;
  $('#play').innerHTML = icon('play');
  $('#play').classList.remove('on');
  draw();
}

addEventListener('keydown', e => {
  if (e.target.matches('input, select') || document.querySelector('dialog[open]') || !home.hidden) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod && k === 'y') { e.preventDefault(); return redo(); }
  if (mod && k === 'a') { e.preventDefault(); return selectAll(); }
  if (mod && k === 'd') { e.preventDefault(); return deselect(); }
  if (mod) return;
  const tools = { b: 'pencil', e: 'eraser', g: 'fill', i: 'picker', l: 'line', u: 'rect', h: 'hand', m: 'select', v: 'move' };
  if (tools[k]) setTool(tools[k]);
  else if (k === 'escape') deselect();
  else if (k === 'delete' || k === 'backspace') clearSelection();
  else if (k === 'x') swap();
  else if (k === 'enter') playing ? stopPlay() : startPlay();
  else if (k === ',') { stopPlay(); frame = (frame - 1 + doc.frames.length) % doc.frames.length; draw(); markFrame(); }
  else if (k === '.') { stopPlay(); frame = (frame + 1) % doc.frames.length; draw(); markFrame(); }
  else if (k === '[' || k === ']') { $('#size').value = size = clamp(size + (k === ']' ? 1 : -1), 1, 16); $('#sizeOut').textContent = size; draw(); }
  else if (k === '0') fit();
});

// ---------- dialogs & files ----------

// In-app replacement for prompt()/confirm(), which are unreliable inside the Android WebView.
// value === null makes it a yes/no question: resolves '' for OK, null for Cancel.
function ask(label, value) {
  const d = $('#ask'), input = $('#askInput');
  $('#askLabel').textContent = label;
  input.hidden = value === null;
  input.value = value ?? '';
  d.returnValue = '';
  d.showModal();
  if (!input.hidden) { input.focus(); input.select(); }
  return new Promise(res => { d.onclose = () => res(d.returnValue === 'ok' ? input.value : null); });
}
const parseSize = v => { const m = /^\s*(\d+)\s*(?:[x× ,]\s*(\d+))?\s*$/i.exec(v || ''); return m && [+m[1], +(m[2] ?? m[1])]; };

const menu = $('#menu');
$('#menuBtn').onclick = () => menu.showModal();
$('#closeMenu').onclick = () => menu.close();
const menuAction = fn => () => { menu.close(); fn(); };

// Browser: download link. Android app: <a download> does nothing in a WebView, so write to cache and open the share sheet.
async function saveFile(name, blob) {
  const cap = window.Capacitor;
  try {
    if (cap?.isNativePlatform?.()) {
      const data = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(blob); });
      const { Filesystem, Share } = cap.Plugins;
      const { uri } = await Filesystem.writeFile({ path: name, data, directory: 'CACHE' });
      await Share.share({ title: name, files: [uri] });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  } catch (err) {
    if (!/cancel/i.test(err?.message)) alert('Export failed: ' + err.message);
  }
}

async function exportPixels(name, px, w, h) {
  const s = clamp(Math.round(+await ask('Export scale (1–32)', '1')) || 0, 0, 32);
  if (!s) return;
  const src = document.createElement('canvas'), out = document.createElement('canvas');
  src.width = w; src.height = h;
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
  out.width = w * s; out.height = h * s;
  const o = out.getContext('2d');
  o.imageSmoothingEnabled = false;
  o.drawImage(src, 0, 0, w * s, h * s);
  out.toBlob(b => saveFile(name, b), 'image/png');
}

const fileBase = () => (current?.name || 'sprite').replace(/[^\w.-]+/g, '_');
$('#exportPng').onclick = menuAction(() => exportPixels(`${fileBase()}-frame${frame + 1}.png`, C.composite(doc, frame), doc.w, doc.h));
$('#exportSheet').onclick = menuAction(() => { const s = C.sheet(doc); exportPixels(`${fileBase()}-sheet.png`, s.px, s.w, s.h); });
$('#save').onclick = menuAction(() => saveFile(`${fileBase()}.respite`, new Blob([C.toJSON(doc)], { type: 'application/json' })));
$('#resetLayout').onclick = menuAction(() => {
  layout = {};
  try { localStorage.removeItem('respite.panels'); } catch { /* nothing stored */ }
  applyLayout();
  fit();
});

async function imagePixels(f, max) {
  const img = await createImageBitmap(f);
  if (img.width > max || img.height > max) throw Error(`image larger than ${max}px`);
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  return { px: new Uint32Array(x.getImageData(0, 0, img.width, img.height).data.buffer), w: img.width, h: img.height };
}

// ---------- projects (IndexedDB: 'index' = list of {id, name, updated, w, h, frames, thumb}, 'p:<id>' = the doc) ----------

function idb(mode, fn) {
  return new Promise((res, rej) => {
    const r = indexedDB.open('respite', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const tx = r.result.transaction('kv', mode), q = fn(tx.objectStore('kv'));
      tx.oncomplete = () => res(q.result);
      tx.onerror = () => rej(tx.error);
    };
  });
}
const db = {
  get: k => idb('readonly', s => s.get(k)),
  put: (k, v) => idb('readwrite', s => s.put(v, k)),
  del: k => idb('readwrite', s => s.delete(k)),
};

let projects = [], current = null;
const home = $('#home');
const newId = () => crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);

// Card thumbnail of frame 0, at most 128px: small sprites scale up by whole pixels, big ones scale down.
function thumbnail(d) {
  const big = Math.max(d.w, d.h), k = big <= 128 ? Math.floor(128 / big) : 128 / big;
  const t = document.createElement('canvas'), c = document.createElement('canvas');
  t.width = d.w; t.height = d.h;
  t.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(C.composite(d, 0).buffer), d.w, d.h), 0, 0);
  c.width = Math.max(1, Math.round(d.w * k)); c.height = Math.max(1, Math.round(d.h * k));
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  x.drawImage(t, 0, 0, c.width, c.height);
  return c.toDataURL();
}

// Writes the open project and refreshes its card data. The doc goes first so the index never points at nothing.
async function save() {
  if (!current) return;
  Object.assign(current, { updated: Date.now(), w: doc.w, h: doc.h, frames: doc.frames.length, thumb: thumbnail(doc) });
  try {
    await db.put('p:' + current.id, doc);
    await db.put('index', projects);
  } catch (err) {
    console.warn('autosave failed', err);
  }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(saveTimer); save(); } });

function ago(t) {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(t).toLocaleDateString();
}

function renderHome() {
  $('#projects').innerHTML = projects.length ? projects.map(p => `<div class="card proj" data-id="${p.id}">
      <div class="thumb">${p.thumb ? `<img src="${p.thumb}" alt="">` : ''}</div>
      <div class="pname">${esc(p.name)}</div>
      <div class="meta">${p.w}×${p.h} · ${p.frames} frame${p.frames === 1 ? '' : 's'} · ${ago(p.updated)}</div>
      <div class="row">
        <button data-act="rename" title="Rename">${icon('rename')}</button>
        <button data-act="dup" title="Duplicate">${icon('copy')}</button>
        <button data-act="del" title="Delete">${icon('trash')}</button>
      </div>
    </div>`).join('')
    : '<div class="card empty">No sprites yet. Make one up there ↑</div>';
}

function showHome() {
  stopPlay();
  renderHome();
  home.hidden = false;
}

async function goHome() {
  clearTimeout(saveTimer);
  await save();
  current = null;
  showHome();
}

function enterEditor(p, d) {
  current = p;
  Object.assign(doc, d);
  hist.undos.length = hist.redos.length = 0;
  frame = layer = 0;
  sel = null;
  stroke = null;
  home.hidden = true;
  $('#projName').textContent = p.name;
  renderPanels(); syncColor(); fit();
  history.pushState({ editor: true }, ''); // Android back / browser back returns to the projects
}

async function createProject(d, name) {
  const p = { id: newId(), name, updated: Date.now() };
  projects.unshift(p);
  enterEditor(p, d);
  await save();
}

async function openProject(id) {
  const p = projects.find(x => x.id === id), d = p && await db.get('p:' + id);
  if (!d) return alert('That project could not be loaded.');
  projects = [p, ...projects.filter(x => x !== p)]; // most recent first
  enterEditor(p, d);
}

const untitled = () => `Sprite ${projects.length + 1}`;
const nameFromFile = f => f.name.replace(/\.[^.]+$/, '') || untitled();

$('#sizes').addEventListener('click', async e => {
  const b = e.target.closest('[data-size]');
  if (!b) return;
  const size = b.dataset.size === 'custom' ? parseSize(await ask('Sprite size (W x H)', '48x48')) : [+b.dataset.size, +b.dataset.size];
  if (!size) return;
  if (!size[0] || !size[1] || size[0] > C.MAX || size[1] > C.MAX) return alert(`Size must be 1–${C.MAX}`);
  createProject(C.newDoc(size[0], size[1]), untitled());
});

$('#projects').addEventListener('click', async e => {
  const card = e.target.closest('.proj');
  if (!card) return;
  const p = projects.find(x => x.id === card.dataset.id), act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return openProject(p.id);
  if (act === 'rename') {
    const name = (await ask('Rename sprite', p.name))?.trim();
    if (name) { p.name = name; await db.put('index', projects); renderHome(); }
  } else if (act === 'dup') {
    const d = await db.get('p:' + p.id);
    if (!d) return;
    const copy = { ...p, id: newId(), name: p.name + ' copy', updated: Date.now() };
    await db.put('p:' + copy.id, d);
    projects.unshift(copy);
    await db.put('index', projects);
    renderHome();
  } else if (act === 'del') {
    if (await ask(`Delete "${p.name}"? This can't be undone.`, null) === null) return;
    projects = projects.filter(x => x !== p);
    await db.put('index', projects);
    await db.del('p:' + p.id);
    renderHome();
  }
});

$('#homeBtn').onclick = () => history.back(); // popstate does the work, so back button and home button match
addEventListener('popstate', () => { if (!home.hidden) return; goHome(); });
$('#projName').onclick = async () => {
  const name = (await ask('Rename sprite', current.name))?.trim();
  if (name) { current.name = name; $('#projName').textContent = name; save(); }
};

// The same file picker serves Open and Import spritesheet; both make a new project.
let fileMode = 'open';
$('#open').onclick = () => { fileMode = 'open'; $('#file').click(); };
$('#importSheet').onclick = () => { fileMode = 'sheet'; $('#file').click(); };
$('#file').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    let d;
    if (fileMode === 'sheet') {
      const { px, w, h } = await imagePixels(f, 8192);
      const size = parseSize(await ask(`Frame size in this ${w}x${h} sheet (W x H)`, `${h}x${h}`));
      if (!size) return;
      if (size[0] > C.MAX || size[1] > C.MAX || !size[0] || !size[1]) throw Error(`frame size must be 1–${C.MAX}`);
      d = C.fromSheet(px, w, h, size[0], size[1]);
    } else if (f.type.startsWith('image/')) {
      const { px, w, h } = await imagePixels(f, C.MAX);
      d = C.newDoc(w, h);
      d.frames[0][0].set(px);
    } else {
      d = C.fromJSON(await f.text());
    }
    createProject(d, nameFromFile(f));
  } catch (err) {
    alert('Could not open file: ' + err.message);
  }
};

// ---------- boot ----------

setTool('pencil');
buildSliders();
setColor(C.hexToU32(doc.palette[0] ?? '#000000'));
renderPanels();
showHome(); // the project list fills in once IndexedDB answers
// Panel heights depend on the pixel font, but don't hang the UI on it.
await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 800))]);
applyLayout();
fit();
document.body.classList.add('ready');
db.get('index').then(list => { projects = list || []; if (!current) renderHome(); }).catch(err => console.warn('could not load projects', err));
