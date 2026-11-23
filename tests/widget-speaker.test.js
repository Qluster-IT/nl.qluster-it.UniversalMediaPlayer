'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const {EventEmitter} = require('node:events');
const {test} = require('node:test');
const speaker = require('../lib/widget-speaker');
const widget = require('../widgets/media/api');
const {createReader} = require('../lib/samsung-tv-info');

const AV = 'urn:schemas-upnp-org:service:AVTransport:1';
const ID = name => `dlna:uuid:rincon_${name}`;
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

test('Samsung TV information is read without pairing and shared until it expires', async () => {
    let time = 0;
    let calls = 0;
    let power = 'on';
    const room = {protocol: 'dlna', kind: 'tv', samsung: true, host: '192.168.1.60', model: 'QE55QN85BATXXN'};
    const read = createReader(async (url, options) => {
        calls++;
        assert.equal(url, 'http://192.168.1.60:8001/api/v2/');
        assert.equal(options.method ?? 'GET', 'GET');
        assert.equal(options.redirect, 'error');
        return {ok: true, json: async () => ({type: 'Samsung SmartTV', device: {
            modelName: room.model, OS: 'Tizen', resolution: '3840x2160', PowerState: power,
            firmwareVersion: 'Unknown', networkType: 'wired', FrameTVSupport: 'false',
            VoiceSupport: 'true', GamePadSupport: true, wifiMac: 'not-for-the-widget'
        }})};
    }, () => time);
    const [first, second] = await Promise.all([read(room), read(room)]);
    assert.deepEqual(first, {model: room.model, os: 'Tizen', resolution: '3840 \u00d7 2160',
        power: 'on', network: 'wired', firmware: null, frame: false, voice: true, gamepad: true});
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
    power = 'standby';
    time += 15001;
    assert.equal((await read(room)).power, 'standby');
    assert.equal(calls, 2);
});

test('Samsung TV info rejects unrelated endpoints and backs off without inferring power', async () => {
    let calls = 0;
    const logs = [];
    const read = createReader(async () => {
        calls++;
        return {ok: true, json: async () => ({type: 'Samsung SmartTV', device: {modelName: 'Another TV'}})};
    });
    const room = {protocol: 'dlna', kind: 'tv', samsung: true, host: '192.168.1.60', model: 'QE55QN85BATXXN'};
    assert.equal(read({...room, host: 'example.com'}), null);
    assert.equal(read({...room, samsung: false}), null);
    assert.equal(await read(room, (...args) => logs.push(args)), null);
    assert.equal(await read(room), null);
    assert.equal(calls, 1);
    assert.match(logs[0][1], /does not match/);
});

