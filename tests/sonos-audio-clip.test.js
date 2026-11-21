'use strict';

const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {test} = require('node:test');
const play = require('../lib/sonos-audio-clip');
const DirectSpeakerSession = require('../lib/direct-speaker-session');
const SpeakerPlayback = require('../lib/speaker-playback');
const room = {protocol: 'sonos', id: 'dlna:uuid:rincon_123456789abc01400', host: '192.168.1.11'};
const media = {url: 'http://nas.local/alert.mp3', duration: 1000};

test('AudioClip subscribes first, correlates early events, and never sends duplicate loads', async () => {
    const socket = new EventEmitter();
    const calls = [];
    socket.send = (text, done) => { calls.push(JSON.parse(text)); done(); };
    socket.terminate = () => {};
    let active = 0;
    const result = play(room, media, 0, () => active++, (url, protocol, options) => {
        assert.equal(url, 'wss://192.168.1.11:1443/websocket/api');
        assert.equal(options.followRedirects, false);
        return socket;
    });
    const emit = (header, body) => socket.emit('message', JSON.stringify([header, body]));
    socket.emit('open');
    const ack = {response: 'subscribe', cmdId: '1', success: true};
    emit(ack);
    emit(ack);
    emit({type: 'audioClipStatus'}, {audioClips: [{id: 'other', status: 'DONE'}, {id: 'ours', status: 'ACTIVE'}]});
    assert.equal(active, 0);
    emit({response: 'loadAudioClip', cmdId: '2', success: true}, {id: 'ours'});
    assert.equal(active, 1);
    emit({type: 'audioClipStatus'}, {audioClips: [{id: 'ours', status: 'DONE'}]});
    await result;
    assert.deepEqual(calls.map(([header]) => header.command), ['subscribe', 'loadAudioClip']);
    assert.equal(calls[1][1].volume, 0);
});

test('Continue resolves on confirmed playback while subsequent jobs wait for DONE', async () => {
    const target = {...room, maxVolume: 25, volumeOffset: 10};
    const calls = [];
    const gates = [];
    const session = new DirectSpeakerSession({
        playback: {select: async (selection, known) => { assert.equal(known, true); return target; }},
        clip: async (speaker, file, volume, active) => {
            calls.push([speaker.id, volume]);
            active();
            await new Promise(resolve => gates.push(resolve));
        }
    });
    assert.equal((await session.playNotification(room, media, {mode: 'selected', volume: 20, completion: 'continue'})).active, true);
    const waited = session.playNotification(room, media, {mode: 'selected'});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [[room.id, 25]]);
    gates.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [[room.id, 25], [room.id, undefined]]);
    gates.shift()();
    assert.equal((await waited).ok, true);
});

test('An AudioClip rejection is reported without falling back to regrouping', async () => {
    const session = new DirectSpeakerSession({
        playback: {select: async () => room},
        clip: async () => { throw new Error('Rejected by speaker'); }
    });
    const result = await session.playNotification(room, media, {mode: 'selected', completion: 'continue'});
    assert.equal(result.ok, false);
    assert.match(result.failures[0].message, /Rejected by speaker/);
    assert.equal(session.journal.units.length, 0);
});

test('AudioClip retries the same queued job only before load dispatch, including a failed retry', async () => {
    for (const failure of ['connect', 'subscribe', 'load', 'retry']) {
        const replacement = {...room, host: '192.168.1.12'};
        const playback = new SpeakerPlayback(() => {});
        playback.selectForControl = async () => room;
        let scans = 0, connections = 0, loads = 0;
        playback.rediscoverSonosEndpoint = async failed => {
            assert.equal(failed.id, room.id);
            scans++;
            return replacement;
        };
        playback.controlConnectionFailed = () => {};
        const session = new DirectSpeakerSession({playback, clip: (target, file, volume, active) =>
            play(target, file, volume, active, () => {
                const socket = new EventEmitter();
                const attempt = ++connections;
                assert.equal(target, attempt === 1 ? room : replacement);
                socket.terminate = () => {};
                const emit = (header, body) => socket.emit('message', JSON.stringify([header, body]));
                socket.send = (text, done) => {
                    const [header, body] = JSON.parse(text);
                    done();
                    if (header.command === 'subscribe') {
                        if (attempt === 1 && failure === 'subscribe') return socket.emit('close');
                        emit({response: 'subscribe', cmdId: '1', success: true});
                        emit({response: 'subscribe', cmdId: '1', success: true});
                    } else {
                        loads++;
                        assert.equal(body.streamUrl, media.url);
                        assert.equal(body.volume, 17);
                        if (failure === 'load') return socket.emit('close');
                        emit({response: 'loadAudioClip', cmdId: '2', success: true}, {id: 'ours', status: 'DONE'});
                    }
                };
                queueMicrotask(() => {
                    if (failure === 'retry' || (attempt === 1 && failure === 'connect')) socket.emit('error', new Error('Offline'));
                    else socket.emit('open');
                });
                return socket;
            })
        });
        const report = await session.playNotification(room, media, {mode: 'selected', volume: 17});
        assert.equal(report.ok, !['load', 'retry'].includes(failure), failure);
        assert.equal(scans, failure === 'load' ? 0 : 1);
        assert.equal(connections, failure === 'load' ? 1 : 2);
        assert.equal(loads, failure === 'retry' ? 0 : 1);
        assert.equal(session.journal.units.length, 0);
    }
});

test('AudioClip timeouts distinguish subscription from attempted load', async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    for (const load of [false, true]) {
        const socket = new EventEmitter();
        socket.send = (_, done) => done();
        socket.terminate = () => {};
        const result = play(room, media, undefined, () => {}, () => socket);
        socket.emit('open');
        if (load) socket.emit('message', JSON.stringify([{response: 'subscribe', cmdId: '1', success: true}]));
        const check = assert.rejects(result, error => error.code === 'SONOS_CONNECTION' && error.beforePlayback === !load);
        t.mock.timers.tick(6000);
        await check;
    }
});
