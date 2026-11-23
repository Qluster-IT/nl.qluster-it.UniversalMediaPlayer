'use strict';

const http = require('node:http');
const {randomUUID} = require('node:crypto');
const {isIPv4} = require('node:net');
const fetch = require('node-fetch');

class SpeakerEvents {
    constructor(homey) {
        this.homey = homey;
        this.entries = new Map();
        this.routes = new Map();
    }

    async listen() {
        const server = http.createServer({requestTimeout: 5000, headersTimeout: 5000}, (req, res) => {
            const entry = this.routes.get(req.url);
            const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '');
            const sid = req.headers.sid;
            if (req.method !== 'NOTIFY' || !entry?.sid || peer !== entry.host || sid !== entry.sid ||
                req.headers.nt !== 'upnp:event' || req.headers.nts !== 'upnp:propchange') {
                res.writeHead(412).end();
                return;
            }
            // Treat events only as invalidations; never parse or trust their payload.
            res.writeHead(200, {Connection: 'close'}).end();
            if (!entry.timer) entry.timer = setTimeout(() => {
                entry.timer = null;
                for (const [speaker, expires] of entry.watchers) {
                    if (expires > Date.now()) {
                        this.homey.app.speakerUpdates?.emit('speaker', speaker);
                        this.homey.api.realtime('speaker_state_changed', {speaker}).catch(error =>
                            this.homey.app.error('Unable to deliver speaker update:', error));
                    }
                }
            }, 200);
        });
        server.maxConnections = 32;
        this.server = server;
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '0.0.0.0', resolve);
        });
        server.on('error', error => this.homey.app.error('Speaker event listener:', error));
        server.unref();
        return server.address().port;
    }

    watch(speaker, endpoint) {
        if (this.closed || !endpoint) return;
        let entry = this.entries.get(endpoint);
        if (!entry) {
            if (this.entries.size >= 32) return;
            entry = {host: new URL(endpoint).hostname, path: `/speaker-events/${randomUUID()}`, watchers: new Map()};
            this.entries.set(endpoint, entry);
            this.routes.set(entry.path, entry);
        }
        entry.watchers.set(speaker, Date.now() + 35000);
        for (const [id, expires] of entry.watchers) if (expires <= Date.now()) entry.watchers.delete(id);
        this.refresh(endpoint, entry);
        if (!this.cleanup) {
            this.cleanup = setInterval(() => this.expire(), 10000);
            this.cleanup.unref();
        }
    }

    refresh(endpoint, entry) {
        if (entry.pending || this.closed || Date.now() < (entry.retryAt || 0)) return;
        clearTimeout(entry.renewal);
        entry.pending = this.subscribe(endpoint, entry).catch(error => {
            entry.sid = null;
            this.homey.app.log('Speaker events unavailable; using polling:', error.message);
            entry.retryAt = Date.now() + 30000;
        }).finally(() => {
            entry.pending = null;
            if (!this.closed && entry.sid) {
                entry.renewal = setTimeout(() => {
                    if ([...entry.watchers.values()].some(expires => expires > Date.now())) this.refresh(endpoint, entry);
                }, Math.max(0, entry.retryAt - Date.now()));
                entry.renewal.unref();
            }
        });
    }

    async subscribe(endpoint, entry) {
        const address = await this.homey.cloud.getLocalAddress();
        const host = new URL(`http://${address}`).hostname;
        if (!isIPv4(host)) throw new Error('No IPv4 address for speaker events.');
        if (this.closed) return;
        this.listener ??= this.listen().catch(error => { this.listener = null; throw error; });
        const origin = `http://${host}:${await this.listener}`;
        if (this.closed) return;
        if (entry.sid && entry.origin !== origin) {
            const previous = entry.sid;
            entry.sid = null;
            await this.unsubscribe(endpoint, previous);
        }
        if (this.closed) return;
        const request = headers => fetch(endpoint, {method: 'SUBSCRIBE', redirect: 'error', timeout: 2500,
            headers: {...headers, TIMEOUT: 'Second-60'}});
        const fresh = {CALLBACK: `<${origin}${entry.path}>`, NT: 'upnp:event'};
        let response = await request(entry.sid ? {SID: entry.sid} : fresh);
        response.body?.destroy();
        // A speaker that restarted no longer knows the SID (412); subscribe again straight away.
        if (entry.sid && !response.ok && !this.closed) {
            entry.sid = null;
            response = await request(fresh);
            response.body?.destroy();
        }
        const sid = response.headers.get('sid');
        if (!response.ok || !sid?.startsWith('uuid:')) {
            entry.sid = null;
            throw new Error(`Subscription failed (HTTP ${response.status}).`);
        }
        entry.sid = sid;
        entry.origin = origin;
        if (this.closed) {
            await this.unsubscribe(endpoint, sid);
            return;
        }
        const seconds = Number(/^Second-(\d+)$/i.exec(response.headers.get('timeout'))?.[1]);
        entry.retryAt = Date.now() + (seconds > 0 ? Math.max(1000, Math.min(45000, seconds * 750)) : 45000);
    }

    expire(all = false) {
        const removals = [];
        for (const [endpoint, entry] of this.entries) {
            for (const [speaker, expires] of entry.watchers) if (expires <= Date.now()) entry.watchers.delete(speaker);
            if (!all && (entry.watchers.size || entry.pending)) continue;
            this.entries.delete(endpoint);
            this.routes.delete(entry.path);
            clearTimeout(entry.timer);
            clearTimeout(entry.renewal);
            if (entry.pending) removals.push(entry.pending);
            else if (entry.sid) removals.push(this.unsubscribe(endpoint, entry.sid));
        }
        return Promise.all(removals);
    }

    async unsubscribe(endpoint, sid) {
        try {
            const response = await fetch(endpoint, {method: 'UNSUBSCRIBE', redirect: 'error', timeout: 2500, headers: {SID: sid}});
            response.body?.destroy();
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
        } catch (error) {
            this.homey.app.log('Unable to remove speaker subscription:', error.message);
        }
    }

    async close() {
        this.closed = true;
        clearInterval(this.cleanup);
        const closing = this.server && new Promise(resolve => this.server.close(resolve));
        this.server?.closeAllConnections();
        await Promise.all([this.expire(true), closing]);
    }
}

module.exports = SpeakerEvents;