test('Sonos controller follows existing groups, reads native queue and only edits eligible rooms', async t => {
    let patio = false;
    let queueRevision = '7';
    const queueUri = 'x-rincon-queue:RINCON_LIVING#0';
    let currentUri = queueUri;
    let trackUri = 'http://example.test/track';
    const calls = [];
    const member = name => `<ZoneGroupMember UUID="RINCON_${name.toUpperCase()}"/>`;
    const group = (name, members) =>
        `<ZoneGroup Coordinator="RINCON_${name.toUpperCase()}">${members.map(member).join('')}</ZoneGroup>`;
    const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const action = req.headers.soapaction.split('#')[1].slice(0, -1);
        calls.push({path: req.url, action, body});
        let fields = {};
        switch (action) {
            case 'GetZoneGroupState':
                fields.ZoneGroupState = `<ZoneGroups>${group('living', ['living', 'kitchen', ...(patio ? ['patio'] : [])])}` +
                    `${patio ? '' : group('patio', ['patio'])}${group('office', ['office', 'study'])}</ZoneGroups>`;
                break;
            case 'GetMediaInfo': fields = {CurrentURI: currentUri, NrTracks: '2',
                CurrentURIMetaData: '<DIDL-Lite><item><title>Source name</title><albumArtURI>/cover.png</albumArtURI></item></DIDL-Lite>'}; break;
            case 'GetZoneInfo': fields.HTAudioIn = '84934713'; break;
            case 'GetTransportInfo': fields.CurrentTransportState = 'PLAYING'; break;
            case 'GetPositionInfo':
                fields = {TrackURI: trackUri, Track: '2', TrackDuration: '00:03:00', RelTime: '00:00:12',
                    TrackMetaData: '<DIDL-Lite><item><title>Track Two</title><artist>Artist</artist></item></DIDL-Lite>'};
                break;
            case 'GetCurrentTransportActions': fields.Actions = 'Play,Pause,Seek,Next'; break;
            case 'GetTransportSettings': fields.PlayMode = 'SHUFFLE'; break;
            case 'GetVolume': fields.CurrentVolume = '22'; break;
            case 'GetMute': fields.CurrentMute = '0'; break;
            case 'SetAVTransportURI': patio = true; break;
            case 'BecomeCoordinatorOfStandaloneGroup': patio = false; break;
            case 'Browse':
                fields = {TotalMatches: '2', UpdateID: queueRevision,
                    Result: `<DIDL-Lite><item id="Q:0/2"><title>Track Two</title></item></DIDL-Lite>`};
                break;
        }
        res.end(`<s:Envelope xmlns:s="urn:soap"><s:Body><${action}Response>` +
            Object.entries(fields).map(([key, value]) => `<${key}>${escape(value)}</${key}>`).join('') +
            `</${action}Response></s:Body></s:Envelope>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const rooms = ['living', 'kitchen', 'patio', 'office', 'study'].map(name => ({
        id: ID(name), name, protocol: 'sonos', endpoint: `${base}/${name}/transport`, service: AV,
        topology: `${base}/topology`, rendering: {endpoint: `${base}/${name}/volume`, service: AV},
        directory: {endpoint: `${base}/${name}/directory`, service: 'urn:schemas-upnp-org:service:ContentDirectory:1'},
        properties: {endpoint: `${base}/${name}/properties`, service: 'urn:schemas-upnp-org:service:DeviceProperties:1'}
    }));
    const homey = {__: key => key, app: {speakerUpdates: new EventEmitter(), speakerPlayback: {
        selectForControl: async ({id}) => rooms.find(room => room.id === id),
        listSpeakers: async () => rooms.map(({id, name}) => ({id, name}))
    }}};
    const kitchen = ID('kitchen');
    const changed = () => homey.app.speakerUpdates.emit('speaker', kitchen);
    const state = await speaker.state(homey, kitchen);
    assert.deepEqual([state.name, state.coordinator, state.track, state.position, state.trackNumber, state.volume],
        ['kitchen', 'living', 'Track Two', 12000, 2, 0.22]);
    assert(calls.some(call => call.path === '/kitchen/volume'));
    assert(calls.some(call => call.path === '/living/transport'));
    assert(calls.every(call => call.action.startsWith('Get')));
    assert.equal(state.artwork, `${base}/cover.png`);
    assert(!calls.some(call => call.action === 'GetZoneInfo'));

    // A Playback Device and open widgets reuse one fresh read until the speaker reports a change.
    const reads = calls.length;
    assert.equal(await speaker.state(homey, kitchen), state);
    assert.equal(calls.length, reads);
    changed();
    homey.app.speakerArtwork = {host: async () => { throw new Error('Artwork service unavailable'); }};
    assert.equal((await speaker.state(homey, kitchen)).artwork, `${base}/cover.png`);
    assert(calls.length > reads);
    delete homey.app.speakerArtwork;

    currentUri = 'x-sonos-htastream:RINCON_LIVING:spdif';
    changed();
    const tv = await speaker.state(homey, kitchen);
    assert.equal(tv.activeInput, 'tv');
    assert.equal(tv.audioFormat, 'Dolby Digital 5.1');
    assert(calls.some(call => call.path === '/living/properties' && call.action === 'GetZoneInfo' &&
        !call.body.includes('InstanceID')));
    assert.equal(tv.track, undefined);
    assert.equal(tv.trackNumber, null);
    assert.equal(tv.duration, 0);
    assert.equal(tv.actions.seek, false);
    assert.equal(tv.volume, 0.22);
    assert.equal((await speaker.playlist(homey, kitchen, 'current', 1)).unavailable, true);

    currentUri = '';
    trackUri = 'x-rincon-stream:RINCON_LIVING';
    changed();
    assert.equal((await speaker.state(homey, kitchen)).activeInput, 'lineIn');

    // The active queue URI takes precedence over stale track information.
    currentUri = queueUri;
    changed();
    const music = await speaker.state(homey, kitchen);
    assert.equal(music.activeInput, null);
    assert.equal(music.track, 'Track Two');
    trackUri = 'http://example.test/track';

    const queue = await speaker.playlist(homey, kitchen, 'current', 1);
    assert.equal(queue.offset, 1);
    assert.equal(queue.items[0].name, 'Track Two');
    assert(queue.items[0].current);
    assert(calls.some(call => call.path === '/living/directory' && call.body.includes('<StartingIndex>1</StartingIndex>')));
    const control = (action, rest = {}) => speaker.control(homey, {action, speaker: kitchen, ...rest});
    queueRevision = '8';
    await assert.rejects(control('playQueueItem', {number: 2, item: queue.items[0].id}), /invalidAction/);
    assert(!calls.some(call => call.action === 'Seek'));

    const {rooms: initial} = await control('listRooms');
    assert(initial.find(room => room.id === ID('living')).coordinator);
    assert.equal(initial.find(room => room.id === ID('study')).otherGroup, 'office');
    await assert.rejects(control('joinRoom', {value: ID('study')}), /invalidAction/);
    assert(!calls.some(call => call.action === 'SetAVTransportURI'));
    const stored = {announcement_speaker: {id: kitchen}};
    const player = {getData: () => ({id: 'ump'}), getAvailable: () => true,
        getStoreValue: key => stored[key], playlistManager: {}};
    homey.drivers = {getDriver: () => ({getDevices: () => [player]})};
    homey.app.error = () => {};
    const destination = (action, rest = {}) => widget.control({homey, body: {player: 'ump', target: kitchen, action, ...rest}});
    assert.equal((await destination('listRooms')).roomCount, 2);
    stored.ump_current_speaker = {id: ID('office')};
    await assert.rejects(destination('joinRoom', {value: ID('patio')}), /invalidAction/);
    assert(!calls.some(call => call.action === 'SetAVTransportURI'));
    assert.equal((await destination('listRooms', {target: ID('office')})).rooms.find(room =>
        room.id === ID('office')).coordinator, true);
    delete stored.ump_current_speaker;
    const joined = await destination('joinRoom', {value: ID('patio')});
    assert.equal(joined.roomCount, 3);
    assert(joined.rooms.find(room => room.id === ID('patio')).joined);
    assert(calls.some(call => call.action === 'SetAVTransportURI' && call.path === '/patio/transport' &&
        call.body.includes('x-rincon:RINCON_LIVING')));
    const left = await destination('leaveRoom', {value: ID('patio')});
    assert(!left.rooms.find(room => room.id === ID('patio')).joined);
    assert.deepEqual(stored, {announcement_speaker: {id: kitchen}});
    await assert.rejects(control('leaveRoom', {value: ID('living')}), /invalidAction/);
});

test('a standard DLNA renderer never substitutes a UMP queue', async t => {
    const server = http.createServer((req, res) => {
        const action = req.headers.soapaction.split('#')[1].slice(0, -1);
        const readers = {
            GetMediaInfo: '<CurrentURI>http://example.test/radio</CurrentURI>',
            GetTransportInfo: '<CurrentTransportState>PLAYING</CurrentTransportState>',
            GetPositionInfo: '<TrackURI>http://example.test/radio</TrackURI>'
        };
        assert(Object.hasOwn(readers, action));
        req.resume();
        res.end(`<Envelope><Body><${action}Response>${readers[action]}</${action}Response></Body></Envelope>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const room = {id: 'dlna:uuid:renderer', protocol: 'dlna', service: AV, endpoint: `http://127.0.0.1:${server.address().port}`};
    const homey = {__: key => key, app: {speakerPlayback: {selectForControl: async () => room}}};
    assert.deepEqual(await speaker.playlist(homey, room.id, 0, 10), {items: [], offset: 0, next: null, unavailable: true});
    const player = {getData: () => ({id: 'ump'}), getAvailable: () => true,
        getStoreValue: key => key === 'announcement_speaker' ? {id: room.id} : null, playlistManager: {}};
    homey.drivers = {getDriver: () => ({getDevices: () => [player]})};
    assert.deepEqual(await widget.control({homey, body: {player: 'ump', target: room.id, action: 'listRooms'}}),
        {supported: false});
});

test('TV mute rejection disables the unsupported control without losing playback state', async t => {
    let active = false;
    let muted = false;
    const server = http.createServer((req, res) => {
        const action = req.headers.soapaction.split('#')[1].slice(0, -1);
        req.resume();
        if (action === 'SetMute' && !active) {
            return res.writeHead(500).end('<Envelope><Body><Fault><detail><UPnPError><errorCode>501</errorCode></UPnPError></detail></Fault></Body></Envelope>');
        }
        if (action === 'SetMute') muted = true;
        const fields = {
            GetMediaInfo: `<CurrentURI>${active ? 'http://example.test/track' : ''}</CurrentURI>`,
            GetTransportInfo: `<CurrentTransportState>${active ? 'PLAYING' : 'NO_MEDIA_PRESENT'}</CurrentTransportState>`,
            GetMute: `<CurrentMute>${Number(muted)}</CurrentMute>`, GetVolume: '<CurrentVolume>0</CurrentVolume>'
        };
        res.end(`<Envelope><Body><${action}Response>${fields[action] ?? ''}</${action}Response></Body></Envelope>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const room = {id: 'dlna:uuid:tv', name: 'TV', kind: 'tv', protocol: 'dlna', service: AV, endpoint,
        rendering: {endpoint, service: 'urn:schemas-upnp-org:service:RenderingControl:1'}};
    const homey = {__: key => key, app: {speakerPlayback: {selectForControl: async () => room}}};
    const mute = () => speaker.control(homey, {action: 'mute', speaker: room.id, value: true});
    assert.equal((await speaker.state(homey, room.id)).actions.mute, true);
    const rejection = (await mute()).player;
    assert.equal(rejection.controlRejected, true);
    assert.equal(rejection.muted, false);
    assert.equal((await speaker.state(homey, room.id)).actions.mute, false);
    active = true;
    assert.equal((await mute()).player.muted, true);
});

test('Cast speaker mode reads an existing app and disconnects without launching or stopping it', async t => {
        const api = require('castv2-client');
        const packets = [];
        const status = {playerState: 'PLAYING', currentTime: 9, mediaSessionId: 3, currentItemId: 2,
            supportedMediaCommands: 67, media: {contentId: 'track', duration: 123, metadata: {title: 'Cast track'}},
            items: [{itemId: 2, media: {metadata: {title: 'Cast track'}}}, {itemId: 4, media: {metadata: {title: 'Next track'}}}]};
        class Client extends EventEmitter {
            constructor() { super(); this.client = {socket: {}, createChannel: this.createChannel.bind(this)}; this.channels = []; }
            connect(_, callback) { callback(null); }
            getStatus(callback) { callback(null, {applications: [{appId: 'CUSTOM', transportId: 'session', sessionId: 'app'}]}); }
            getVolume(callback) { callback(null, {level: 0.4, muted: false}); }
            join(session, Receiver, callback) { callback(null, new Receiver(this.client, session)); }
            createChannel(_, __, namespace) {
                const channel = new EventEmitter();
                channel.send = data => {
                    if (!namespace.endsWith('.media')) return;
                    packets.push(data.type);
                    channel.emit('message', {type: 'MEDIA_STATUS', requestId: data.requestId, status: [status]}, false);
                };
                this.channels.push(channel);
                return channel;
            }
            close() { for (const channel of this.channels) channel.emit('close'); }
        }
        const originalClient = api.Client;
        api.Client = Client;
        t.after(() => { api.Client = originalClient; });
        const target = {id: 'cast:group', name: 'Cast group', protocol: 'cast'};
        const homey = {__: key => key, app: {speakerPlayback: {selectForControl: async () => target}}};
        const state = await speaker.state(homey, target.id);
        assert.deepEqual([state.track, state.position, state.trackNumber, state.volume], ['Cast track', 9000, 1, 0.4]);
        const page = await speaker.playlist(homey, target.id, 0, 10);
        assert.deepEqual(page.items.map(row => row.name), ['Cast track', 'Next track']);
        assert.deepEqual(packets, ['GET_STATUS', 'GET_STATUS']);
        await speaker.control(homey, {speaker: target.id, action: 'next'});
        assert.deepEqual(packets.filter(type => type !== 'GET_STATUS'), ['QUEUE_UPDATE']);
});

test('UMP playback through a Sonos group lets its own widget add and remove rooms', async t => {
    const DirectSpeakerSession = require('../lib/direct-speaker-session');
    const {topology, roomGroup, abandonOwnership, isOwned} = DirectSpeakerSession.controller;
    let patio = false;
    const calls = [];
    const member = name => `<ZoneGroupMember UUID="RINCON_${name.toUpperCase()}"/>`;
    const group = (name, members) =>
        `<ZoneGroup Coordinator="RINCON_${name.toUpperCase()}">${members.map(member).join('')}</ZoneGroup>`;
    const server = http.createServer(async (req, res) => {
        for await (const _chunk of req);
        const action = req.headers.soapaction.split('#')[1].slice(0, -1);
        calls.push({path: req.url, action});
        const fields = {};
        if (action === 'GetZoneGroupState') {
            fields.ZoneGroupState = `<ZoneGroups>${group('living', ['living', 'kitchen', ...(patio ? ['patio'] : [])])}` +
                `${patio ? '' : group('patio', ['patio'])}</ZoneGroups>`;
        } else if (action === 'GetVolume') fields.CurrentVolume = '20';
        else if (action === 'SetAVTransportURI') patio = true;
        else if (action === 'BecomeCoordinatorOfStandaloneGroup') patio = false;
        res.end(`<s:Envelope xmlns:s="urn:soap"><s:Body><${action}Response>` +
            Object.entries(fields).map(([key, value]) => `<${key}>${escape(value)}</${key}>`).join('') +
            `</${action}Response></s:Body></s:Envelope>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const rooms = ['living', 'kitchen', 'patio'].map(name => ({
        id: ID(name), name, protocol: 'sonos', endpoint: `${base}/${name}/transport`, service: AV,
        topology: `${base}/topology`, rendering: {endpoint: `${base}/${name}/volume`, service: AV}
    }));
    const homey = {__: key => key, app: {speakerUpdates: new EventEmitter(), speakerPlayback: {
        selectForControl: async ({id}) => rooms.find(room => room.id === id),
        listSpeakers: async () => rooms.map(({id, name}) => ({id, name}))
    }}};
    const [living, kitchen] = rooms;
    const playing = {uri: 'http://nas.test/song.mp3', state: 'PLAYING'};
    const store = {directSpeakerSessionV1: {version: 1, selection: kitchen.id, units: [{
        target: living, original: playing, expected: playing, group: roomGroup(await topology(living), living),
        rooms: [living, kitchen], joins: [], volumes: [], loaded: true, levelRoom: kitchen.id
    }]}};
    const device = {getData: () => ({id: 'ump'}), getStoreValue: key => store[key],
        setStoreValue: async (key, value) => { store[key] = value; }};
    const session = new DirectSpeakerSession({playback: homey.app.speakerPlayback, device});
    t.after(() => abandonOwnership('ump'));
    await session.status();
    const body = (action, value) => ({speaker: kitchen.id, action, value});
    // Another playback, or a widget without the session, may not regroup the playing rooms.
    await assert.rejects(speaker.control(homey, body('joinRoom', ID('patio'))), /invalidAction/);
    const locked = await speaker.control(homey, {speaker: kitchen.id, action: 'listRooms'});
    assert(!locked.rooms.find(room => room.id === ID('patio')).editable);
    const listed = await speaker.control(homey, {speaker: kitchen.id, action: 'listRooms'}, true, 'ump');
    assert.equal(listed.locked, false);
    assert(listed.rooms.find(room => room.id === ID('patio')).editable);

    const joined = await speaker.regroup(homey, body('joinRoom', ID('patio')), session);
    assert(joined.rooms.find(room => room.id === ID('patio')).joined);
    assert.equal(joined.roomCount, 3);
    const unit = store.directSpeakerSessionV1.units[0];
    assert.deepEqual(unit.rooms.map(room => room.name), ['living', 'kitchen', 'patio']);
    assert.equal(unit.group.members.length, 3);
    assert(isOwned(rooms[2]));
    assert(calls.filter(call => call.path.startsWith('/living/')).every(call => call.action.startsWith('Get')));

    // The session now expects the new membership, so the next change passes its topology check.
    const left = await speaker.regroup(homey, body('leaveRoom', ID('patio')), session);
    assert(!left.rooms.find(room => room.id === ID('patio')).joined);
    assert.deepEqual(store.directSpeakerSessionV1.units[0].rooms.map(room => room.name), ['living', 'kitchen']);
    assert(!isOwned(rooms[2]));
    await assert.rejects(speaker.regroup(homey, body('leaveRoom', ID('living')), session), /invalidAction/);
});


test('Sonos soundbar inputs are listed, switched to TV and locked during UMP playback', async t => {
    const DirectSpeakerSession = require('../lib/direct-speaker-session');
    const {abandonOwnership} = DirectSpeakerSession.controller;
    let currentUri = 'x-rincon-queue:RINCON_TVBAR#0';
    const calls = [];
    const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const action = req.headers.soapaction.split('#')[1].slice(0, -1);
        calls.push({path: req.url, action, body});
        const fields = {};
        if (action === 'GetZoneGroupState') {
            fields.ZoneGroupState = '<ZoneGroups><ZoneGroup Coordinator="RINCON_TVBAR"><ZoneGroupMember UUID="RINCON_TVBAR"/></ZoneGroup></ZoneGroups>';
        } else if (action === 'GetMediaInfo') Object.assign(fields, {CurrentURI: currentUri, NrTracks: '0'});
        else if (action === 'GetTransportInfo') fields.CurrentTransportState = 'STOPPED';
        else if (action === 'GetPositionInfo') fields.TrackURI = '';
        else if (action === 'SetAVTransportURI') currentUri = /<CurrentURI>([^<]*)</.exec(body)[1];
        res.end(`<s:Envelope xmlns:s="urn:soap"><s:Body><${action}Response>` +
            Object.entries(fields).map(([key, value]) => `<${key}>${escape(value)}</${key}>`).join('') +
            `</${action}Response></s:Body></s:Envelope>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tvbar = {id: ID('tvbar'), name: 'TV Bar', protocol: 'sonos', kind: 'tvSpeaker', model: 'Sonos Beam',
        endpoint: `${base}/tvbar/transport`, service: AV, topology: `${base}/topology`};
    const homey = {__: key => key, drivers: {getDriver: () => ({getDevices: () => []})},
        app: {speakerUpdates: new EventEmitter(), speakerPlayback: {selectForControl: async () => tvbar}}};
    const control = (action, value) => widget.control({homey, body: {speaker: tvbar.id, action, value}});

    const listed = await control('deviceControls');
    assert.deepEqual(listed.inputs.map(item => item.id), ['tv', 'queue']);
    assert.equal(listed.input, 'queue');
    assert.equal(listed.power, null);
    await assert.rejects(control('setInput', 'line_in'), /invalidAction/);
    assert(!calls.some(call => call.action === 'SetAVTransportURI'));

    const switched = await control('setInput', 'tv');
    assert.equal(switched.input, 'tv');
    const write = calls.find(call => call.action === 'SetAVTransportURI');
    assert.equal(write.path, '/tvbar/transport');
    assert.match(write.body, /<CurrentURI>x-sonos-htastream:RINCON_TVBAR:spdif<\/CurrentURI>/);
    // An empty Sonos queue is selected without trying to play it.
    await control('setInput', 'queue');
    assert(!calls.some(call => call.action === 'Play'));

    const playing = {uri: 'http://nas.test/song.mp3', state: 'PLAYING'};
    const store = {directSpeakerSessionV1: {version: 1, selection: tvbar.id, units: [{target: tvbar, original: playing,
        expected: playing, rooms: [tvbar], joins: [], volumes: [], loaded: true}]}};
    const session = new DirectSpeakerSession({playback: homey.app.speakerPlayback, device: {getData: () => ({id: 'other-ump'}),
        getStoreValue: key => store[key], setStoreValue: async (key, value) => { store[key] = value; }}});
    t.after(() => abandonOwnership('other-ump'));
    await session.status();
    assert.equal((await control('deviceControls')).locked, true);
    const writes = calls.filter(call => call.action === 'SetAVTransportURI').length;
    await assert.rejects(control('setInput', 'tv'), /invalidAction/);
    const ownerDevice = {getData: () => ({id: 'other-ump'}), getAvailable: () => true, playlistManager: {},
        getStoreValue: key => key === 'widgetPlaybackController' ? {widget: 'owner-widget'} : store[key]};
    homey.drivers.getDriver = name => ({getDevices: () => name === 'upnpplayer' ? [ownerDevice] : []});
    const fromWidget = (widgetId, action, value) => widget.control({homey, body: {speaker: tvbar.id, widget: widgetId, action, value}});
    assert.equal((await fromWidget('other-widget', 'deviceControls')).locked, true);
    await assert.rejects(fromWidget('other-widget', 'setInput', 'tv'), /invalidAction/);
    assert.equal((await fromWidget('owner-widget', 'deviceControls')).locked, false);
    assert.equal((await fromWidget('owner-widget', 'setInput', 'tv')).input, 'tv');
    assert.equal(calls.filter(call => call.action === 'SetAVTransportURI').length, writes + 1);
});