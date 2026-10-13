import zlib from 'node:zlib';

/** Minimal RGBA canvas + PNG encoder, used to generate the demo illustration offline. */
export class Canvas {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  constructor(width: number, height: number, bg: [number, number, number]) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) this.data.set([bg[0], bg[1], bg[2], 255], i * 4);
  }

  blend(x: number, y: number, rgb: [number, number, number], alpha: number) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    for (let c = 0; c < 3; c++) this.data[i + c] = Math.round(this.data[i + c] * (1 - alpha) + rgb[c] * alpha);
  }

  fillRect(x0: number, y0: number, w: number, h: number, rgb: [number, number, number], alpha = 1) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.blend(x, y, rgb, alpha);
  }

  strokeRect(x0: number, y0: number, w: number, h: number, rgb: [number, number, number], t = 3) {
    this.fillRect(x0, y0, w, t, rgb);
    this.fillRect(x0, y0 + h - t, w, t, rgb);
    this.fillRect(x0, y0, t, h, rgb);
    this.fillRect(x0 + w - t, y0, t, h, rgb);
  }

  grid(step: number, rgb: [number, number, number], alpha: number) {
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) if (x % step === 0 || y % step === 0) this.blend(x, y, rgb, alpha);
  }

  toPng(): Buffer {
    const raw = Buffer.alloc((this.width * 4 + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      raw[y * (this.width * 4 + 1)] = 0;
      Buffer.from(this.data.buffer, y * this.width * 4, this.width * 4).copy(raw, y * (this.width * 4 + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
