import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { formatNumber } from './utils.js';

const FONT = {
  'A':['01110','10001','10001','11111','10001','10001','10001'],
  'B':['11110','10001','10001','11110','10001','10001','11110'],
  'C':['01111','10000','10000','10000','10000','10000','01111'],
  'D':['11110','10001','10001','10001','10001','10001','11110'],
  'E':['11111','10000','10000','11110','10000','10000','11111'],
  'F':['11111','10000','10000','11110','10000','10000','10000'],
  'G':['01111','10000','10000','10111','10001','10001','01110'],
  'H':['10001','10001','10001','11111','10001','10001','10001'],
  'I':['11111','00100','00100','00100','00100','00100','11111'],
  'J':['00111','00010','00010','00010','10010','10010','01100'],
  'K':['10001','10010','10100','11000','10100','10010','10001'],
  'L':['10000','10000','10000','10000','10000','10000','11111'],
  'M':['10001','11011','10101','10101','10001','10001','10001'],
  'N':['10001','11001','10101','10011','10001','10001','10001'],
  'O':['01110','10001','10001','10001','10001','10001','01110'],
  'P':['11110','10001','10001','11110','10000','10000','10000'],
  'Q':['01110','10001','10001','10001','10101','10010','01101'],
  'R':['11110','10001','10001','11110','10100','10010','10001'],
  'S':['01111','10000','10000','01110','00001','00001','11110'],
  'T':['11111','00100','00100','00100','00100','00100','00100'],
  'U':['10001','10001','10001','10001','10001','10001','01110'],
  'V':['10001','10001','10001','10001','10001','01010','00100'],
  'W':['10001','10001','10001','10101','10101','10101','01010'],
  'X':['10001','10001','01010','00100','01010','10001','10001'],
  'Y':['10001','10001','01010','00100','00100','00100','00100'],
  'Z':['11111','00001','00010','00100','01000','10000','11111'],
  '0':['01110','10001','10011','10101','11001','10001','01110'],
  '1':['00100','01100','00100','00100','00100','00100','01110'],
  '2':['01110','10001','00001','00010','00100','01000','11111'],
  '3':['11110','00001','00001','01110','00001','00001','11110'],
  '4':['00010','00110','01010','10010','11111','00010','00010'],
  '5':['11111','10000','10000','11110','00001','00001','11110'],
  '6':['01110','10000','10000','11110','10001','10001','01110'],
  '7':['11111','00001','00010','00100','01000','01000','01000'],
  '8':['01110','10001','10001','01110','10001','10001','01110'],
  '9':['01110','10001','10001','01111','00001','00001','01110'],
  ' ':['00000','00000','00000','00000','00000','00000','00000'],
  '#':['01010','11111','01010','01010','11111','01010','01010'],
  '-':['00000','00000','00000','11111','00000','00000','00000'],
  '.':['00000','00000','00000','00000','00000','00100','00100'],
  ':':['00000','00100','00100','00000','00100','00100','00000'],
  '/':['00001','00010','00100','01000','10000','00000','00000'],
  '?':['01110','10001','00001','00010','00100','00000','00100']
};

export function generateTicketPng(ticket, { drawAt = '', sellerName = '' } = {}) {
  const width = 1200;
  const height = 720;
  const bg = [247, 241, 231, 255];
  const white = [255, 253, 248, 255];
  const blue = [36, 124, 171, 255];
  const blueDark = [16, 78, 111, 255];
  const gold = [243, 181, 27, 255];
  const goldSoft = [253, 232, 167, 255];
  const text = [20, 56, 77, 255];
  const muted = [102, 123, 134, 255];
  const green = [35, 126, 86, 255];

  const img = new Raster(width, height, bg);

  // Main ticket body.
  img.roundRect(34, 34, 1132, 652, 38, white);
  img.roundRect(34, 34, 270, 652, 38, blueDark);
  img.fillRect(270, 34, 34, 652, blueDark);

  // Ticket cut-outs + perforation.
  img.circle(34, 180, 24, bg);
  img.circle(34, 540, 24, bg);
  img.circle(1166, 180, 24, bg);
  img.circle(1166, 540, 24, bg);
  for (let y = 68; y < 670; y += 38) img.circle(304, y, 6, bg);

  // Left brand panel.
  drawCross(img, 152, 128, gold);
  img.text('FINOTE', 74, 278, 6, white, 1);
  img.text('BIRHAN', 60, 345, 6, gold, 1);
  img.text('SUNDAY SCHOOL', 61, 438, 3, white, 1);
  img.roundRect(68, 505, 168, 56, 18, gold);
  img.text('PAID', 102, 519, 5, blueDark, 1);
  img.text('DIGITAL TICKET', 61, 610, 3, white, 1);

  // Right header.
  img.text('FINOTE BIRHAN DIGITAL TICKET', 360, 75, 4, blueDark, 1);
  img.roundRect(360, 128, 250, 54, 16, goldSoft);
  img.text(`${ticket.pool} ETB DRAW`, 385, 142, 4, blueDark, 1);

  // Main number.
  img.text(`#${formatNumber(ticket.number)}`, 360, 215, 14, text, 2);
  img.text('YOUR TICKET NUMBER', 364, 325, 3, muted, 1);

  // Holder and draw details.
  const holder = asciiLabel(ticket.owner_name || ticket.ownerName || 'TICKET HOLDER', 30);
  img.text('TICKET HOLDER', 360, 390, 3, muted, 1);
  img.text(holder, 360, 425, 5, text, 1);

  const dateLabel = drawAt ? formatDateAscii(drawAt) : 'TO BE ANNOUNCED';
  img.text('DRAW DATE', 360, 505, 3, muted, 1);
  img.text(asciiLabel(dateLabel, 23), 360, 540, 4, text, 1);

  img.text('TICKET ID', 360, 608, 3, muted, 1);
  img.text(asciiLabel(ticket.id, 34), 360, 640, 3, blueDark, 1);

  // Security block.
  const security = crypto.createHash('sha256').update(ticket.id).digest('hex').toUpperCase();
  drawSecurityGrid(img, 930, 186, 12, security, blueDark, gold);
  img.text('VERIFY', 936, 352, 3, muted, 1);
  img.text(security.slice(0, 12), 875, 386, 3, text, 1);

  img.roundRect(834, 438, 292, 62, 20, [233, 247, 239, 255]);
  img.text('PAYMENT VERIFIED', 850, 457, 3, green, 1);

  if (sellerName) {
    img.text('SOLD BY', 862, 535, 3, muted, 1);
    img.text(asciiLabel(sellerName, 20), 842, 570, 3, text, 1);
  } else {
    img.text('OFFICIAL FINOTE BIRHAN', 846, 550, 3, muted, 1);
    img.text('DIGITAL ENTRY', 907, 585, 3, blue, 1);
  }

  img.text('KEEP THIS TICKET - ONE VALID ENTRY', 730, 652, 2, muted, 1);
  return img.toPng();
}

