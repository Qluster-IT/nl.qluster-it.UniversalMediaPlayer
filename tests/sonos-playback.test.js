'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {readPlayback, syncPlayback} = require('../lib/sonos-playback');
const {Defer} = require('../lib/proto');

const envelope = (action, body) => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">${body}</u:${action}Response></s:Body></s:Envelope>`;

test('Sonos feedback reads the real URI and transport state without sending control commands', async () => {
    const calls = [];
    const state = await readPlayback('192.168.1.177', async (url, opts) => {
        calls.push(opts.headers.SOAPACTION);
        assert.equal(url, 'http://192.168.1.177:1400/MediaRenderer/AVTransport/Control');
        assert.equal(opts.redirect, 'error');
        const action = opts.headers.SOAPACTION.includes('GetPositionInfo') ? 'GetPositionInfo' : 'GetTransportInfo';
        return {ok: true, text: async () => envelope(action, action === 'GetPositionInfo'
            ? '<TrackURI>http://server/track.mp3?a=1&amp;b=2</TrackURI>'
            : '<CurrentTransportState>PAUSED_PLAYBACK</CurrentTransportState>')};
    });
    assert.deepEqual(state, {url: 'http://server/track.mp3?a=1&b=2', state: 'PAUSED_PLAYBACK'});
    assert.equal(calls.length, 2);
    assert(calls.every(call => /#Get(Position|Transport)Info/.test(call)));
});

test('grouped Sonos playback resolves a local coordinator and refuses coordinator loops', async () => {
    let loop = false;
    const request = async (url, opts) => {
        const action = opts.headers.SOAPACTION.match(/#(\w+)/)[1];
        const body = action === 'GetZoneGroupState'
            ? '<ZoneGroupState>&lt;ZoneGroups&gt;&lt;ZoneGroup&gt;&lt;ZoneGroupMember UUID="coordinator" Location="http://192.168.1.155:1400/xml/device_description.xml"/&gt;&lt;/ZoneGroup&gt;&lt;/ZoneGroups&gt;</ZoneGroupState>'
            : action === 'GetTransportInfo'
                ? '<CurrentTransportState>PLAYING</CurrentTransportState>'
                : `<TrackURI>${url.includes('.177:') || loop ? 'x-rincon:coordinator' : 'x-rincon-mp3radio://http://server/track.mp3'}</TrackURI>`;
        return {ok: true, text: async () => envelope(action, body)};
    };
    assert.deepEqual(await readPlayback('192.168.1.177', request), {url: 'http://server/track.mp3', state: 'PLAYING'});
    loop = true;
    await assert.rejects(readPlayback('192.168.1.177', request), /coordinator/);
});

test('Sonos restored radio streams expose the original URL without matching other tracks', async () => {
    for (const uri of [
        'x-rincon-mp3radio://http://server/track.mp3?a=1&b=2',
        'x-rincon-mp3radio://https://server/announcement.mp3',
        'x-rincon-mp3radio://unsupported:stream'
    ]) {
        const snapshot = await readPlayback('192.168.1.177', async (_, opts) => {
            const action = opts.headers.SOAPACTION.match(/#(\w+)/)[1];
            return {ok: true, text: async () => envelope(action, action === 'GetPositionInfo'
                ? `<TrackURI>${uri.replaceAll('&', '&amp;')}</TrackURI>`
                : '<CurrentTransportState>PLAYING</CurrentTransportState>')};
        });
        assert.deepEqual(snapshot, {
            url: uri.includes('://http') ? uri.slice('x-rincon-mp3radio://'.length) : uri,
            state: 'PLAYING'
        });
    }
});

test('Sonos read failures are explicit and invalid addresses never make a request', async () => {
    for (const address of ['example.com', '127.0.0.1', '8.8.8.8', '192.168.1.177:1400']) {
        await assert.rejects(readPlayback(address, () => assert.fail('Unexpected request')), /IPv4/);
    }
    await assert.rejects(readPlayback('192.168.1.177', async () => ({ok: false, status: 500})), /500/);
    await assert.rejects(readPlayback('192.168.1.177', async () => ({
        ok: true, text: async () => '<invalid/>'
    })), /Invalid Sonos/);
});

test('stale or in-flight speaker feedback cannot suspend a newer playback operation', async () => {
    const received = [];
    const player = {
        playlistManager: {playbackRevision: 1, ReportSpeakerPlayback: async value => received.push(value)},
        error: () => assert.fail('Unexpected error')
    };
    const first = new Defer();
    const pending = syncPlayback(player, '192.168.1.177', () => first.promise);
    await syncPlayback(player, '192.168.1.177', async () => ({url: 'new', state: 'PLAYING'}));
    first.resolve({url: 'old', state: 'STOPPED'});
    await pending;
    assert.deepEqual(received, [{url: 'new', state: 'PLAYING'}]);
    received.length = 0;
    await syncPlayback(player, '192.168.1.177', async () => {
        player.playlistManager.playbackRevision++;
        return {url: 'old', state: 'STOPPED'};
    });

    player.playlistManager.playbackPending = 2;
    await syncPlayback(player, '192.168.1.177', async () => ({url: 'old', state: 'STOPPED'}));
    assert.deepEqual(received, []);
});

test('Sonos feedback failures are logged and surfaced without changing playback', async () => {
    const errors = [];
    const player = {
        homey: {__: key => key},
        error: (...args) => errors.push(args),
        playlistManager: {playbackRevision: 1, ReportSpeakerPlayback: () => assert.fail('Unexpected state update')}
    };
    await assert.rejects(syncPlayback(player, '192.168.1.177', async () => {throw new Error('Connection refused');}),
        /playback.sonosSyncFailed/);
    assert.equal(errors.length, 1);
    assert.match(errors[0][1].message, /Connection refused/);
});
