// PNG Squeeze — compress a screenshot into the smallest lossless PNG.
// Runs under Node 22 as `node /bot/main.ts`. No network, no clock, no
// randomness: the same input always yields byte-identical output.
import { inflateSync, deflateSync } from "node:zlib";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------- CRC32
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function makeIhdr(
  width: number,
  height: number,
  colourType: number,
): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8; // bit depth
  data[9] = colourType;
  data[10] = 0; // compression
  data[11] = 0; // filter
  data[12] = 0; // interlace
  return makeChunk("IHDR", data);
}

// ------------------------------------------------------------- Paeth
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ------------------------------------------------------- PNG decoding
interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array; // width * height * 4, fully unfiltered
}

function decodePng(buf: Buffer): Decoded {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) throw new Error("bad PNG signature");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  const idatParts: Buffer[] = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error("expected bit depth 8 input");
      colourType = data[9];
    } else if (type === "IDAT") {
      idatParts.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (colourType !== 6) throw new Error("expected colour type 6 input");
  const raw = inflateSync(Buffer.concat(idatParts));
  const stride = width * 4;
  const out = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[rowStart + x];
      const left = x >= 4 ? out[outStart + x - 4] : 0;
      const up = prev[x];
      const upLeft = x >= 4 ? prev[x - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      out[outStart + x] = (value + predictor) & 0xff;
    }
    prev = out.subarray(outStart, outStart + stride);
  }
  return { width, height, rgba: out };
}

// Filter one scanline of raw channel bytes into the caller-provided
// output buffer (same length as the row), so the per-row screening loops
// reuse one scratch buffer instead of allocating a fresh array per trial.
function filterRowInto(
  row: Uint8Array,
  prev: Uint8Array,
  filter: number,
  bpp: number,
  out: Uint8Array,
): void {
  for (let x = 0; x < row.length; x++) {
    const left = x >= bpp ? row[x - bpp] : 0;
    const up = prev[x];
    const upLeft = x >= bpp ? prev[x - bpp] : 0;
    let predictor = 0;
    if (filter === 1) predictor = left;
    else if (filter === 2) predictor = up;
    else if (filter === 3) predictor = (left + up) >> 1;
    else if (filter === 4) predictor = paeth(left, up, upLeft);
    out[x] = (row[x] - predictor) & 0xff;
  }
}

// ------------------------------------------------------------ Analysis
interface Analysis {
  opaque: boolean;
  grey: boolean;
  counts: Map<number, number> | null; // colour word -> occurrences, null past 256
  transparentKey: number | null; // grey value, or 24-bit RGB, when usable
}

function analyse(rgba: Uint8Array): Analysis {
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let tooMany = false;
  const opaqueRgb = new Set<number>();
  let firstTransparentRgb = -1;
  let sameTransparentRgb = true;
  let firstTransparentGrey = -1;
  let sameTransparentGrey = true;
  let anySemiTransparent = false;

  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const a = rgba[i + 3];
    if (a !== 255) opaque = false;
    if (r !== g || g !== b) grey = false;
    if (!tooMany) {
      const word = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      counts.set(word, (counts.get(word) ?? 0) + 1);
      if (counts.size > 256) {
        tooMany = true;
        counts.clear();
      }
    }
    const rgb = (r << 16) | (g << 8) | b;
    if (a === 255) {
      opaqueRgb.add(rgb);
    } else if (a === 0) {
      if (firstTransparentRgb < 0) {
        firstTransparentRgb = rgb;
        firstTransparentGrey = r;
      } else {
        if (rgb !== firstTransparentRgb) sameTransparentRgb = false;
        if (r !== firstTransparentGrey) sameTransparentGrey = false;
      }
    } else {
      anySemiTransparent = true;
    }
  }

  let transparentKey: number | null = null;
  if (!anySemiTransparent && firstTransparentRgb >= 0) {
    if (grey) {
      const key = (firstTransparentGrey << 16) | (firstTransparentGrey << 8) | firstTransparentGrey;
      if (sameTransparentGrey && !opaqueRgb.has(key)) {
        transparentKey = firstTransparentGrey;
      }
    } else if (sameTransparentRgb && !opaqueRgb.has(firstTransparentRgb)) {
      transparentKey = firstTransparentRgb;
    }
  }
  return { opaque, grey, counts: tooMany ? null : counts, transparentKey };
}

// -------------------------------------------------------- Candidate forms
interface Form {
  colourType: number;
  bpp: number; // bytes per pixel of channel data
  palette?: Uint8Array; // PLTE payload (3 bytes per entry)
  trns?: Uint8Array; // tRNS payload
  data: Uint8Array; // height * width * bpp, no filter bytes
}

function luminance(r: number, g: number, b: number): number {
  return 299 * r + 587 * g + 114 * b;
}

