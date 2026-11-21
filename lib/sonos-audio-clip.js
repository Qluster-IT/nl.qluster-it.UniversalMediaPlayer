'use strict';

const {isIPv4} = require('node:net');
const WebSocket = require('ws');

const namespace = 'audioClip:1';
const commandTimeout = 6000;
const connectionError = message => Object.assign(new Error(message), {code: 'SONOS_CONNECTION'});

function playClip(speaker, media, volume, onActive, connect = (...args) => new WebSocket(...args)) {
    const playerId = speaker.id.replace(/^dlna:uuid:/i, '').toUpperCase();
    const {host} = speaker;
    if (!/^RINCON_[0-9A-F]{12}\d{5}$/.test(playerId) || !isIPv4(host) ||
        !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host)) {
        return Promise.reject(new Error('Cannot identify the selected local Sonos room.'));
    }
    return new Promise((resolve, reject) => {
        // Sonos uses a locally presented certificate. Limit the exception to the verified LAN room.
        const socket = connect(`wss://${host}:1443/websocket/api`, 'v1.api.smartspeaker.audio', {
            rejectUnauthorized: false, followRedirects: false, handshakeTimeout: commandTimeout, maxPayload: 256 * 1024,
            headers: {'X-Sonos-Api-Key': '123e4567-e89b-12d3-a456-426655440000'}
        });
        const early = new Map();
        let timer, closed, clipId, active, loadAttempted = false;
        let phase = 'connect';
        function finish(error) {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            socket.terminate();
            if (error) {
                if (error.code === 'SONOS_CONNECTION') error.beforePlayback = !loadAttempted;
                reject(error);
            }
            else resolve();
        }
        function deadline(ms, message, makeError = message => new Error(message)) {
            clearTimeout(timer);
            timer = setTimeout(() => finish(makeError(message)), ms);
        }
        function send(command, cmdId, data) {
            try {
                socket.send(JSON.stringify([{namespace, command, cmdId, playerId}, data]), error => {
                    if (error) finish(connectionError(`Could not send Sonos AudioClip ${command}.`));
                });
            } catch (error) {
                finish(connectionError(`Could not send Sonos AudioClip ${command}: ${error.message}`));
            }
        }
        function status(value) {
            if (!active && (value === 'ACTIVE' || value === 'DONE')) {
                active = true;
                onActive();
            }
            if (value === 'DONE') finish();
            else if (['ERROR', 'FAILED', 'DISMISSED', 'INTERRUPTED'].includes(value)) {
                finish(new Error(`Sonos did not complete the announcement (${value.toLowerCase()}).`));
            }
        }
        deadline(commandTimeout, 'Sonos AudioClip connection timed out.', connectionError);
        socket.on('error', () => finish(connectionError('Could not communicate with Sonos AudioClip on port 1443.')));
        socket.on('close', () => finish(connectionError('Sonos closed the AudioClip connection before completion.')));
        socket.once('open', () => {
            if (closed) return;
            phase = 'subscribe';
            deadline(commandTimeout, 'Sonos did not confirm AudioClip status subscription.', connectionError);
            send('subscribe', '1', {});
        });
        socket.on('message', raw => {
            if (closed) return;
            let data;
            try { data = JSON.parse(raw.toString()); }
            catch { return; }
            if (!Array.isArray(data)) return;
            const [header, body] = data;
            if (!header || (header.playerId && header.playerId !== playerId) ||
                (header.namespace && header.namespace !== namespace)) return;
            if (header.type === 'audioClipStatus' || header.name === 'audioClipStatus') {
                if (!['load', 'status'].includes(phase) || !Array.isArray(body?.audioClips)) return;
                for (const clip of body.audioClips) {
                    if (closed) break;
                    if (clipId && clip?.id === clipId) status(clip.status);
                    else if (!clipId && early.size < 64 && typeof clip?.id === 'string') early.set(clip.id, clip.status);
                }
            } else if (phase === 'subscribe' && header.response === 'subscribe' && header.cmdId === '1') {
                if (header.success !== true) return finish(new Error('This Sonos room does not accept AudioClip subscriptions.'));
                phase = 'load';
                deadline(commandTimeout, 'Sonos did not confirm the AudioClip request.', connectionError);
                loadAttempted = true;
                send('loadAudioClip', '2', {
                    name: 'Universal Media Player', appId: 'nl.qluster-it.UniversalMediaPlayer', streamUrl: media.url,
                    ...(volume === undefined ? {} : {volume: Math.round(volume)})
                });
            } else if (phase === 'load' && header.response === 'loadAudioClip' && header.cmdId === '2') {
                if (header.success !== true) return finish(new Error('This Sonos room rejected the AudioClip announcement.'));
                if (typeof body?.id !== 'string' || !body.id) return finish(new Error('Sonos did not return an AudioClip identifier.'));
                phase = 'status';
                clipId = body.id;
                deadline(media.duration + 30000, 'Sonos did not confirm the end of the AudioClip announcement.');
                status(early.get(clipId) ?? body.status);
                early.clear();
            } else if (header.type === 'globalError') {
                finish(new Error('This Sonos room does not support the requested AudioClip operation.'));
            }
        });
    });
}

module.exports = playClip;
