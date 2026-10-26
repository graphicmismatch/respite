// Pure document model, no DOM. Pixels are Uint32 0xAABBGGRR, i.e. RGBA bytes on
// little-endian hosts, so a cel's buffer can be handed straight to ImageData.

export const MAX = 1024;
export const PALETTE = ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
  '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const rgba = (r, g, b, a = 255) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
export const withAlpha = (c, a) => a ? ((c & 0xffffff) | (a << 24)) >>> 0 : 0;
export const hexToU32 = h => { const n = parseInt(h.slice(1, 7), 16); return rgba(n >> 16 & 255, n >> 8 & 255, n & 255); };
export const u32ToHex = c => '#' + [c & 255, c >> 8 & 255, c >> 16 & 255].map(v => v.toString(16).padStart(2, '0')).join('');

// h in degrees 0..360, s and v 0..1.
export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max / 255 };
}
export function hsvToRgb(h, s, v) {
  const f = n => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return [f(5), f(3), f(1)];
}

// Straight-alpha "src over dst".
export function over(dst, src) {
  const sa = (src >>> 24) / 255;
  if (sa === 1) return src >>> 0;
  if (sa === 0) return dst >>> 0;
  const da = (dst >>> 24) / 255, oa = sa + da * (1 - sa);
  const ch = s => Math.round((((src >> s) & 255) * sa + ((dst >> s) & 255) * da * (1 - sa)) / oa);
  return rgba(ch(0), ch(8), ch(16), Math.round(oa * 255));
}

// Layer 0 is the bottom. frames[f][l] is one cel.
export const newDoc = (w, h, palette = PALETTE) => ({
  w, h, fps: 8, palette: [...palette], layers: [{ name: 'Layer 1', visible: true }], frames: [[new Uint32Array(w * h)]],
});
export const cloneDoc = d => ({ ...d, palette: [...d.palette], layers: d.layers.map(l => ({ ...l })), frames: d.frames.map(f => f.map(c => c.slice())) });

export function addLayer(d, at) {
  d.layers.splice(at, 0, { name: 'Layer ' + (d.layers.length + 1), visible: true });
  d.frames.forEach(f => f.splice(at, 0, new Uint32Array(d.w * d.h)));
}
export function removeLayer(d, at) {
  if (d.layers.length < 2) return false;
  d.layers.splice(at, 1);
  d.frames.forEach(f => f.splice(at, 1));
}
export function moveLayer(d, from, to) {
  if (to < 0 || to >= d.layers.length) return false;
  const mv = a => a.splice(to, 0, a.splice(from, 1)[0]);
  mv(d.layers);
  d.frames.forEach(mv);
}
// src = index of frame to duplicate, or null for an empty frame.
export function addFrame(d, at, src = null) {
  d.frames.splice(at, 0, src == null ? d.layers.map(() => new Uint32Array(d.w * d.h)) : d.frames[src].map(c => c.slice()));
}
export function moveFrame(d, from, to) {
  if (to < 0 || to >= d.frames.length) return false;
  d.frames.splice(to, 0, d.frames.splice(from, 1)[0]);
}
export function removeFrame(d, at) {
  if (d.frames.length < 2) return false;
  d.frames.splice(at, 1);
}

export function line(x0, y0, x1, y1, plot) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  for (let e = dx + dy; ;) {
    plot(x0, y0);
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * e;
    if (e2 >= dy) { e += dy; x0 += sx; }
    if (e2 <= dx) { e += dx; y0 += sy; }
  }
}
export function rect(x0, y0, x1, y1, plot) {
  line(x0, y0, x1, y0, plot); line(x1, y0, x1, y1, plot);
  line(x1, y1, x0, y1, plot); line(x0, y1, x0, y0, plot);
}

