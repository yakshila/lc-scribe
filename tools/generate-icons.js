// 图标生成器(纯 Node,无依赖):生成 16/32/48/128 的 PNG 图标。
// 设计:LeetCode 橙(#FFA116)圆角底 + 白色对勾,简洁可辨。
// 运行: node tools/generate-icons.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// 16x16 对勾 mask(1=白对勾,2=橙底,0=深色边)。其余位置填橙底。
// 对勾路径大致:从 (3,9) 到 (6,12) 到 (12,4) 的折线,2px 粗。
const CHECK = [
  "                ",
  "                ",
  "                ",
  "                ",
  "            11  ",
  "           1111 ",
  "          11    ",
  "         11     ",
  "  11    11      ",
  "   11  11       ",
  "    1111        ",
  "     11         ",
  "                ",
  "                ",
  "                ",
  "                ",
];

function drawIcon(size) {
  // 离屏像素画布:在 16x16 设计稿上作画,再最近邻缩放到目标 size
  const W = 16, H = 16;
  const bg = [0xff, 0xa1, 0x16]; // 橙
  const fg = [0xff, 0xff, 0xff]; // 白对勾
  const canvas = new Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // 圆角:四角透明
      const cornerR = 3;
      const inCorner =
        (x < cornerR && y < cornerR && (cornerR - x) * (cornerR - x) + (cornerR - y) * (cornerR - y) > cornerR * cornerR) ||
        (x >= W - cornerR && y < cornerR && ((x - (W - cornerR - 1)) * (x - (W - cornerR - 1)) + (cornerR - y) * (cornerR - y)) > cornerR * cornerR) ||
        (x < cornerR && y >= H - cornerR && (cornerR - x) * (cornerR - x) + (y - (H - cornerR - 1)) * (y - (H - cornerR - 1)) > cornerR * cornerR) ||
        (x >= W - cornerR && y >= H - cornerR && ((x - (W - cornerR - 1)) * (x - (W - cornerR - 1)) + (y - (H - cornerR - 1)) * (y - (H - cornerR - 1)) > cornerR * cornerR));
      const c = CHECK[y] && CHECK[y][x];
      if (inCorner) {
        canvas[y * W + x] = null; // 透明
      } else if (c === "1") {
        canvas[y * W + x] = fg;
      } else {
        canvas[y * W + x] = bg;
      }
    }
  }
  // 缩放到目标 size(最近邻)
  const out = Buffer.alloc(size * size * 4); // RGBA
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x / size) * W);
      const sy = Math.floor((y / size) * H);
      const px = canvas[sy * W + sx];
      const i = (y * size + x) * 4;
      if (px) {
        out[i] = px[0]; out[i + 1] = px[1]; out[i + 2] = px[2]; out[i + 3] = 0xff;
      } else {
        out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
      }
    }
  }
  return encodePNG(size, size, out, true /* hasAlpha */);
}

// —— 极简 PNG 编码(RGBA) ——
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(w, h, rgba, hasAlpha) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = hasAlpha ? 6 : 2; // color type: 6=RGBA, 2=RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // scanlines: each prefixed with filter byte 0
  const stride = hasAlpha ? 4 : 3;
  const raw = Buffer.alloc((w * stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * stride + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * stride + 1) + 1, y * w * stride, y * w * stride + w * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// —— 写文件 ——
const outDir = path.resolve(__dirname, "../icons");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = drawIcon(size);
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log("wrote", file, png.length, "bytes");
}
