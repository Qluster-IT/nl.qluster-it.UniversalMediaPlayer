'use strict';

const fetch = require('node-fetch');
const {pipeline} = require('node:stream/promises');
const {Transform} = require('node:stream');
const {isIPv4} = require('node:net');
const TTL = 5 * 60_000;

class SpeakerArtwork {
    constructor(homey) {
        this.homey = homey;
        this.entries = new Map();
    }

    async host(value, target) {
        if (!value || !target.endpoint || this.closed) return value;
        const url = new URL(value);
        const speaker = new URL(target.endpoint);
        if (url.protocol !== 'http:' || !isIPv4(speaker.hostname) || url.hostname !== speaker.hostname ||
            url.port !== speaker.port || url.username || url.password) return value;
        const existing = this.entries.get(value);
        if (existing && existing.expires > Date.now()) return existing.result;
        if (existing || this.entries.size >= 24) return value;
        const entry = {expires: Date.now() + TTL};
        this.entries.set(value, entry);
        entry.result = this.register(value, entry).catch(error => {
            this.homey.app.log('Unable to host speaker artwork:', error.message);
            return value;
        });
        entry.timer = setTimeout(() => {
            this.entries.delete(value);
            this.release(entry);
        }, TTL);
        entry.timer.unref();
        return entry.result;
    }

    async register(url, entry) {
        const image = await this.homey.images.createImage();
        entry.image = image;
        if (this.closed) return url;
        image.setStream(async stream => {
            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), 5000);
            try {
                const response = await fetch(url, {redirect: 'error', signal: abort.signal});
                if (!response.ok || !/^image\/(?:jpeg|png|gif|webp|bmp|avif)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
                    response.body?.destroy();
                    throw new Error('The speaker did not return a supported image.');
                }
                let bytes = 0;
                await pipeline(response.body, new Transform({
                    transform(chunk, encoding, done) {
                        bytes += chunk.length;
                        if (bytes > 2 * 1024 * 1024) done(new Error('Speaker artwork exceeds 2 MiB.'));
                        else done(null, chunk);
                    }
                }), stream);
            } finally { clearTimeout(timer); }
        });
        await image.update();
        return `https://${this.homey.app.widgetHomeyId}.connect.athom.com/api/image/${image.id}`;
    }

    async release(entry) {
        clearTimeout(entry.timer);
        await entry.result;
        if (!entry.image) return;
        try { await entry.image.unregister(); }
        catch (error) { this.homey.app.log('Unable to remove hosted speaker artwork:', error.message); }
    }

    async close() {
        this.closed = true;
        const entries = [...this.entries.values()];
        this.entries.clear();
        await Promise.all(entries.map(entry => this.release(entry)));
    }
}

module.exports = SpeakerArtwork;