function drawSecurityGrid(img, x, y, cell, hex, dark, accent) {
  const bits = [...hex].flatMap((ch) => {
    const n = parseInt(ch, 16);
    return [3, 2, 1, 0].map((shift) => (n >> shift) & 1);
  });
  const size = 11;
  img.roundRect(x - 14, y - 14, size * cell + 28, size * cell + 28, 18, [247, 241, 231, 255]);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const idx = (row * size + col) % bits.length;
      if (bits[idx]) img.fillRect(x + col * cell, y + row * cell, cell - 2, cell - 2, (row + col) % 7 === 0 ? accent : dark);
    }
  }
}

function drawCross(img, x, y, color) {
  img.roundRect(x - 13, y - 70, 26, 145, 8, color);
  img.roundRect(x - 57, y - 28, 114, 24, 8, color);
  img.circle(x, y - 86, 21, color);
  img.circle(x - 70, y - 16, 17, color);
  img.circle(x + 70, y - 16, 17, color);
  img.circle(x, y + 90, 17, color);
}

function asciiLabel(value, max) {
  const normalized = String(value || '').toUpperCase().normalize('NFKD').replace(/[^A-Z0-9 #./:-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (normalized || 'TICKET HOLDER').slice(0, max);
}

function formatDateAscii(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return asciiLabel(value, 20);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Addis_Ababa', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

class Raster {
  constructor(width, height, bg) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
    this.fillRect(0, 0, width, height, bg);
  }

  pixel(x, y, color) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = color[0]; this.data[i+1] = color[1]; this.data[i+2] = color[2]; this.data[i+3] = color[3] ?? 255;
  }

  fillRect(x, y, w, h, color) {
    for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(this.height, Math.ceil(y+h)); yy += 1) {
      for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(this.width, Math.ceil(x+w)); xx += 1) this.pixel(xx, yy, color);
    }
  }

  circle(cx, cy, r, color) {
    const rr = r * r;
    for (let y = Math.floor(cy-r); y <= Math.ceil(cy+r); y += 1) {
      for (let x = Math.floor(cx-r); x <= Math.ceil(cx+r); x += 1) {
        const dx=x-cx, dy=y-cy;
        if (dx*dx+dy*dy <= rr) this.pixel(x,y,color);
      }
    }
  }

  roundRect(x, y, w, h, r, color) {
    this.fillRect(x+r, y, w-2*r, h, color);
    this.fillRect(x, y+r, w, h-2*r, color);
    this.circle(x+r, y+r, r, color);
    this.circle(x+w-r, y+r, r, color);
    this.circle(x+r, y+h-r, r, color);
    this.circle(x+w-r, y+h-r, r, color);
  }

  text(value, x, y, scale, color, spacing = 1) {
    let cx = x;
    const s = Math.max(1, Math.floor(scale));
    for (const raw of String(value)) {
      const ch = FONT[raw] ? raw : '?';
      const glyph = FONT[ch];
      for (let gy = 0; gy < 7; gy += 1) {
        for (let gx = 0; gx < 5; gx += 1) {
          if (glyph[gy][gx] === '1') this.fillRect(cx + gx*s, y + gy*s, s, s, color);
        }
      }
      cx += 5*s + spacing*s;
      if (cx > this.width - 10) break;
    }
  }

  toPng() {
    const scan = Buffer.alloc((this.width * 4 + 1) * this.height);
    for (let y = 0; y < this.height; y += 1) {
      const rowStart = y * (this.width * 4 + 1);
      scan[rowStart] = 0;
      this.data.copy(scan, rowStart + 1, y*this.width*4, (y+1)*this.width*4);
    }
    const chunks = [
      chunk('IHDR', ihdr(this.width, this.height)),
      chunk('IDAT', zlib.deflateSync(scan, { level: 9 })),
      chunk('IEND', Buffer.alloc(0))
    ];
    return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), ...chunks]);
  }
}

function ihdr(width, height) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width,0); b.writeUInt32BE(height,4);
  b[8]=8; b[9]=6; b[10]=0; b[11]=0; b[12]=0;
  return b;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n=0;n<256;n+=1) {
    let c=n;
    for (let k=0;k<8;k+=1) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);
    table[n]=c>>>0;
  }
  return table;
})();

function crc32(buf) {
  let c=0xFFFFFFFF;
  for (const byte of buf) c=CRC_TABLE[(c^byte)&0xFF]^(c>>>8);
  return (c^0xFFFFFFFF)>>>0;
}
