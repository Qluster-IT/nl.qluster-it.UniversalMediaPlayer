'use strict';

const dgram = require('node:dgram');
const crypto = require('node:crypto');
const fetch = require('node-fetch');
const WebSocket = require('ws');

const NAME = Buffer.from('Universal Media Player').toString('base64');
const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

class PermissionError extends Error {}

// Reads the TV's own description. A Samsung TV's remote ID differs from its media renderer UUID, so the
// first match is by the model at a discovered renderer address; afterwards the stored remote ID must match.
async function describe(host, expected, timeout = 2000) {
    let response;
    try {
        response = await fetch(`http://${host}:8001/api/v2/`, {redirect: 'error', timeout, size: 64 * 1024});
    } catch {
        return null;
    }
    if (!response.ok) return null;
    const {device} = await response.json().catch(() => ({}));
    if (!device || typeof device.id !== 'string' || !/^uuid:[\w-]{1,100}$/i.test(device.id)) return null;
    const id = device.id.toLowerCase();
    if (expected?.id ? expected.id !== id : !expected?.model || device.modelName !== expected.model) return null;
    return {
        id,
        power: device.PowerState === 'on' ? 'on' : 'standby',
        frame: device.FrameTVSupport === 'true',
        mac: MAC.test(device.wifiMac || '') ? device.wifiMac.toLowerCase() : null
    };
}

function connect(host, channel, token, timeout) {
    const query = `name=${NAME}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`wss://${host}:8002/api/v2/channels/${channel}?${query}`,
            {rejectUnauthorized: false, handshakeTimeout: 5000, maxPayload: 256 * 1024});
        const fail = error => {
            clearTimeout(timer);
            socket.terminate();
            reject(error);
        };
        // The TV waits for the user to allow a new remote, so the first connection can take a while.
        const timer = setTimeout(() => fail(new PermissionError('The TV did not allow the connection.')), timeout);
        socket.on('message', data => {
            let message;
            try { message = JSON.parse(data); } catch { return; }
            if (message.event === 'ms.channel.connect') {
                clearTimeout(timer);
                resolve({socket, token: message.data?.token || null});
            } else if (message.event === 'ms.channel.unauthorized' || message.event === 'ms.channel.timeOut') {
                fail(new PermissionError('The TV did not allow the connection.'));
            }
        });
        socket.on('error', fail);
        socket.on('close', () => fail(new Error('The TV closed the connection.')));
    });
}

async function sendKey(host, token, key, timeout = 35000) {
    const {socket, token: issued} = await connect(host, 'samsung.remote.control', token, timeout);
    try {
        socket.send(JSON.stringify({method: 'ms.remote.control',
            params: {Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey'}}));
        await wait(300);
    } finally {
        socket.removeAllListeners('close');
        socket.close();
    }
    return issued;
}

// Frame TVs report art mode separately; it is shown as off, like the remote's power button.
async function artMode(host, token) {
    const {socket} = await connect(host, 'com.samsung.art-app', token, 5000);
    try {
        const id = crypto.randomUUID();
        const answer = new Promise(resolve => socket.on('message', data => {
            try {
                const message = JSON.parse(data);
                const value = message.event === 'd2d_service_message' && JSON.parse(message.data);
                if (value?.event === 'artmode_status') resolve(value.value === 'on');
            } catch { /* ignore unrelated messages */ }
        }));
        socket.send(JSON.stringify({method: 'ms.channel.emit', params: {event: 'art_app_request', to: 'host',
            data: JSON.stringify({request: 'get_artmode_status', id})}}));
        return await Promise.race([answer, wait(4000).then(() => null)]);
    } finally {
        socket.removeAllListeners('close');
        socket.close();
    }
}

function magicPacket(mac) {
    const bytes = Buffer.from(mac.replace(/:/g, ''), 'hex');
    return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
}

async function wake(host, mac) {
    const socket = dgram.createSocket('udp4');
    try {
        await new Promise((resolve, reject) => {
            socket.once('error', reject);
            socket.bind(() => resolve());
        });
        socket.setBroadcast(true);
        const packet = magicPacket(mac);
        const subnet = host.split('.').slice(0, 3).concat('255').join('.');
        for (const address of new Set(['255.255.255.255', subnet])) {
            await new Promise(resolve => socket.send(packet, 9, address, () => resolve()));
        }
    } finally {
        socket.close();
    }
}

module.exports = {describe, sendKey, artMode, wake, magicPacket, PermissionError};