function buildPaletteForm(
  rgba: Uint8Array,
  width: number,
  height: number,
  counts: Map<number, number>,
  byLuminance: boolean,
): Form {
  const entries = [...counts.entries()].map(([word, count]) => ({
    r: (word >>> 24) & 0xff,
    g: (word >>> 16) & 0xff,
    b: (word >>> 8) & 0xff,
    a: word & 0xff,
    count,
  }));
  const transparent = entries.filter((e) => e.a < 255);
  const solid = entries.filter((e) => e.a === 255);
  transparent.sort((x, y) => x.a - y.a);
  if (byLuminance) {
    solid.sort(
      (x, y) => luminance(x.r, x.g, x.b) - luminance(y.r, y.g, y.b),
    );
  } else {
    solid.sort((x, y) => y.count - x.count);
  }
  const ordered = [...transparent, ...solid];
  const indexOf = new Map<number, number>();
  const palette = new Uint8Array(ordered.length * 3);
  const alphas: number[] = [];
  ordered.forEach((e, i) => {
    indexOf.set(((e.r << 24) | (e.g << 16) | (e.b << 8) | e.a) >>> 0, i);
    palette[i * 3] = e.r;
    palette[i * 3 + 1] = e.g;
    palette[i * 3 + 2] = e.b;
    alphas.push(e.a);
  });
  let lastOpaque = -1;
  for (let i = alphas.length - 1; i >= 0; i--) {
    if (alphas[i] < 255) {
      lastOpaque = i;
      break;
    }
  }
  const trns =
    lastOpaque >= 0 ? new Uint8Array(alphas.slice(0, lastOpaque + 1)) : undefined;
  const data = new Uint8Array(width * height);
  for (let p = 0, n = width * height; p < n; p++) {
    const word =
      ((rgba[p * 4] << 24) |
        (rgba[p * 4 + 1] << 16) |
        (rgba[p * 4 + 2] << 8) |
        rgba[p * 4 + 3]) >>>
      0;
    data[p] = indexOf.get(word) ?? 0;
  }
  return { colourType: 3, bpp: 1, palette, trns, data };
}

function buildChannelForm(
  rgba: Uint8Array,
  width: number,
  height: number,
  grey: boolean,
  opaque: boolean,
  transparentKey: number | null,
): Form {
  const pixels = width * height;
  if (grey) {
    if (opaque || transparentKey !== null) {
      const data = new Uint8Array(pixels);
      for (let p = 0; p < pixels; p++) data[p] = rgba[p * 4];
      const trns =
        transparentKey !== null
          ? new Uint8Array([0, transparentKey])
          : undefined;
      return { colourType: 0, bpp: 1, trns, data };
    }
    const data = new Uint8Array(pixels * 2);
    for (let p = 0; p < pixels; p++) {
      data[p * 2] = rgba[p * 4];
      data[p * 2 + 1] = rgba[p * 4 + 3];
    }
    return { colourType: 4, bpp: 2, data };
  }
  if (opaque || transparentKey !== null) {
    const data = new Uint8Array(pixels * 3);
    for (let p = 0; p < pixels; p++) {
      data[p * 3] = rgba[p * 4];
      data[p * 3 + 1] = rgba[p * 4 + 1];
      data[p * 3 + 2] = rgba[p * 4 + 2];
    }
    const trns =
      transparentKey !== null
        ? new Uint8Array([
            0,
            (transparentKey >> 16) & 0xff,
            0,
            (transparentKey >> 8) & 0xff,
            0,
            transparentKey & 0xff,
          ])
        : undefined;
    return { colourType: 2, bpp: 3, trns, data };
  }
  return { colourType: 6, bpp: 4, data: new Uint8Array(rgba) };
}

function candidateForms(
  rgba: Uint8Array,
  width: number,
  height: number,
  info: Analysis,
): Form[] {
  const forms: Form[] = [];
  if (info.counts !== null) {
    forms.push(
      buildPaletteForm(rgba, width, height, info.counts, false),
      buildPaletteForm(rgba, width, height, info.counts, true),
    );
    if (info.grey) {
      forms.push(
        buildChannelForm(rgba, width, height, true, info.opaque, info.transparentKey),
      );
    }
  } else {
    forms.push(
      buildChannelForm(rgba, width, height, info.grey, info.opaque, info.transparentKey),
    );
  }
  return forms;
}

// ------------------------------------------------- Filter strategies
// Strategies 0-4: one fixed filter for every row.
// Strategy 5 (minsum): per row, the filter whose filtered bytes have the
// smallest sum of absolute signed values (ties: lowest filter number).
// Strategy 6 (pairs): per row, the filter with the fewest distinct
// adjacent-byte pairs in the filtered row.
// Strategy 7 (brute): per row, the filter whose single-row zlib level 4
// compression (using the previous 32 KiB of filtered output as the
// dictionary) is smallest.
const PAIR_SEEN = new Uint32Array(65536);
let pairStamp = 0;

function signedAbsSum(row: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    sum += v < 128 ? v : 256 - v;
  }
  return sum;
}

