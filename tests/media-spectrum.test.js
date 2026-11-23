'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const context = {window: {}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'media-spectrum.js'), 'utf8'), context);
const Spectrum = context.window.UmpSpectrum;

function id3(size) {
    const tag = new Uint8Array(10 + size);
    tag.set([0x49, 0x44, 0x33, 4, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
    return tag;
}

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo: 417 bytes per frame.
function frames(count, xing) {
    const bytes = new Uint8Array(count * 417);
    for (let i = 0; i < count; i++) bytes.set([0xff, 0xfb, 0x90, 0x00], i * 417);
    if (xing) bytes.set(xing, 36);
    return bytes;
}

function join(...parts) {
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) { bytes.set(part, at); at += part.length; }
    return bytes;
}

test('spectrum timeline skips ID3 artwork for constant bit rate MP3', () => {
    const bytes = join(id3(300000), frames(40));
    const total = 300010 + 16000000;
    const map = Spectrum.timeline(bytes, 0, total, 1000000);
    assert.equal(map.at(300010), 0);
    assert.equal(map.at(100), 0);
    assert.equal(map.at(300010 + 16000), 1000);
    assert.equal(Math.round(map.duration), 1000000);
});

test('spectrum timeline follows the Xing table of contents for variable bit rate MP3', () => {
    const toc = Array.from({length: 100}, (_, i) => i < 50 ? Math.round(i * 64 / 50) : Math.round(64 + (i - 50) * 192 / 50));
    const xing = [0x58, 0x69, 0x6e, 0x67, 0, 0, 0, 7, 0, 0, 0x27, 0x10, 0, 0x0f, 0x42, 0x40, ...toc];
    const map = Spectrum.timeline(frames(4, xing), 0, 1000000, 0);
    const duration = 10000 * 1152 / 44100 * 1000;
    assert.equal(Math.round(map.duration), Math.round(duration));
    // A quarter of the bytes covers half the time in this table.
    assert.ok(Math.abs(map.at(250000) - duration / 2) < duration / 100);
    assert.ok(map.at(500000) > duration / 2);
});
