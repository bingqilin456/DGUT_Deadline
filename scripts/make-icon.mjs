/**
 * 生成应用图标（PNG + ICO）。
 *
 * 纯 Node 实现，不依赖任何图像库：
 *  - 直接构造 PNG（zlib deflate + CRC32）绘制一个简约的"日历 + 对勾"图标
 *  - 再手工封装成 ICO（内嵌 PNG）
 *
 * 设计：圆角方形底（品牌蓝）+ 白色日历轮廓 + 对勾，符合"简约"要求。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ── CRC32 ─────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 将 RGBA 像素数组编码为 PNG。 */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前加 filter byte 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 圆角矩形内部判定。 */
function inRoundRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  const cx = Math.min(Math.max(x, r), w - 1 - r);
  const cy = Math.min(Math.max(y, r), h - 1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 画一条粗线（用于对勾）。 */
function onSegment(x, y, x1, y1, x2, y2, halfWidth) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(x - x1, y - y1) <= halfWidth;
  let t = ((x - x1) * dx + (y - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  return Math.hypot(x - px, y - py) <= halfWidth;
}

/** 生成某个尺寸的图标像素。 */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / 64; // 以 64x64 为设计基准

  const BRAND = [43, 108, 176]; // #2b6cb0
  const WHITE = [255, 255, 255];

  const radius = 12 * s;
  // 日历区域（白色圆角框内部）
  const calX1 = 15 * s, calY1 = 15 * s, calX2 = 49 * s, calY2 = 49 * s;
  const calR = 4.5 * s;
  // 日历顶部横条（品牌色实心，模拟日历"抬头"）
  const barY1 = 15 * s + 2.2 * s;
  const barY2 = 24 * s;
  // 顶部两个"装订环"
  const rings = [
    { x: 24 * s, y1: 11.5 * s, y2: 18 * s },
    { x: 40 * s, y1: 11.5 * s, y2: 18 * s },
  ];
  const ringHalf = 1.9 * s;
  // 对勾三点
  const ck = [
    [24.5 * s, 35 * s],
    [30.5 * s, 41 * s],
    [41 * s, 29.5 * s],
  ];
  const ckHalf = 2.5 * s;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // 底板：圆角方形
      if (!inRoundRect(x, y, size, size, radius)) {
        rgba[i + 3] = 0;
        continue;
      }

      let color = BRAND;

      // 日历外框（白）
      const inCalBox = x >= calX1 && x <= calX2 && y >= calY1 && y <= calY2;
      if (inCalBox) {
        const innerX = x - calX1;
        const innerY = y - calY1;
        const w = calX2 - calX1;
        const h = calY2 - calY1;
        const border = 2.8 * s;
        const insideInner = inRoundRect(
          innerX - border,
          innerY - border,
          w - border * 2,
          h - border * 2,
          Math.max(0, calR - border),
        );
        if (!insideInner) {
          // 边框：白色
          color = WHITE;
        } else if (y >= barY1 && y < barY2) {
          // 顶部抬头：品牌色（与外框形成"日历"分割）
          color = BRAND;
        } else {
          const isCheck =
            onSegment(x, y, ck[0][0], ck[0][1], ck[1][0], ck[1][1], ckHalf) ||
            onSegment(x, y, ck[1][0], ck[1][1], ck[2][0], ck[2][1], ckHalf);
          color = isCheck ? WHITE : BRAND;
        }
      } else {
        // 装订环（白色圆头线段）
        for (const r of rings) {
          if (onSegment(x, y, r.x, r.y1, r.x, r.y2, ringHalf)) {
            color = WHITE;
            break;
          }
        }
      }

      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/** 封装 ICO（内嵌多尺寸 PNG）。 */
function encodeIco(pngBuffersWithSize) {
  const count = pngBuffersWithSize.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  for (const { size, png } of pngBuffersWithSize) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // width
    e[1] = size >= 256 ? 0 : size; // height
    e[2] = 0; // palette
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...pngBuffersWithSize.map((p) => p.png)]);
}

// ── 生成 ───────────────────────────────────────────────────
const ROOT = process.cwd();
const buildDir = join(ROOT, 'build');
mkdirSync(buildDir, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((size) => ({ size, png: encodePng(size, size, drawIcon(size)) }));

// 主 PNG（256）
writeFileSync(join(buildDir, 'icon.png'), pngs[pngs.length - 1].png);

// ICO
writeFileSync(join(buildDir, 'icon.ico'), encodeIco(pngs));

// 托盘用 32x32 PNG（Windows 托盘最佳尺寸）
writeFileSync(join(ROOT, 'resources', 'tray.png'), (() => {
  mkdirSync(join(ROOT, 'resources'), { recursive: true });
  return pngs.find((p) => p.size === 32).png;
})());

console.log('生成完成:');
console.log('  build/icon.png     (256x256)');
console.log('  build/icon.ico     (16/24/32/48/64/128/256)');
console.log('  resources/tray.png (32x32)');