// Selections are rects {x, y, w, h} in doc pixels; null means "everything".
export const inRect = (r, x, y) => !r || (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
export function clipRect(r, w, h) {
  const x0 = Math.max(r.x, 0), y0 = Math.max(r.y, 0), x1 = Math.min(r.x + r.w, w), y1 = Math.min(r.y + r.h, h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
export const rectFrom = (x0, y0, x1, y1, w, h) =>
  clipRect({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0) + 1, h: Math.abs(y1 - y0) + 1 }, w, h);

// Lift the pixels inside r out of src and drop them dx,dy away, over whatever is there. Off-canvas pixels are lost.
export function shift(src, w, h, r, dx, dy, out = new Uint32Array(src.length)) {
  out.set(src);
  for (let y = r.y; y < r.y + r.h; y++) out.fill(0, y * w + r.x, y * w + r.x + r.w);
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const c = src[y * w + x], tx = x + dx, ty = y + dy;
    if (c && tx >= 0 && ty >= 0 && tx < w && ty < h) out[ty * w + tx] = over(out[ty * w + tx], c);
  }
  return out;
}

// Flood fill, kept inside clip (a selection) when given.
export function fill(cel, w, h, x, y, c, clip = null) {
  if (x < 0 || y < 0 || x >= w || y >= h || !inRect(clip, x, y)) return;
  const t = cel[y * w + x], stack = [y * w + x];
  if (t === c) return;
  while (stack.length) {
    const i = stack.pop();
    if (cel[i] !== t || !inRect(clip, i % w, (i / w) | 0)) continue;
    cel[i] = c;
    const px = i % w;
    if (px > 0) stack.push(i - 1);
    if (px < w - 1) stack.push(i + 1);
    if (i >= w) stack.push(i - w);
    if (i < w * (h - 1)) stack.push(i + w);
  }
}

// One brush stroke on one cel. Every dab blends against the pre-stroke pixels and
// a pixel only takes the strongest dab it has seen, so overlapping dabs inside a
// stroke never compound (matters for pressure -> opacity).
export class Stroke {
  constructor(cel, w, h, clip = null) {
    Object.assign(this, { cel, w, h, clip, before: cel.slice(), mask: new Uint8Array(w * h) });
  }
  // color's alpha is the dab strength; erase uses it to cut alpha instead.
  dab(x, y, size, color, erase) {
    const o = Math.floor(size / 2), a = color >>> 24;
    for (let j = y - o; j < y - o + size; j++) for (let i = x - o; i < x - o + size; i++) {
      if (i < 0 || j < 0 || i >= this.w || j >= this.h || !inRect(this.clip, i, j)) continue;
      const k = j * this.w + i, b = this.before[k];
      if (a <= this.mask[k]) continue;
      this.mask[k] = a;
      this.cel[k] = erase ? withAlpha(b, Math.round((b >>> 24) * (255 - a) / 255)) : over(b, color);
    }
  }
  reset() { this.cel.set(this.before); this.mask.fill(0); }
}

export function composite(d, f, out = new Uint32Array(d.w * d.h)) {
  out.fill(0);
  d.layers.forEach((l, li) => {
    if (!l.visible) return;
    const c = d.frames[f][li];
    for (let i = 0; i < out.length; i++) if (c[i]) out[i] = out[i] ? over(out[i], c[i]) : c[i];
  });
  return out;
}

// All frames side by side.
export function sheet(d) {
  const n = d.frames.length, px = new Uint32Array(d.w * n * d.h), tmp = new Uint32Array(d.w * d.h);
  for (let f = 0; f < n; f++) {
    composite(d, f, tmp);
    for (let y = 0; y < d.h; y++) px.set(tmp.subarray(y * d.w, (y + 1) * d.w), (y * n + f) * d.w);
  }
  return { w: d.w * n, h: d.h, px };
}

// Slice a W x H sheet into fw x fh frames, row by row. Empty trailing cells (a part-filled last row) are dropped.
export function fromSheet(px, W, H, fw, fh, palette) {
  const cols = Math.floor(W / fw), rows = Math.floor(H / fh);
  if (!cols || !rows) throw Error('frame size is bigger than the image');
  if (cols * rows > 1000) throw Error(`that makes ${cols * rows} frames; 1000 max`);
  const d = newDoc(fw, fh, palette);
  d.frames = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cel = new Uint32Array(fw * fh);
    for (let y = 0; y < fh; y++) { const o = (r * fh + y) * W + c * fw; cel.set(px.subarray(o, o + fw), y * fw); }
    d.frames.push([cel]);
  }
  while (d.frames.length > 1 && !d.frames.at(-1)[0].some(v => v)) d.frames.pop();
  return d;
}

// Entries are either a cel edit {f, l, before, after} or a whole-doc snapshot {before, after}.
// ponytail: structural edits snapshot the whole doc; store diffs if big animations eat memory.
export class History {
  undos = []; redos = [];
  push(e) { this.undos.push(e); if (this.undos.length > 100) this.undos.shift(); this.redos.length = 0; }
  undo(d) { return this.#step(d, this.undos, this.redos, 'before'); }
  redo(d) { return this.#step(d, this.redos, this.undos, 'after'); }
  #step(d, from, to, k) {
    const e = from.pop();
    if (!e) return false;
    if ('f' in e) d.frames[e.f][e.l].set(e[k]); else Object.assign(d, cloneDoc(e[k]));
    to.push(e);
    return true;
  }
}

const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
export const toJSON = d => JSON.stringify({ ...d, frames: d.frames.map(f => f.map(c => b64(new Uint8Array(c.buffer, c.byteOffset, c.byteLength)))) });

// Project files come from users: validate everything before it touches the editor.
export function fromJSON(s) {
  const d = JSON.parse(s), int = v => Number.isInteger(v) && v > 0 && v <= MAX;
  if (!int(d?.w) || !int(d.h) || !Array.isArray(d.layers) || !d.layers.length || !Array.isArray(d.frames) || !d.frames.length)
    throw Error('not a respite project');
  const layers = d.layers.map((l, i) => ({ name: String(l?.name ?? 'Layer ' + (i + 1)), visible: l?.visible !== false }));
  const frames = d.frames.map(f => {
    if (!Array.isArray(f) || f.length !== layers.length) throw Error('frame/layer count mismatch');
    return f.map(b => {
      const u = Uint8Array.from(atob(String(b)), ch => ch.charCodeAt(0));
      if (u.length !== d.w * d.h * 4) throw Error('cel size mismatch');
      return new Uint32Array(u.buffer);
    });
  });
  const palette = Array.isArray(d.palette) ? d.palette.filter(c => /^#[0-9a-f]{6}$/i.test(c)) : [...PALETTE];
  return { w: d.w, h: d.h, fps: clamp(Math.round(+d.fps) || 8, 1, 60), palette, layers, frames };
}
