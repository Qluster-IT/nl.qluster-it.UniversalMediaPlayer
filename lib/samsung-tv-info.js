'use strict';

const fetch = require('node-fetch');
const {isIPv4} = require('node:net');

const lan = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)/;
const clean = value => typeof value === 'string' && /^[a-z0-9._ -]{1,64}$/i.test(value.trim()) &&
    !/^(?:unknown|none|n\/a|-)$/i.test(value.trim()) ? value.trim() : null;
const flag = value => value === true || value === 'true';

function createReader(request = fetch, now = Date.now) {
    const cache = new WeakMap();
    return function readSamsungTv(room, log) {
        if (room.protocol !== 'dlna' || room.kind !== 'tv' || !room.samsung || !isIPv4(room.host) || !lan.test(room.host)) return null;
        const previous = cache.get(room);
        if (previous && now() < previous.until) return previous.result;
        const entry = {until: Infinity};
        entry.result = (async () => {
            const response = await request(`http://${room.host}:8001/api/v2/`, {
                redirect: 'error', timeout: 1250, size: 16 * 1024
            });
            if (!response.ok) {
                response.body?.destroy();
                throw new Error(`HTTP ${response.status}`);
            }
            const {device, type} = await response.json();
            if (!/^Samsung SmartTV$/i.test(device?.type || type || '')) throw new Error('Not a Samsung TV response');
            const model = clean(device?.modelName);
            if (room.model && model && room.model.toUpperCase() !== model.toUpperCase()) {
                throw new Error('TV model does not match the discovered renderer');
            }
            const power = clean(device?.PowerState)?.toLowerCase();
            const network = clean(device?.networkType)?.toLowerCase();
            const resolution = typeof device?.resolution === 'string' && device.resolution.length < 24 &&
                /^([1-9]\d{2,4})\s*[x×]\s*([1-9]\d{2,4})$/i.exec(device.resolution.trim());
            return {
                model, os: clean(device?.OS), firmware: clean(device?.firmwareVersion),
                resolution: resolution ? `${resolution[1]} × ${resolution[2]}` : null,
                power: ['on', 'off', 'standby'].includes(power) ? power : null,
                network: ['wired', 'wireless'].includes(network) ? network : null,
                frame: flag(device?.FrameTVSupport), voice: flag(device?.VoiceSupport), gamepad: flag(device?.GamePadSupport)
            };
        })().then(info => {
            entry.until = now() + 15000;
            return info;
        }, error => {
            entry.until = now() + 30000;
            log?.('Samsung TV information unavailable:', error.message);
            return null;
        });
        cache.set(room, entry);
        return entry.result;
    };
}

module.exports = {readSamsungTv: createReader(), createReader};
