// Generates public/icon-192.png and public/icon-512.png:
// solid #0A0E15 background with a centered #5DCAA5 lightning-bolt glyph.
// Pure Node (zlib + hand-rolled PNG encoder), no native/canvas deps needed.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const BG = [0x0a, 0x0e, 0x15];
const FG = [0x5d, 0xca, 0xa5];

// Material "bolt" glyph path M7 2v11h3v9l7-12h-4l4-8z, in a 24x24 box.
const BOLT_POINTS = [
  [7, 2],
  [7, 13],
  [10, 13],
  [10, 22],
  [17, 10],
  [13, 10],
  [17, 2],
];

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (none)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  // Bolt is drawn in a centered square that's ~52% of the icon, matching
  // the 24x24 source box padded to look minimalist rather than edge-to-edge.
  const glyphBox = size * 0.52;
  const offset = (size - glyphBox) * 0.5;
  const scale = glyphBox / 24;
  const poly = BOLT_POINTS.map(([px, py]) => [
    offset + px * scale,
    offset + py * scale,
  ]);

  const SS = 4; // supersample factor for anti-aliased edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (pointInPolygon(px, py, poly)) hits++;
        }
      }
      const t = hits / (SS * SS);
      const idx = (y * size + x) * 4;
      rgba[idx] = Math.round(BG[0] + (FG[0] - BG[0]) * t);
      rgba[idx + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * t);
      rgba[idx + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * t);
      rgba[idx + 3] = 255;
    }
  }
  return encodePNG(size, size, rgba);
}

const outDir = path.join(__dirname, "..", "public");
for (const size of [192, 512]) {
  const png = renderIcon(size);
  const outPath = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes)`);
}
