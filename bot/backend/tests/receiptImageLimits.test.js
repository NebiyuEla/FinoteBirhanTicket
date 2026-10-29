import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { receiptImageDimensions } from '../src/telegram.js';

test('receipt QR decoder checks PNG dimensions before allocating pixels', () => {
  const png = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(720, 20);
  assert.deepEqual(receiptImageDimensions(png), { width: 1280, height: 720 });
});

test('receipt QR decoder checks JPEG dimensions before allocating pixels', () => {
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x11,0x08,0x02,0xd0,0x05,0x00,0,0,0,0,0,0,0,0,0,0]);
  assert.deepEqual(receiptImageDimensions(jpeg), { width: 1280, height: 720 });
});

test('unrecognized image buffers are not decoded as QR receipts', () => {
  assert.equal(receiptImageDimensions(Buffer.from('not an image')), null);
  assert.equal(receiptImageDimensions(Buffer.from([0xff,0xd8,0xff])), null);
});

test('production limits receipt decoding to prevent memory pressure', () => {
  const source = fs.readFileSync(new URL('../src/telegram.js', import.meta.url), 'utf8');
  assert.match(source, /dimensions\.width \* dimensions\.height > 2_000_000/);
  assert.match(source, /buffer\.length > 3 \* 1024 \* 1024/);
});
