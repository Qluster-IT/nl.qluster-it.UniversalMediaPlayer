(function () {
    'use strict';

    // The speaker plays the audio, so the widget analyses the same file itself and follows the speaker position.
    const RATE = 22050;
    const CHUNK = 256 * 1024;
    const STREAMED = /^audio\/(?:mpeg|mp3|mpa|mpeg3|x-mpeg|aac|aacp|x-aac)$/;
    // ahead: chunks analysed from the playback position onward (Infinity analyses the whole track).
    // maxFile: largest non-MPEG/AAC file decoded in one piece; 0 disables those formats.
    const PROFILES = {
        light: {bands: 12, size: 512, fps: 10, drawFps: 12, maxRatio: 1, ahead: 1, maxFile: 0, peaks: false},
        normal: {bands: 24, size: 1024, fps: 20, drawFps: 30, maxRatio: 2, ahead: 3, maxFile: 40 * 1024 * 1024, peaks: false},
        heavy: {bands: 40, size: 2048, fps: 30, drawFps: 60, maxRatio: 3, ahead: Infinity, maxFile: 40 * 1024 * 1024, peaks: true}
    };
    const tables = new Map();

    function tablesFor(size, bands) {
        const key = size + ':' + bands;
        if (tables.has(key)) return tables.get(key);
        const table = {
            hann: new Float32Array(size), reverse: new Uint16Array(size),
            cos: new Float32Array(size / 2), sin: new Float32Array(size / 2),
            edges: new Uint16Array(bands + 1), reference: Math.pow(size / 4, 2),
            re: new Float32Array(size), im: new Float32Array(size)
        };
        for (let i = 0; i < size; i++) {
            table.hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1));
            let r = 0;
            for (let bit = 1, value = i; bit < size; bit <<= 1, value >>= 1) r = (r << 1) | (value & 1);
            table.reverse[i] = r;
        }
        for (let i = 0; i < size / 2; i++) {
            table.cos[i] = Math.cos(-2 * Math.PI * i / size);
            table.sin[i] = Math.sin(-2 * Math.PI * i / size);
        }
        for (let band = 0; band <= bands; band++) {
            const frequency = 40 * Math.pow(10000 / 40, band / bands);
            table.edges[band] = Math.max(band ? table.edges[band - 1] + 1 : 1, Math.round(frequency * size / RATE));
        }
        tables.set(key, table);
        return table;
    }

    function fft(table, size) {
        const {re, im, reverse, cos, sin} = table;
        for (let i = 0; i < size; i++) {
            const j = reverse[i];
            if (j > i) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }
        for (let length = 2; length <= size; length <<= 1) {
            const half = length >> 1;
            const step = size / length;
            for (let start = 0; start < size; start += length) {
                for (let k = 0; k < half; k++) {
                    const a = start + k;
                    const b = a + half;
                    const wr = cos[k * step];
                    const wi = sin[k * step];
                    const tr = wr * re[b] - wi * im[b];
                    const ti = wr * im[b] + wi * re[b];
                    re[b] = re[a] - tr; im[b] = im[a] - ti;
                    re[a] += tr; im[a] += ti;
                }
            }
        }
    }

    function analyse(profile, buffer, frames, first) {
        const {size, bands, fps} = profile;
        const table = tablesFor(size, bands);
        const {re, im, hann, edges, reference} = table;
        const channels = Array.from({length: buffer.numberOfChannels}, (_, i) => buffer.getChannelData(i));
        const hop = buffer.sampleRate / fps;
        for (let frame = 0; ; frame++) {
            const start = Math.round(frame * hop);
            const index = first + frame;
            if (start + size > buffer.length || index >= frames.count) break;
            for (let i = 0; i < size; i++) {
                let sample = 0;
                for (const channel of channels) sample += channel[start + i];
                re[i] = sample / channels.length * hann[i];
                im[i] = 0;
            }
            fft(table, size);
            for (let band = 0; band < bands; band++) {
                let power = 0;
                for (let bin = edges[band]; bin < edges[band + 1]; bin++) {
                    power = Math.max(power, re[bin] * re[bin] + im[bin] * im[bin]);
                }
                const level = 10 * Math.log10(power / reference + 1e-12);
                frames.data[index * bands + band] = Math.max(0, Math.min(255, Math.round((level + 60) / 60 * 255)));
            }
            frames.known[index] = 1;
        }
    }

    function decode(bytes) {
        const Context = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const context = new Context(1, 1, RATE);
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        return new Promise((resolve, reject) => {
            const result = context.decodeAudioData(data, resolve, reject);
            if (result && typeof result.then === 'function') result.then(resolve, reject);
        });
    }

    function bytesOf(base64) {
        const text = atob(base64);
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
        return bytes;
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    const BITRATES = {
        v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
        v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
        v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
        v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
        v2l2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    };
    const SAMPLE_RATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]};

    // Size of the leading ID3v2 tags (often hundreds of KB of artwork), which contain no audio.
    function tagSize(bytes) {
        let start = 0;
        while (start + 10 <= bytes.length && bytes[start] === 0x49 && bytes[start + 1] === 0x44 && bytes[start + 2] === 0x33) {
            const size = ((bytes[start + 6] & 0x7f) << 21) | ((bytes[start + 7] & 0x7f) << 14) |
                ((bytes[start + 8] & 0x7f) << 7) | (bytes[start + 9] & 0x7f);
            start += 10 + size + (bytes[start + 5] & 0x10 ? 10 : 0);
        }
        return start;
    }

    function frameHeader(bytes, at) {
        if (bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return null;
        const version = (bytes[at + 1] >> 3) & 3;
        const layer = 4 - ((bytes[at + 1] >> 1) & 3);
        const bitrateIndex = bytes[at + 2] >> 4;
        const rateIndex = (bytes[at + 2] >> 2) & 3;
        if (version === 1 || layer === 4 || !bitrateIndex || bitrateIndex === 15 || rateIndex === 3) return null;
        const table = version === 3 ? 'v1l' + layer : layer === 1 ? 'v2l1' : 'v2l2';
        const samples = layer === 1 ? 384 : layer === 3 && version !== 3 ? 576 : 1152;
        return {version, layer, samples, bitrate: BITRATES[table][bitrateIndex],
            sampleRate: SAMPLE_RATES[version][rateIndex], mono: (bytes[at + 3] >> 6) === 3};
    }

    function readUint32(bytes, at) {
        return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
    }

    // Maps byte offsets to playback time, so chunks decoded on their own land at the moment the speaker plays them.
    function timeline(bytes, base, start, total, fallback) {
        const audio = Math.max(1, total - start);
        const linear = duration => ({duration, at: offset => Math.max(0, offset - start) / audio * duration});
        let at = start - base;
        const end = Math.min(bytes.length - 4, at + 64 * 1024);
        const valid = offset => {
            const header = frameHeader(bytes, offset);
            if (!header) return false;
            const padding = (bytes[offset + 2] >> 1) & 1;
            const length = header.layer === 1 ? (Math.floor(12000 * header.bitrate / header.sampleRate) + padding) * 4
                : Math.floor((header.layer === 3 && header.version !== 3 ? 72000 : 144000) * header.bitrate / header.sampleRate) + padding;
            return offset + length + 4 > bytes.length || Boolean(frameHeader(bytes, offset + length));
        };
        while (at < end && !valid(at)) at++;
        const header = at < end ? frameHeader(bytes, at) : null;
        if (!header) return fallback ? linear(fallback) : null;
        const side = header.version === 3 ? (header.mono ? 17 : 32) : (header.mono ? 9 : 17);
        const xing = at + 4 + side;
        const tag = String.fromCharCode(...bytes.subarray(xing, xing + 4));
        const frameMs = frames => frames * header.samples / header.sampleRate * 1000;
        if ((tag === 'Xing' || tag === 'Info') && xing + 8 <= bytes.length) {
            const flags = readUint32(bytes, xing + 4);
            let field = xing + 8;
            const frames = flags & 1 ? readUint32(bytes, field) : 0;
            if (flags & 1) field += 4;
            const size = flags & 2 ? readUint32(bytes, field) || audio : audio;
            if (flags & 2) field += 4;
            const duration = frames ? frameMs(frames) : fallback || audio * 8 / header.bitrate;
            if (tag === 'Xing' && flags & 4 && field + 100 <= bytes.length) {
                const toc = Array.from(bytes.subarray(field, field + 100));
                return {duration, at(offset) {
                    const fraction = Math.min(256, Math.max(0, offset - start) / size * 256);
                    let percent = 99;
                    while (percent > 0 && toc[percent] > fraction) percent--;
                    const low = toc[percent];
                    const high = percent < 99 ? toc[percent + 1] : 256;
                    return (percent + (high > low ? Math.min(1, (fraction - low) / (high - low)) : 0)) / 100 * duration;
                }};
            }
            return {duration, at: offset => Math.min(1, Math.max(0, offset - start) / size) * duration};
        }
        const vbri = at + 36;
        if (String.fromCharCode(...bytes.subarray(vbri, vbri + 4)) === 'VBRI' && vbri + 18 <= bytes.length) {
            return linear(frameMs(readUint32(bytes, vbri + 14)));
        }
        // Constant bit rate: kilobits per second equal bits per millisecond.
        return {duration: audio * 8 / header.bitrate, at: offset => Math.max(0, offset - start) * 8 / header.bitrate};
    }

    class Spectrum {
        constructor(request, level) {
            this.request = request;
            this.profile = PROFILES[level] || PROFILES.normal;
            this.revision = 0;
            this.status = 'idle';
            this.frames = null;
        }

        get bands() { return this.profile.bands; }

        supported() {
            return Boolean(window.OfflineAudioContext || window.webkitOfflineAudioContext);
        }

        load(key, item, duration, position) {
            if (key === this.key) return;
            this.cancel();
            this.key = key;
            if (!key || !this.supported()) {
                this.status = key ? 'unavailable' : 'idle';
                return;
            }
            this.status = 'loading';
            this.position = position;
            const revision = this.revision;
            this.run(revision, item, duration).catch(error => {
                if (revision !== this.revision) return;
                console.error('Unable to analyse the spectrum:', error);
                this.status = this.frames ? 'ready' : 'unavailable';
            });
        }

        cancel() {
            this.revision++;
            this.key = null;
            this.frames = null;
            this.status = 'idle';
        }

        async fetch(revision, item, offset) {
            const result = await this.request({item, offset});
            if (revision !== this.revision) throw new Error('cancelled');
            if (result.item !== item || result.offset !== offset) throw new Error('Unexpected spectrum chunk.');
            return result;
        }

        allocate(duration) {
            const {fps, bands} = this.profile;
            const count = Math.ceil(duration / 1000 * fps) + fps;
            this.frames = {count, data: new Uint8Array(count * bands), known: new Uint8Array(count)};
        }

        async run(revision, item, duration) {
            const profile = this.profile;
            const first = await this.fetch(revision, item, 0);
            const total = first.total;
            if (!STREAMED.test(first.type)) {
                if (total > profile.maxFile) throw new Error('This track format is not analysed at this visualizer level.');
                const bytes = new Uint8Array(total);
                let chunk = first;
                for (;;) {
                    bytes.set(bytesOf(chunk.data), chunk.offset);
                    if (chunk.next == null) break;
                    chunk = await this.fetch(revision, item, chunk.next);
                }
                const buffer = await decode(bytes);
                if (revision !== this.revision) return;
                this.allocate(duration || buffer.duration * 1000);
                analyse(profile, buffer, this.frames, 0);
                this.status = 'ready';
                return;
            }
            // MPEG audio can be decoded per chunk, so only chunks near the playback position are fetched.
            const headBytes = bytesOf(first.data);
            const start = tagSize(headBytes);
            let mapBytes = headBytes;
            let mapBase = 0;
            if (start + 4096 > headBytes.length && start < total) {
                mapBase = Math.floor(start / CHUNK) * CHUNK;
                mapBytes = bytesOf((await this.fetch(revision, item, mapBase)).data);
            }
            const map = timeline(mapBytes, mapBase, start, total, duration);
            if (!map) throw new Error('The track duration is unknown.');
            const head = start < headBytes.length ? await decode(headBytes).catch(() => null) : null;
            if (revision !== this.revision) return;
            const length = Math.max(duration || 0, map.duration);
            this.allocate(length);
            if (head) analyse(profile, head, this.frames, 0);
            this.status = 'ready';
            const count = Math.ceil(total / CHUNK);
            const done = new Uint8Array(count);
            done[0] = 1;
            // Finds the chunk holding the current position; the timeline is monotonic, so a binary search suffices.
            const current = () => {
                const position = typeof this.position === 'function' ? this.position() : this.position;
                let low = 0;
                let high = count - 1;
                while (low < high) {
                    const middle = (low + high + 1) >> 1;
                    if (map.at(middle * CHUNK) <= position) low = middle;
                    else high = middle - 1;
                }
                return low;
            };
            const pick = () => {
                const start = current();
                const end = Math.min(count - 1, start + profile.ahead);
                for (let index = start; index <= end; index++) if (!done[index]) return index;
                if (profile.ahead === Infinity) for (let index = 1; index < start; index++) if (!done[index]) return index;
                return -1;
            };
            let failures = 0;
            for (;;) {
                if (revision !== this.revision) return;
                const index = pick();
                if (index < 0) {
                    if (done.every(Boolean)) return;
                    await delay(1000);
                    continue;
                }
                done[index] = 1;
                const offset = index * CHUNK;
                let chunk;
                try { chunk = await this.fetch(revision, item, offset); }
                catch (error) {
                    if (revision !== this.revision || ++failures > 3) throw error;
                    done[index] = 0;
                    await delay(3000);
                    continue;
                }
                failures = 0;
                try {
                    const buffer = await decode(bytesOf(chunk.data));
                    if (revision !== this.revision) return;
                    analyse(profile, buffer, this.frames, Math.round(map.at(offset) / 1000 * profile.fps));
                } catch (error) {
                    if (revision !== this.revision) return;
                }
            }
        }

        levels(position, target) {
            const frames = this.frames;
            const {fps, bands} = this.profile;
            if (!frames) return false;
            const exact = position / 1000 * fps;
            let index = Math.floor(exact);
            let found = -1;
            for (let distance = 0; distance <= 3 && found < 0; distance++) {
                if (frames.known[index - distance]) found = index - distance;
                else if (frames.known[index + distance]) found = index + distance;
            }
            if (found < 0 || found >= frames.count) return false;
            const next = frames.known[found + 1] ? found + 1 : found;
            const blend = Math.min(1, Math.max(0, exact - found));
            for (let band = 0; band < bands; band++) {
                const a = frames.data[found * bands + band];
                const b = frames.data[next * bands + band];
                target[band] = (a + (b - a) * blend) / 255;
            }
            return true;
        }
    }

    Spectrum.PROFILES = PROFILES;
    Spectrum.timeline = (bytes, base, total, duration) => timeline(bytes, base, tagSize(bytes), total, duration);
    window.UmpSpectrum = Spectrum;
}());
