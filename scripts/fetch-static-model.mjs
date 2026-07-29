#!/usr/bin/env node
// Fetch + convert a sentence-transformers StaticEmbedding model into compact
// GTSE artifacts for the `static` embedding backend (staticEmbedding.js).
//
// Why a converter instead of loading safetensors at runtime: the raw matrix is
// fp32 30522×1024 (125 MB). Per-row absmax int8 quantization cuts that 4× and
// MRL truncation (the model is Matryoshka-trained; prefix-slice is the
// documented truncation) cuts dim 1024→256 for another 4× — 7.8 MB loads in
// well under a second on the 1-core box, which is the whole cold-start win.
//
// Usage:
//   node scripts/fetch-static-model.mjs                # default variants
//   node scripts/fetch-static-model.mjs --variants int8-d1024,int8-d256
//   node scripts/fetch-static-model.mjs --src /path/with/model.safetensors
//
// Writes models/static/<base>-<variant>.gtse + models/static/tokenizer.json.
// models/ is gitignored — run this once per deployment (or CI cache).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildGtse } from '../src/search/providers/staticEmbedding.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HF_MODEL = 'sentence-transformers/static-retrieval-mrl-en-v1';
const BASE_NAME = 'static-retrieval-mrl-en-v1';
const OUT_DIR = path.join(REPO, 'models', 'static');
const HF_BASE = `https://huggingface.co/${HF_MODEL}/resolve/main`;

function parseArgs(argv) {
  const args = { variants: ['int8-d1024', 'int8-d256', 'f32-d1024', 'f32-d256'], src: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--variants') args.variants = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--src') args.src = argv[++i];
    else throw new Error(`unknown arg ${argv[i]}`);
  }
  return args;
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`  cached: ${dest}`);
    return;
  }
  console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Verify length when the server declares it, and write atomically
  // (tmp + rename) — a partially-written file must never be mistaken for a
  // valid cache by the size>0 check above.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0 && buf.length !== declared) {
    throw new Error(`download truncated: got ${buf.length} of ${declared} bytes for ${url}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  console.log(`  saved ${dest} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

/** Minimal safetensors reader for the single-tensor StaticEmbedding file. */
function readSafetensors(file) {
  const buf = fs.readFileSync(file);
  const headerLen = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString('utf8'));
  const info = header['embedding.weight'];
  if (!info) throw new Error(`embedding.weight not found; tensors: ${Object.keys(header).join(', ')}`);
  if (info.dtype !== 'F32') throw new Error(`expected F32 tensor, got ${info.dtype}`);
  const [vocabSize, dim] = info.shape;
  const [start, end] = info.data_offsets;
  const bytes = buf.subarray(8 + headerLen + start, 8 + headerLen + end);
  // Copy into an aligned Float32Array (Buffer pool offsets aren't 4-aligned).
  const mat = new Float32Array(vocabSize * dim);
  for (let i = 0; i < mat.length; i++) mat[i] = bytes.readFloatLE(i * 4);
  return { mat, vocabSize, dim };
}

function writeGtse(file, { mat, vocabSize, srcDim }, dim, dtype) {
  const buf = buildGtse(mat, {
    model: `${BASE_NAME}-${dtype}-d${dim}`,
    sourceModel: HF_MODEL,
    vocabSize,
    srcDim,
    dim,
    dtype,
  });
  fs.writeFileSync(file, buf);
  console.log(`  wrote ${file} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
}

async function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const srcDirDefault = path.join(OUT_DIR, 'raw');
  const stFile = args.src
    ? path.join(args.src, 'model.safetensors')
    : path.join(srcDirDefault, 'model.safetensors');
  const tokSrc = args.src
    ? path.join(args.src, 'tokenizer.json')
    : path.join(srcDirDefault, 'tokenizer.json');

  console.log(`model: ${HF_MODEL}`);
  if (!args.src) {
    await download(`${HF_BASE}/0_StaticEmbedding/model.safetensors`, stFile);
    await download(`${HF_BASE}/0_StaticEmbedding/tokenizer.json`, tokSrc);
  }

  fs.copyFileSync(tokSrc, path.join(OUT_DIR, 'tokenizer.json'));
  console.log(`  tokenizer → ${path.join(OUT_DIR, 'tokenizer.json')}`);

  const { mat, vocabSize, dim: srcDim } = readSafetensors(stFile);
  console.log(`  matrix: ${vocabSize}×${srcDim} f32`);

  for (const variant of args.variants) {
    const m = variant.match(/^(int8|f32)-d(\d+)$/);
    if (!m) throw new Error(`bad variant "${variant}" — expected e.g. int8-d256`);
    const dtype = m[1];
    const dim = Number(m[2]);
    if (dim < 1 || dim > srcDim) throw new Error(`dim ${dim} out of range 1..${srcDim}`);
    writeGtse(path.join(OUT_DIR, `${BASE_NAME}-${dtype}-d${dim}.gtse`), { mat, vocabSize, srcDim }, dim, dtype);
  }
  console.log('done');
}

main().catch((e) => { console.error(e); process.exit(1); });
