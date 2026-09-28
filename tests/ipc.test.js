// Unit tests for the raw IPC image decoder (src/js/ipc.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodePixelResponse } from '../src/js/core/utils.js';

// 2x1 image, little-endian header + flat RGBA
function sampleBuffer() {
    const buf = new Uint8Array(8 + 2 * 4);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 2, true); // width
    dv.setUint32(4, 1, true); // height
    buf.set([10, 20, 30, 255, 40, 50, 60, 255], 8);
    return buf;
}

test('decodePixelResponse reads the header and the pixels', () => {
    const out = decodePixelResponse(sampleBuffer());
    assert.equal(out.width, 2);
    assert.equal(out.height, 1);
    assert.equal(out.rgba.length, 8);
    assert.deepEqual([...out.rgba], [10, 20, 30, 255, 40, 50, 60, 255]);
});

test('decodePixelResponse accepts a raw ArrayBuffer', () => {
    const out = decodePixelResponse(sampleBuffer().buffer);
    assert.equal(out.width, 2);
    assert.equal(out.rgba[4], 40);
});

test('decodePixelResponse honors the byte offset of a subarray', () => {
    const inner = sampleBuffer();
    const padded = new Uint8Array(inner.length + 4);
    padded.set(inner, 4);
    const view = padded.subarray(4); // non-zero byteOffset
    const out = decodePixelResponse(view);
    assert.equal(out.width, 2);
    assert.deepEqual([...out.rgba], [10, 20, 30, 255, 40, 50, 60, 255]);
});