function distinctPairCount(row: Uint8Array): number {
  const stamp = ++pairStamp;
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (PAIR_SEEN[pair] !== stamp) {
      PAIR_SEEN[pair] = stamp;
      n++;
    }
  }
  return n;
}

function buildFiltered(
  form: Form,
  width: number,
  height: number,
  strategy: number,
): Uint8Array {
  const stride = width * form.bpp;
  const out = new Uint8Array(height * (stride + 1));
  const prev = new Uint8Array(stride);
  const scratch = new Uint8Array(stride);
  if (strategy <= 4) {
    for (let y = 0; y < height; y++) {
      const row = form.data.subarray(y * stride, (y + 1) * stride);
      const at = y * (stride + 1);
      out[at] = strategy;
      filterRowInto(row, prev, strategy, form.bpp, scratch);
      out.set(scratch, at + 1);
      prev.set(row);
    }
    return out;
  }
  if (strategy === 7) {
    const trials: Uint8Array[] = [];
    for (let t = 0; t < 5; t++) {
      const trial = new Uint8Array(stride + 1);
      trial[0] = t;
      trials.push(trial);
    }
    for (let y = 0; y < height; y++) {
      const row = form.data.subarray(y * stride, (y + 1) * stride);
      const at = y * (stride + 1);
      const history = out.subarray(Math.max(0, at - 32768), at);
      let bestFilter = 0;
      let bestSize = Infinity;
      for (let t = 0; t < 5; t++) {
        filterRowInto(row, prev, t, form.bpp, trials[t].subarray(1));
        const z =
          history.length === 0
            ? deflateSync(trials[t], { level: 4, memLevel: 9 })
            : deflateSync(trials[t], {
                level: 4,
                memLevel: 9,
                dictionary: history,
              });
        if (z.length < bestSize) {
          bestSize = z.length;
          bestFilter = t;
        }
      }
      out.set(trials[bestFilter], at);
      prev.set(row);
    }
    return out;
  }
  // minsum (5) or pairs (6): per-row choice by the cheap heuristic.
  const trials: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) trials.push(new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const row = form.data.subarray(y * stride, (y + 1) * stride);
    const at = y * (stride + 1);
    let bestFilter = 0;
    let bestCost = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRowInto(row, prev, t, form.bpp, trials[t]);
      const cost =
        strategy === 5 ? signedAbsSum(trials[t]) : distinctPairCount(trials[t]);
      if (cost < bestCost) {
        bestCost = cost;
        bestFilter = t;
      }
    }
    out[at] = bestFilter;
    out.set(trials[bestFilter], at + 1);
    prev.set(row);
  }
  return out;
}

// -------------------------------------------------- Screening + encode
function chunkOverhead(form: Form): number {
  let overhead = 0;
  if (form.palette) overhead += 12 + form.palette.length;
  if (form.trns) overhead += 12 + form.trns.length;
  return overhead;
}

function encodePng(
  width: number,
  height: number,
  form: Form,
  filtered: Uint8Array,
): Uint8Array {
  const idat = deflateSync(filtered, { level: 9, memLevel: 9 });
  const parts: Uint8Array[] = [PNG_SIGNATURE, makeIhdr(width, height, form.colourType)];
  if (form.palette) parts.push(makeChunk("PLTE", form.palette));
  if (form.trns) parts.push(makeChunk("tRNS", form.trns));
  parts.push(makeChunk("IDAT", idat));
  parts.push(makeChunk("IEND", new Uint8Array(0)));
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function compressOne(decoded: Decoded): Uint8Array {
  const { width, height, rgba } = decoded;
  const info = analyse(rgba);
  const forms = candidateForms(rgba, width, height, info);
  let bestForm: Form | null = null;
  let bestFiltered: Uint8Array | null = null;
  let bestTotal = Infinity;
  for (const form of forms) {
    for (let strategy = 0; strategy < 8; strategy++) {
      const filtered = buildFiltered(form, width, height, strategy);
      const size =
        deflateSync(filtered, { level: 6, memLevel: 8 }).length +
        chunkOverhead(form);
      if (size < bestTotal) {
        bestTotal = size;
        bestForm = form;
        bestFiltered = filtered;
      }
    }
  }
  if (!bestForm || !bestFiltered) throw new Error("no candidate form");
  return encodePng(width, height, bestForm, bestFiltered);
}

// ---------------------------------------------------------------- Main
function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  const ids = readdirSync(inputDir).sort();
  for (const id of ids) {
    const inPath = join(inputDir, id, "image.png");
    if (!existsSync(inPath)) continue;
    const decoded = decodePng(readFileSync(inPath));
    const png = compressOne(decoded);
    const outDir = join(outputDir, id);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, "image.png");
    writeFileSync(outPath, png);
    chmodSync(outPath, 0o644);
    chmodSync(outDir, 0o755);
  }
}

main();
