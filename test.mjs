import assert from 'node:assert/strict';
import * as C from './www/core.js';

const red = C.rgba(255, 0, 0), blue = C.rgba(0, 0, 255);

// line hits both endpoints, no gaps on a diagonal
const pts = [];
C.line(0, 0, 3, 3, (x, y) => pts.push([x, y]));
assert.deepEqual(pts, [[0, 0], [1, 1], [2, 2], [3, 3]]);

// fill stays inside a wall
const w = 5, h = 5, cel = new Uint32Array(w * h);
C.line(2, 0, 2, 4, (x, y) => { cel[y * w + x] = blue; });
C.fill(cel, w, h, 0, 0, red);
assert.equal(cel.filter(c => c === red).length, 10);
assert.equal(cel[4], 0);

// over
assert.equal(C.over(red, blue), blue);
assert.equal(C.over(red, 0), red);
const half = C.over(red, C.withAlpha(blue, 128));
assert.equal(half >>> 24, 255);
assert.ok(Math.abs((half & 255) - 127) <= 1 && Math.abs((half >> 16 & 255) - 128) <= 1);

// pressure dabs don't compound inside a stroke; stronger dab wins
const s = new C.Stroke(new Uint32Array(4), 2, 2);
s.dab(0, 0, 1, C.withAlpha(red, 100), false);
s.dab(0, 0, 1, C.withAlpha(red, 100), false);
assert.equal(s.cel[0] >>> 24, 100);
s.dab(0, 0, 1, C.withAlpha(red, 200), false);
assert.equal(s.cel[0] >>> 24, 200);
s.dab(1, 1, 2, red, false); // size 2 dab covers (0,0)-(1,1), clipped at the edge
assert.equal(s.cel[3], red);
s.reset();
assert.deepEqual([...s.cel], [0, 0, 0, 0]);

// eraser at half strength halves alpha
const e = new C.Stroke(Uint32Array.of(red), 1, 1);
e.dab(0, 0, 1, C.withAlpha(0, 128), true);
assert.equal(e.cel[0] >>> 24, 127);

// layers, composite, hidden layers
const d = C.newDoc(2, 1);
C.addLayer(d, 1);
d.frames[0][0][0] = red;
d.frames[0][1][0] = blue;
assert.equal(C.composite(d, 0)[0], blue);
d.layers[1].visible = false;
assert.equal(C.composite(d, 0)[0], red);
d.layers[1].visible = true;
C.moveLayer(d, 1, 0);
assert.equal(C.composite(d, 0)[0], red);
assert.equal(C.removeLayer(C.newDoc(1, 1), 0), false);

// frames + spritesheet layout
C.addFrame(d, 1, 0);
C.addFrame(d, 2);
assert.equal(d.frames.length, 3);
d.frames[1][1][1] = blue;
const sh = C.sheet(d);
assert.equal(sh.w, 6);
assert.deepEqual([...sh.px], [red, 0, red, blue, 0, 0]);

// frame reorder
C.moveFrame(d, 2, 0);
assert.deepEqual([...C.sheet(d).px], [0, 0, red, 0, red, blue]);
C.moveFrame(d, 0, 2);
assert.equal(C.moveFrame(d, 0, -1), false);

// history: cel edit and structural edit
const hist = new C.History();
const before = d.frames[0][1].slice();
d.frames[0][1][1] = red;
hist.push({ f: 0, l: 1, before, after: d.frames[0][1].slice() });
const snap = C.cloneDoc(d);
C.removeFrame(d, 2);
hist.push({ before: snap, after: C.cloneDoc(d) });
assert.ok(hist.undo(d)); assert.equal(d.frames.length, 3);
assert.ok(hist.undo(d)); assert.equal(d.frames[0][1][1], 0);
assert.ok(!hist.undo(d));
assert.ok(hist.redo(d)); assert.equal(d.frames[0][1][1], red);
assert.ok(hist.redo(d)); assert.equal(d.frames.length, 2);

// save/load round trip, and bad files are rejected
const back = C.fromJSON(C.toJSON(d));
assert.deepEqual(back.frames.map(f => f.map(c => [...c])), d.frames.map(f => f.map(c => [...c])));
assert.deepEqual(back.layers, d.layers);
assert.throws(() => C.fromJSON('{"w":2,"h":1,"layers":[{}],"frames":[["AAAA"]]}'), /cel size/);
assert.throws(() => C.fromJSON('{"w":99999,"h":1,"layers":[{}],"frames":[[]]}'), /not a respite/);
assert.equal(C.u32ToHex(C.hexToU32('#12abef')), '#12abef');

// hsv round trips
for (const c of [[255, 0, 0], [12, 200, 77], [0, 0, 0], [255, 255, 255], [90, 30, 160]]) {
  const { h, s, v } = C.rgbToHsv(...c);
  assert.deepEqual(C.hsvToRgb(h, s, v), c);
}
assert.deepEqual(C.rgbToHsv(0, 0, 255), { h: 240, s: 1, v: 1 });

// selection rects
assert.deepEqual(C.rectFrom(3, 4, 1, 1, 10, 10), { x: 1, y: 1, w: 3, h: 4 });
assert.deepEqual(C.rectFrom(-5, 8, 2, 20, 10, 10), { x: 0, y: 8, w: 3, h: 2 });
assert.equal(C.clipRect({ x: 20, y: 0, w: 2, h: 2 }, 10, 10), null);

// move: lift a 1x2 block one right; destination keeps what's not covered, the hole is cleared
const mv = Uint32Array.of(red, 0, blue, red, 0, 0); // 3x2
assert.deepEqual([...C.shift(mv, 3, 2, { x: 0, y: 0, w: 1, h: 2 }, 1, 0)], [0, red, blue, 0, red, 0]);
// pixels pushed off canvas are dropped
assert.deepEqual([...C.shift(mv, 3, 2, { x: 0, y: 0, w: 3, h: 2 }, 0, 1)], [0, 0, 0, red, 0, blue]);

// paint and fill stay inside the selection
const clipped = new C.Stroke(new Uint32Array(9), 3, 3, { x: 1, y: 1, w: 1, h: 1 });
clipped.dab(1, 1, 3, red, false);
assert.equal(clipped.cel.filter(v => v).length, 1);
const fc = new Uint32Array(9);
C.fill(fc, 3, 3, 0, 0, red, { x: 0, y: 0, w: 2, h: 3 });
assert.equal(fc.filter(v => v).length, 6);
C.fill(fc, 3, 3, 2, 0, blue, { x: 0, y: 0, w: 2, h: 3 }); // seed outside selection: no-op
assert.equal(fc.filter(v => v === blue).length, 0);

// spritesheet: 2x1 frames from a 4x2 sheet, last row's second cell empty -> trimmed
const sheetPx = Uint32Array.of(red, red, blue, blue, red, 0, 0, 0);
const sd = C.fromSheet(sheetPx, 4, 2, 2, 1);
assert.equal(sd.frames.length, 3);
assert.deepEqual([...sd.frames[1][0]], [blue, blue]);
assert.deepEqual([...sd.frames[2][0]], [red, 0]);
assert.throws(() => C.fromSheet(sheetPx, 4, 2, 8, 8), /bigger/);

console.log('ok');
