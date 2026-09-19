// Normalización de visión: antes de enviar imágenes al LLM se garantiza que
// (a) ninguna supere VISION_MAX_SIDE de lado y (b) el TOTAL de pixeles de la
// petición no supere maxTotalPixels. Sin esto, gateways tipo vLLM rechazan con
// "LLM HTTP 413: vision raw patches exceed processor budget" (el presupuesto
// del processor es por petición, no por imagen: 4 imágenes de ~1.6 MP pueden
// fallar aunque cada una por separado quepa).
// Se re-codifica (PNG con alpha -> PNG; resto -> JPEG q85). Imágenes pequeñas
// viajan intactas; si la decodificación fallara, la imagen pasa sin tocar.
import { Jimp } from "jimp";

export const VISION_MAX_SIDE = 1568;
export const VISION_MAX_TOTAL_PIXELS = 4_000_000;

async function decode(entry) {
  let img = null;
  try {
    img = await Jimp.fromBuffer(Buffer.from(entry.b64, "base64"));
  } catch {
    /* indescodificable: se envía tal cual */
  }
  return img;
}

function encode(img, origMime) {
  const mime = origMime === "image/png" ? "image/png" : "image/jpeg";
  return Promise.resolve(
    mime === "image/png" ? img.getBuffer("image/png") : img.getBuffer("image/jpeg", { quality: 85 })
  ).then((buf) => ({ mime, b64: buf.toString("base64") }));
}

export async function normalizeVisionBatch(entries, { maxSide = VISION_MAX_SIDE, maxTotalPixels = VISION_MAX_TOTAL_PIXELS } = {}) {
  const items = [];
  for (const entry of entries || []) {
    items.push({ entry, origW: 0, origH: 0, img: await decode(entry) });
  }
  // (a) cada imagen a <= maxSide
  for (const it of items) {
    if (!it.img) continue;
    const w = it.img.bitmap.width;
    const h = it.img.bitmap.height;
    it.origW = w;
    it.origH = h;
    const k = Math.min(1, maxSide / Math.max(w, h));
    if (k < 1) it.img.resize({ w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) });
  }
  // (b) tope total: escala todo al cuadrado de (presupuesto/actual)
  const px = (it) => (it.img ? it.img.bitmap.width * it.img.bitmap.height : 0);
  const total = items.reduce((s, it) => s + px(it), 0);
  if (total > maxTotalPixels && total > 0) {
    const k = Math.sqrt(maxTotalPixels / total);
    for (const it of items) {
      if (!it.img) continue;
      // floor: garantiza que el total no rebase el presupuesto por redondeo
      it.img.resize({ w: Math.max(1, Math.floor(it.img.bitmap.width * k)), h: Math.max(1, Math.floor(it.img.bitmap.height * k)) });
    }
  }
  const out = [];
  for (const it of items) {
    const e = it.entry;
    if (!it.img) {
      out.push({ path: e.path, mime: e.mime, bytes: e.bytes, b64: e.b64, resized: false, w: 0, h: 0 });
      continue;
    }
    const w = it.img.bitmap.width;
    const h = it.img.bitmap.height;
    const resized = w !== it.origW || h !== it.origH;
    if (!resized) {
      out.push({ path: e.path, mime: e.mime, bytes: e.bytes, b64: e.b64, resized: false, w, h });
      continue;
    }
    const enc = await encode(it.img, e.mime);
    out.push({ path: e.path, mime: enc.mime, bytes: Buffer.byteLength(enc.b64, "base64"), b64: enc.b64, resized: true, w, h });
  }
  return out;
}

export async function normalizeVisionImage(entry, opts) {
  const [one] = await normalizeVisionBatch([entry], opts);
  return one;
}