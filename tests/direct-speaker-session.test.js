'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {parseStringPromise, processors} = require('xml2js');
const DirectSpeakerSession = require('../lib/direct-speaker-session');
const widgetSpeaker = require('../lib/widget-speaker');
const mediaWidget = require('../lib/media-widget');
const SpeakerPlayback = require('../lib/speaker-playback');
const PlaylistManager = require('../lib/playlistmanager');
const widgetPlayback = require('../lib/widget-playback');
const {DEFAULT_TARGET} = require('../drivers/upnpplayer/playback-target');

const type = name => `urn:schemas-upnp-org:service:${name}:1`;
const encode = value => String(value).replace(/[&<>"]/g, char =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[char]);
const tags = values => Object.entries(values).map(([key, value]) => `<${key}>${encode(value)}</${key}>`).join('');
const queue = 'x-rincon-queue:RINCON_A#0';
const old = 'https://radio.lan/stream?first=1&second=2';
const announcement = 'http://homey.lan:47333/tts/1c4cf09b-519d-4c1a-9717-283ba851914c.mp3';
const file = (index, duration = 180000) => ({
    url: `http://music.lan/file?track=${index}&token=yes`, name: 'A & B', duration, contentType: 'audio/flac'
});

function room(id, options = {}) {
    return {id: `RINCON_${id}`, leader: `RINCON_${id}`, uri: old, track: old, state: 'PLAYING',
        metadata: '<DIDL-Lite>Original &amp; preserved</DIDL-Lite>', time: '0:01:14', number: '3', volume: 39, mute: 0,
        ...options};
}

async function setup(t, rooms) {
    const calls = [];
    const renderTopology = () => '<ZoneGroupState><ZoneGroups>' +
        rooms.filter(item => item.leader === item.id).map(leader =>
            `<ZoneGroup Coordinator="${leader.id}">` + rooms.filter(item => item.leader === leader.id).map(item =>
                `<ZoneGroupMember UUID="${item.id}"${item.bond ? ` ChannelMapSet="${item.bond}"` : ''}>` +
                (item.bonded ? `<Satellite UUID="${item.bonded}"/>` : '') + '</ZoneGroupMember>').join('') +
            '</ZoneGroup>').join('') + '</ZoneGroups></ZoneGroupState>';
    const server = http.createServer(async (req, res) => {
        try {
            if (req.method === 'GET' && req.url.endsWith('/range')) {
                return res.end('<scpd><serviceStateTable><stateVariable><name>Volume</name><allowedValueRange>' +
                    '<minimum>0</minimum><maximum>100</maximum><step>1</step>' +
                    '</allowedValueRange></stateVariable></serviceStateTable></scpd>');
            }
            const target = rooms.find(item => req.url.startsWith(`/${item.id}/`));
            const action = req.headers.soapaction.match(/#(\w+)/)[1];
            let body = '';
            for await (const chunk of req) body += chunk;
            const parsed = await parseStringPromise(body, {explicitArray: false, tagNameProcessors: [processors.stripPrefix]});
            const args = parsed.Envelope.Body[action];
            if (target.failRead === action) {
                delete target.failRead;
                return req.socket.destroy();
            }
            if (!action.startsWith('Get')) calls.push({target: target.id, action, args});
            let values = {}, fault;
            if (target.unsupported?.includes(action)) fault = 401;
            else switch (action) {
                case 'GetZoneGroupState':
                    values = {ZoneGroupState: renderTopology()};
                    break;
                case 'GetMediaInfo':
                    values = {CurrentURI: target.uri, CurrentURIMetaData: target.metadata, NextURI: target.next ?? ''};
                    if (target.trackUriOnly) delete values.CurrentURI;
                    break;
                case 'GetPositionInfo':
                    values = {TrackURI: target.track, RelTime: target.time, Track: target.number,
                        TrackDuration: target.trackDuration ?? '0:00:00'};
                    break;
                case 'GetTransportInfo':
                    values = {CurrentTransportState: target.state};
                    break;
                case 'GetVolume': values = {CurrentVolume: target.volume}; break;
                case 'GetMute': values = {CurrentMute: target.mute}; break;
                case 'SetVolume':
                    target.volume = Number(args.DesiredVolume);
                    if (target.lostVolume) { delete target.lostVolume; return req.socket.destroy(); }
                    break;
                case 'GetGroupVolume': values = {CurrentVolume: target.groupVolume}; break;
                case 'SnapshotGroupVolume': break;
                case 'SetGroupVolume': target.groupVolume = Number(args.DesiredVolume); break;
                case 'SetMute': target.mute = Number(args.DesiredMute); break;
                case 'SetAVTransportURI':
                    target.uri = args.CurrentURI;
                    target.track = target.uri;
                    target.metadata = args.CurrentURIMetaData;
                    target.state = 'STOPPED';
                    target.time = '0:00:00';
                    target.number = '1';
                    if (target.uri.startsWith('x-rincon:')) target.leader = target.uri.split(':')[1];
                    if (target.lostJoin && target.uri.startsWith('x-rincon:')) return req.socket.destroy();
                    break;
                case 'SetNextAVTransportURI': target.next = args.NextURI; break;
                case 'Browse':
                    values = {UpdateID: target.revision, TotalMatches: target.items.length};
                    break;
                case 'RemoveAllTracks':
                case 'AddURI':
                    assert.equal(Number(args.UpdateID), target.revision);
                    if (action === 'RemoveAllTracks') target.items = [];
                    else target.items.push(args.EnqueuedURI);
                    values = {NewUpdateID: ++target.revision, FirstTrackNumberEnqueued: target.items.length,
                        NewQueueLength: target.items.length};
                    break;
                case 'SetPlayMode': target.playMode = args.NewPlayMode; break;
                case 'Play':
                    target.state = target.reconnectUri === target.uri ? 'TRANSITIONING' : 'PLAYING';
                    if (target.deferQueueTrack && target.uri.startsWith('x-rincon-queue:')) {
                        target.track = target.items[Number(target.number) - 1];
                    }
                    break;
                case 'Pause': target.state = 'PAUSED_PLAYBACK'; break;
                case 'Stop':
                    target.state = target.windowsStop ? 'PAUSED_PLAYBACK' : 'STOPPED';
                    if (target.windowsStop) target.time = '0:00:00';
                    if (target.stopQueueReset) { target.number = '1'; target.track = target.items[0]; }
                    if (target.changeQueueOnStop) target.revision++;
                    break;
                case 'Seek':
                    if (args.Unit === 'TRACK_NR') {
                        target.number = args.Target;
                        if (!target.deferQueueTrack) target.track = target.items?.[Number(args.Target) - 1] ?? old;
                    }
                    else target.time = args.Target;
                    break;
                case 'BecomeCoordinatorOfStandaloneGroup':
                    target.leader = target.id;
                    target.uri = target.track = '';
                    target.state = 'STOPPED';
                    if (target.lostDetach) return req.socket.destroy();
                    break;
                default: assert.fail(action);
            }
            if (fault) res.statusCode = 500;
            const resultTags = target.microsoft ? Object.entries(values).map(([key, value]) =>
                `<${key} xmlns:dt="urn:schemas-microsoft-com:datatypes" dt:dt="string">${encode(value)}</${key}>`).join('') : tags(values);
            res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>` +
                (fault ? `<s:Fault><detail><UPnPError><errorCode>${fault}</errorCode></UPnPError></detail></s:Fault>` :
                    `<${action}Response>${resultTags}</${action}Response>`) + '</s:Body></s:Envelope>');
        } catch (error) {
            res.statusCode = 500;
            res.end(String(error));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => {server.close(resolve); server.closeAllConnections();}));
    const speaker = (item, overrides) => {
        const base = `http://127.0.0.1:${server.address().port}/${item.id}`;
        return {id: `dlna:uuid:${item.id.toLowerCase()}`, protocol: 'sonos', endpoint: `${base}/transport`,
            service: type('AVTransport'), topology: `${base}/topology`,
            rendering: {endpoint: `${base}/rendering`, service: type('RenderingControl'), scpd: `${base}/range`}, ...overrides};
    };
    const store = new Map();
    const device = {getStoreValue: key => store.get(key), setStoreValue: async (key, value) => store.set(key, value)};
    const controller = (resolved, select = async () => resolved) =>
        new DirectSpeakerSession({device, playback: {select}});
    return {calls, speaker, controller, device, store};
}

test('typed Microsoft SOAP values retain usable transport, position and volume', async t => {
    const item = room('TYPED', {microsoft: true});
    const {speaker, controller} = await setup(t, [item]);
    const target = speaker(item);
    const session = controller(target);
    assert.equal((await session.start(target, file(1), {group: false, volume: 17})).ok, true);
    assert.equal(item.volume, 17);
    assert.equal((await session.pause()).ok, true);
    assert.equal((await session.resume()).ok, true);
    assert.equal((await session.status()).targets[0].position, 0);
    assert.equal((await session.stop()).ok, true);
    assert.equal(item.volume, 39);
});

test('identified Windows renderer confirms a successful Stop as paused at zero without repeating it', async t => {
    const item = room('WINDOWS', {windowsStop: true, microsoft: true});
    const {speaker, controller, calls} = await setup(t, [item]);
    const target = speaker(item, {protocol: 'dlna', windowsRenderer: true});
    const session = controller(target);
    assert.equal((await session.start(target, file(1), {group: false, restore: false})).ok, true);
    item.time = '0:00:04';
    assert.equal((await session.stop()).ok, true);
    assert.equal(calls.filter(call => call.action === 'Stop').length, 1);
    assert.equal(item.state, 'PAUSED_PLAYBACK');
    assert.equal(item.time, '0:00:00');
    assert.equal(session.journal.units.length, 0);
});

test('Windows queue EOF requires recent near-end progress before accepting a paused zero reset', async t => {
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    const item = room('WINDOWS_EOF');
    const {speaker, controller, calls} = await setup(t, [item]);
    const target = speaker(item, {protocol: 'dlna', windowsRenderer: true});
    const session = controller(target);
    const items = [file(1, 10000), file(2, 10000)];
    assert((await session.start(target, items[0], {restore: false, queue: {items, index: 0, repeat: false}})).ok);
    item.time = '0:00:08';
    assert((await session.status()).ok);
    item.state = 'PAUSED_PLAYBACK';
    item.time = '0:00:00';
    clock += 2000;
    const before = calls.length;
    assert.equal((await session.status()).targets[0].state, 'TRANSITIONING');
    clock += 2000;
    const finished = await session.status();
    assert(finished.ok && finished.targets[0].finished);
    assert.equal(calls.length, before, 'EOF verification must not issue transport writes');
    assert((await session.start(target, items[1], {queue: {items, index: 1, repeat: false}})).ok);
    assert.equal(item.track, items[1].url);
    assert(!(await session.status()).targets[0].finished);
});

test('Windows EOF does not reinterpret ordinary pauses, early zero resets or unverified progress', async t => {
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    for (const scenario of ['ordinary-pause', 'early-zero', 'no-progress', 'expired-proof', 'foreign-source',
        'other-renderer', 'reported-longer-track']) {
        const item = room('WINDOWS_' + scenario, {trackDuration: scenario === 'reported-longer-track' ? '0:00:30' : '0:00:00'});
        const {speaker, controller, calls} = await setup(t, [item]);
        const target = speaker(item, {protocol: 'dlna', windowsRenderer: scenario !== 'other-renderer'});
        const session = controller(target);
        const items = [file(1, 10000), file(2, 10000)];
        assert((await session.start(target, items[0], {restore: false, queue: {items, index: 0, repeat: false}})).ok);
        if (scenario !== 'no-progress') {
            item.time = scenario === 'early-zero' ? '0:00:02' : '0:00:08';
            assert((await session.status()).ok);
        }
        clock += scenario === 'expired-proof' ? 15000 : scenario === 'no-progress' ? 12000 : 4000;
        item.state = 'PAUSED_PLAYBACK';
        item.time = scenario === 'ordinary-pause' ? '0:00:08' : '0:00:00';
        if (scenario === 'foreign-source') item.uri = item.track = items[0].url + '&foreign=1';
        const before = calls.length;
        const result = await session.status();
        assert.equal(result.ok, scenario !== 'foreign-source', scenario);
        assert(!result.targets[0]?.finished, scenario);
        assert.equal(calls.length, before, scenario + ' must not write transport commands');
    }
});

test('ordinary music does not resume a prior finite DLNA track after Stop', async t => {
    const item = room('NO_REPLAY', {trackDuration: '0:03:46'});
    const {speaker, controller, calls} = await setup(t, [item]);
    const session = controller(speaker(item, {protocol: 'dlna'}));
    assert.equal((await session.start(speaker(item, {protocol: 'dlna'}), file(1), {restore: true, restoreQueue: false})).ok, true);
    const since = calls.length;
    assert.equal((await session.stop()).ok, true);
    assert.equal(calls.slice(since).some(call => call.action === 'SetAVTransportURI'), false);
    assert.equal(item.state, 'STOPPED');
});

test('ordinary music does not reload an unplayable prior DLNA URI with no duration', async t => {
    const item = room('UNPLAYABLE_PRIOR', {uri: old, track: old, state: 'STOPPED', trackDuration: '0:00:00'});
    const {speaker, controller, calls} = await setup(t, [item]);
    const target = speaker(item, {protocol: 'dlna'});
    const session = controller(target);
    assert.equal((await session.start(target, file(1), {restore: true, restoreQueue: false})).ok, true);
    const since = calls.length;
    assert.equal((await session.stop()).ok, true);
    assert.equal(calls.slice(since).some(call => call.action === 'SetAVTransportURI'), false);
});

test('DLNA video metadata describes video rather than a music track', async t => {
    const item = room('VIDEO');
    const {speaker, controller} = await setup(t, [item]);
    const target = speaker(item, {protocol: 'dlna'});
    const video = {...file(1), url: 'http://media.lan/sample.mp4', contentType: 'video/mp4'};
    assert.equal((await controller(target).start(target, video, {restore: false})).ok, true);
    assert.match(item.metadata, /<upnp:class>object.item.videoItem<\/upnp:class>/);
    assert.match(item.metadata, /http-get:\*:video\/mp4:\*/);
});

test('DLNA queue edits retain the current source and position without loading or seeking', async t => {
    const item = room('EDIT_QUEUE', {time: '0:00:02'});
    const {speaker, controller, calls} = await setup(t, [item]);
    const target = speaker(item, {protocol: 'dlna'});
    const session = controller(target);
    const items = [file(1), file(2), file(3)].map((file, index) => ({...file, index}));
    assert.equal((await session.start(target, items[0], {restore: false, queue: {items, index: 0}})).ok, true);
    item.time = '0:00:02';
    const since = calls.length;
    const reordered = [items[0], items[2], items[1]];
    assert.equal((await session.start(target, items[0],
        {restore: false, queueOnly: true, position: 2000, queue: {items: reordered, index: 0}})).ok, true);
    assert.equal(item.next, items[2].url);
    assert.equal(item.time, '0:00:02');
    assert.equal(calls.slice(since).some(call => ['SetAVTransportURI', 'Play', 'Seek', 'SetVolume'].includes(call.action)), false);
});

test('Sonos Stop can reset the queue slot only while the exact UMP queue is still verified', async t => {
    const item = room('RESET_QUEUE', {items: [], revision: 1, stopQueueReset: true});
    const {speaker, controller, calls} = await setup(t, [item]);
    const target = speaker(item);
    target.queue = {endpoint: target.endpoint, service: 'urn:schemas-sonos-com:service:Queue:1'};
    const session = controller(target);
    const items = [file(1), file(2)].map((file, index) => ({...file, index}));
    assert.equal((await session.start(target, items[1], {restore: false, restoreQueue: false, queue: {items, index: 1}})).ok, true);
    assert.equal((await session.stop()).ok, true);
    assert.equal(calls.filter(call => call.action === 'Stop').length, 1);
    assert.equal(item.track, items[0].url);
});

test('Sonos Stop rejects a reset queue position if the queue changed during the command', async t => {
    const item = room('CHANGED_RESET', {items: [], revision: 1, stopQueueReset: true, changeQueueOnStop: true});
    const {speaker, controller} = await setup(t, [item]);
    const target = speaker(item);
    target.queue = {endpoint: target.endpoint, service: 'urn:schemas-sonos-com:service:Queue:1'};
    const session = controller(target);
    const items = [file(1), file(2)].map((file, index) => ({...file, index}));
    assert.equal((await session.start(target, items[1], {restore: false, queue: {items, index: 1}})).ok, true);
    const report = await session.stop();
    assert.equal(report.ok, false);
    assert.match(JSON.stringify(report), /source changed/i);
});

test('speaker-source controls use the owning UMP queue instead of competing with its transport', async t => {
    const item = room('OWNER');
    const {speaker, controller, device} = await setup(t, [item]);
    device.getData = () => ({id: 'ump-owner'});
    const target = speaker(item, {protocol: 'dlna', id: 'dlna:uuid:owner'});
    const session = controller(target);
    const files = [{...file(1), id: 'one'}, {...file(2), id: 'two'}];
    const playlist = {
        files, currentFile: files[0], playing: true, paused: false, mode: 'normal',
        Pause: async () => {
            assert.equal((await session.pause()).ok, true);
            playlist.playing = false;
            playlist.paused = true;
        },
        PlayQueueItem: async index => {
            const result = await session.start(target, files[index], {restore: false, group: false});
            playlist.currentFile = files[index];
            playlist.playing = result.ok;
            playlist.paused = false;
            return result.ok;
        }
    };
    Object.assign(device, {
        playlistManager: playlist, getAvailable: () => true, getName: () => 'Owner',
        getCapabilityValue: () => null
    });
    const homey = {__: key => key, drivers: {getDriver: () => ({getDevices: () => [device]})},
        app: {speakerPlayback: {selectForControl: async () => target}}};
    assert.equal((await session.start(target, files[0], {restore: false, group: false})).ok, true);
    const state = await mediaWidget.state({homey, query: {speaker: target.id}});
    assert.equal(state.player.managed, true);
    assert.equal(state.player.locked, false);
    assert.equal(state.player.actions.next, true);
    assert.equal(state.player.actions.playQueueItem, true);
    const queue = await mediaWidget.playlist({homey, body: {speaker: target.id, size: 50}});
    assert.deepEqual(queue.items.map(item => item.id), ['one', 'two']);
    assert.equal((await mediaWidget.control({homey, body: {speaker: target.id, action: 'pause'}})).player.paused, true);
    const played = await mediaWidget.control({homey, body: {speaker: target.id, action: 'playQueueItem', number: 2, item: 'two'}});
    assert.equal(played.player.playing, true);
    assert.equal(item.track, file(2).url);
    assert.equal((await session.stop()).ok, true);
    assert.equal((await mediaWidget.playlist({homey, body: {speaker: target.id, size: 50}})).unavailable, true);
});

test('widget destinations preserve independent queues, source controls and ownership across restart', async t => {
        const a = room('WIDGET_A');
        const b = room('WIDGET_B');
        const {speaker, calls, store} = await setup(t, [a, b]);
        const targets = [
            {...speaker(a, {protocol: 'dlna', id: 'dlna:uuid:widget-a'}), name: 'A'},
            {...speaker(b, {protocol: 'dlna', id: 'dlna:uuid:widget-b'}), name: 'B'}
        ];
        const files = [1, 2].map(index => ({...file(index), id: `file-${index}`}));
        const settings = new Map();
        const errors = [];
        let parent;
        const homey = {
            __: key => key,
            settings: {get: key => settings.get(key), set: async (key, value) => settings.set(key, value)},
            images: {createImage: async () => ({
                id: 'widget-art', setUrl() {}, setStream() {}, update: async () => {}
            })},
            drivers: {getDriver: () => ({getDevices: () => [parent]})},
            app: {error() {}, speakerPlayback: {
                select: async selection => targets.find(target => target.id === selection.id),
                selectForControl: async selection => targets.find(target => target.id === selection.id),
                autocomplete: async () => targets
            }}
        };
        function makeParent() {
            const capabilities = {volume_set: 0.1, volume_mute: false};
            const device = {
                homey, driver: {Triggers: {}},
                getData: () => ({id: 'widget-context-parent'}),
                getName: () => 'Widget parent', getAvailable: () => true,
                getSetting: key => key === 'announcement_resume' ? false : undefined,
                getCapabilityValue: key => capabilities[key],
                setCapabilityValue: async (key, value) => { capabilities[key] = value; },
                getStoreValue: key => store.get(key),
                setStoreValue: async (key, value) => store.set(key, value),
                setAlbumArtImage: async () => {},
                log() {}, error: (...args) => errors.push(args),
                server: {browseById: async ({page}) => page ? {items: files, next: null} : files}
            };
            device.playlistManager = new PlaylistManager({homey, uPnPPlayer: device});
            device.playlistManager.RestorePlayback();
            return device;
        }
        parent = makeParent();
        t.after(async () => {
            await widgetPlayback.dispose(parent);
            await parent.playlistManager.Dispose();
        });
        const control = (action, extra = {}, widget = 'widget-one') =>
            mediaWidget.control({homey, body: {player: parent.getData().id, widget, action, ...extra}});
        const state = widget => mediaWidget.state({homey, query: {player: parent.getData().id, widget}});
        const load = item => control('playFrom', {
            item, folder: 'album', path: [{id: 'album', name: 'Album'}], offset: 0, size: 50
        });
        store.set(DEFAULT_TARGET, targets[0]);
        const observed = await state('widget-one');
        assert.equal(observed.player.observing, targets[0].id);
        await control('volume', {observing: targets[0].id, value: 0.23});
        await control('setTarget', {value: targets[0].id});
        await load('file-1');
        assert.equal(a.volume, 23, 'Starting playback must retain the observed volume adjustment');
        await assert.rejects(control('shuffle', {value: 'invalid'}, 'rejected-widget'), /widget.invalidAction/);
        assert.equal((await state('widget-one')).player.ownerWidget, 'widget-one');
        a.time = '0:00:10';
        const before = calls.length;
        const selected = await control('setTarget', {value: targets[1].id});
        assert.equal(selected.player.observing, targets[1].id);
        assert.equal(selected.player.playing, true);
        assert.equal(a.state, 'PLAYING');
        assert.equal(a.time, '0:00:10');
        assert.equal(calls.slice(before).some(call => ['Stop', 'Play', 'Seek', 'SetAVTransportURI'].includes(call.action)), false);
        await load('file-2');
        assert.equal(b.track, files[1].url);
        const source = await mediaWidget.state({homey, query: {speaker: targets[0].id, widget: 'widget-one'}});
        assert.equal(source.player.locked, false);
        assert.equal(source.player.canBrowse, true);
        assert.equal(source.player.ownerWidget, 'widget-one');
        assert.deepEqual(source.player.selection.path, [{id: 'album', name: 'Album'}]);
        await mediaWidget.control({homey, body: {speaker: targets[0].id, widget: 'widget-one', action: 'pause'}});
        assert.equal(a.state, 'PAUSED_PLAYBACK');
        assert.equal(b.state, 'PLAYING');
        await mediaWidget.control({homey, body: {speaker: targets[0].id, widget: 'widget-one', action: 'play'}});
        await mediaWidget.control({homey, body: {speaker: targets[0].id, widget: 'widget-one', action: 'next'}});
        assert.equal(a.track, files[1].url);
        const returning = calls.length;
        await control('setTarget', {value: targets[0].id});
        assert.equal((await state('widget-one')).player.selection.file.id, 'file-2');
        assert.equal(calls.slice(returning).some(call => ['Stop', 'Play', 'SetAVTransportURI', 'Seek'].includes(call.action)), false);
        await control('setTarget', {value: targets[1].id}, 'widget-two');
        assert.equal((await state('widget-one')).player.currentTarget.id, targets[0].id);
        assert.equal((await state('widget-two')).player.currentTarget.id, targets[1].id);
        await widgetPlayback.dispose(parent);
        await parent.playlistManager.Dispose();
        parent = makeParent();
        const restarted = calls.length;
        await parent.playlistManager.RecoverDirect();
        await widgetPlayback.restore(parent);
        assert.equal((await state('widget-one')).player.selection.file.id, 'file-2');
        assert.equal((await state('widget-two')).player.selection.file.id, 'file-2');
        assert.equal(a.state, 'PLAYING');
        assert.equal(b.state, 'PLAYING');
        assert.equal(calls.slice(restarted).some(call => ['Stop', 'Play', 'SetAVTransportURI', 'Seek'].includes(call.action)), false);
        await control('setTarget', {value: targets[0].id});
        await control('stop');
        await control('setTarget', {value: targets[1].id});
        await control('stop');
        const group = {id: 'widget-multi-target', name: 'Group', targets};
        store.set(DEFAULT_TARGET, group);
        homey.app.speakerPlayback.select = homey.app.speakerPlayback.selectForControl = async selection =>
            selection.id === group.id ? group : targets.find(target => target.id === selection.id);
        await control('setTarget', {value: null});
        await load('file-1');
        await control('setTarget', {value: targets[0].id});
        const rooms = await control('listRooms', {target: targets[0].id});
        assert.equal(rooms.supported, false, 'A selected DLNA group member must not fail owner-target validation');
        await control('volume', {value: 0.17});
        assert.equal(a.volume, 17);
        assert.notEqual(b.volume, 17, 'Member volume must not change the other owned destination');
        await control('stop');
        assert.deepEqual(errors, []);
});

test('individual Sonos preparation retries once with a fresh snapshot before any writes', async t => {
    for (const failRead of ['GetZoneGroupState', 'GetMediaInfo', 'GetVolume']) {
        const item = room('123456789ABC01400', {failRead});
        const {calls, speaker, controller} = await setup(t, [item]);
        const original = speaker(item, {host: '192.168.1.25'});
        const replacement = speaker(item, {host: '192.168.1.26'});
        const playback = new SpeakerPlayback(() => {});
        playback.selectForControl = async () => original;
        playback.refreshInBackground = () => {};
        let retries = 0;
        const freshSource = `http://radio.lan/new-${failRead}`;
        playback.rediscoverSonosEndpoint = async (failed, error) => {
            assert.equal(failed, original);
            assert.equal(error.code, 'ECONNRESET');
            assert.equal(calls.length, 0, 'preparation must not mutate playback or volume');
            retries++;
            item.uri = item.track = freshSource;
            return replacement;
        };
        const session = controller(original);
        session.playback = playback;
        const result = await session.start(original, file(1), {volume: 17, group: false});
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(retries, 1);
        assert.equal(session.journal.units[0].original.uri, freshSource);
        assert.equal(session.journal.units[0].target.host, replacement.host);
        assert.equal(calls.filter(call => call.action === 'SetVolume').length, 1);
        assert.equal(calls.filter(call => call.action === 'SetAVTransportURI').length, 1);
        assert.equal((await session.stop()).ok, true);
        assert.equal(item.uri, freshSource);
    }
});

test('a lost volume-write reply does not retry managed playback; groups do not get individual retry', async t => {
    const item = room('123456789ABC01400', {lostVolume: true});
    const {calls, speaker, controller} = await setup(t, [item]);
    const target = speaker(item, {host: '192.168.1.25'});
    const playback = new SpeakerPlayback(() => {});
    playback.selectForControl = async () => target;
    playback.refreshInBackground = () => {};
    playback.rediscoverSonosEndpoint = async () => assert.fail('a write may have reached the speaker');
    const session = controller(target);
    session.playback = playback;
    const result = await session.start(target, file(1), {volume: 17, group: false});
    assert.equal(result.ok, false);
    assert.equal(calls.filter(call => call.action === 'SetVolume').length, 1);
    assert.equal((await session.stop()).ok, true);
    item.failRead = 'GetZoneGroupState';
    playback.selectForControl = async () => ({id: 'all', targets: [target]});
    assert.equal((await session.start({id: 'all'}, file(2), {group: false})).ok, false);
});

test('ordinary music to a grouped Sonos follower allows volume changes without regrouping', async t => {
    const leader = room('FOLLOW_LEADER', {groupVolume: 39});
    const follower = room('FOLLOW_ROOM', {leader: leader.id, uri: `x-rincon:${leader.id}`});
    const {controller, calls, speaker} = await setup(t, [leader, follower]);
    const targets = [leader, follower].map(item => speaker(item));
    targets[0].groupRendering = {endpoint: targets[0].endpoint, service: type('GroupRenderingControl')};
    const [, selected] = targets;
    const session = controller(selected, async ({id}) => targets.find(target => target.id === id));
    const result = await session.start(selected, file(1), {volume: 15, followGroup: true});
    assert.equal(result.active, true, JSON.stringify(result));
    assert.deepEqual(calls.filter(call => call.action === 'Play').map(call => call.target), [leader.id]);
    assert.deepEqual(calls.filter(call => call.action === 'SetVolume').map(call => call.target), [follower.id]);
    assert.equal(follower.leader, leader.id);
    assert.ok(!calls.some(call => call.action === 'BecomeCoordinatorOfStandaloneGroup'));
    const homey = {__: key => key, app: {speakerPlayback: {
        selectForControl: async ({id}) => targets.find(target => target.id === id),
        listSpeakers: async () => targets
    }}};
    const control = payload => widgetSpeaker.control(homey, {speaker: selected.id, ...payload}, true);
    const panel = await control({action: 'listRooms'});
    assert.equal(panel.locked, true);
    assert.equal(panel.rooms.find(room => room.id === selected.id).volume, 0.15);
    assert.equal((await control({action: 'volume', value: 0.16})).player.volume, 0.16);
    const since = calls.length;
    const adjustedRoom = await control({action: 'roomVolume', room: selected.id, value: 0.21});
    assert.equal(adjustedRoom.rooms.find(room => room.id === selected.id).volume, 0.21);
    assert.equal((await control({action: 'groupVolume', value: 0.25})).groupVolume, 0.25);
    await assert.rejects(control({action: 'leaveRoom', value: selected.id}), /widget.invalidAction/);
    assert.deepEqual(calls.slice(since).map(call => call.action), ['SetVolume', 'SnapshotGroupVolume', 'SetGroupVolume']);
    assert.equal(leader.track, file(1).url);
    assert.equal((await session.stop()).ok, true);
    assert.equal(follower.leader, leader.id);
    assert.equal(leader.volume, 39);
    assert.equal(follower.volume, 21);
});

test('DLNA playback supports a renderer that exposes only TrackURI', async t => {
    const renderer = room('TRACK_URI_ONLY', {trackUriOnly: true, track: '', state: 'NO_MEDIA_PRESENT'});
    const {controller, speaker} = await setup(t, [renderer]);
    const target = speaker(renderer, {protocol: 'dlna'});
    const session = controller(target);
    const result = await session.start(target, file(1));
    assert.equal(result.active, true, JSON.stringify(result));
    assert.equal(renderer.track, file(1).url);
    assert.equal((await session.stop()).ok, true);
});

test('Sonos plays the UMP order, follows external skips after restart and leaves a user-edited queue alone', async t => {
    const speaker = room('NATIVE', {items: [old], revision: 6});
    const {controller, calls, speaker: describe} = await setup(t, [speaker]);
    const target = describe(speaker);
    target.queue = {endpoint: target.endpoint, service: 'urn:schemas-sonos-com:service:Queue:1'};
    const items = [file(1), file(3), file(2)].map((item, index) => ({...item, index: [0, 2, 1][index]}));
    const options = {queue: {items, index: 2, repeat: true}, restoreQueue: false};
    const started = await controller(target).start(target, items[2], options);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.deepEqual(speaker.items, items.map(item => item.url));
    assert.equal(speaker.track, items[2].url);
    assert.equal(speaker.playMode, 'REPEAT_ALL');
    speaker.track = items[0].url;
    speaker.number = '1';
    const restarted = controller(target);
    assert.equal((await restarted.status()).targets[0].index, 0);
    assert.equal((await restarted.pause()).ok, true);
    assert.equal((await restarted.resume()).ok, true);
    const before = calls.length;
    speaker.revision++;
    const released = await restarted.stop();
    assert.equal(released.persisted, false);
    assert.equal(speaker.state, 'PLAYING');
    assert.equal(calls.slice(before).some(call => call.action === 'Stop'), false);
});

test('switches from a Sonos room to TV input when the queue track URI is only resolved after Play', async t => {
    const tuin = room('TUIN');
    const bar = room('BAR', {uri: 'x-sonos-htastream:BAR:spdif', track: '', state: 'PLAYING',
        items: [], revision: 1, deferQueueTrack: true});
    const {controller, speaker: describe} = await setup(t, [tuin, bar]);
    const first = describe(tuin);
    const second = describe(bar);
    second.queue = {endpoint: second.endpoint, service: 'urn:schemas-sonos-com:service:Queue:1'};
    const session = controller(first);
    session.playback.select = async selection => selection.id === second.id ? second : first;
    const items = [file(1), file(2)].map((item, index) => ({...item, index}));
    assert.equal((await session.start(first, items[1], {restore: false})).ok, true);
    const handoff = await session.setTarget(second, items[1], {queue: {items, index: 1}});
    assert.equal(handoff.ok, true, JSON.stringify(handoff));
    assert.equal(tuin.state, 'STOPPED');
    assert.equal(bar.track, items[1].url);
    assert.equal(bar.state, 'PLAYING');
    await session.stop({restore: false});
});

test('DLNA confirms and follows the armed next track, and falls back on unsupported renderers', async t => {
    const renderer = room('NEXT');
    const {controller, speaker: describe} = await setup(t, [renderer]);
    const target = describe(renderer, {protocol: 'dlna'});
    const session = controller(target);
    const items = [file(1), file(2), file(3)].map((item, index) => ({...item, index}));
    const options = {queue: {items, index: 0}, restore: false};
    assert.equal((await session.start(target, items[0], options)).ok, true);
    assert.equal(renderer.next, items[1].url);
    renderer.uri = renderer.track = renderer.next;
    renderer.next = '';
    assert.equal((await session.status()).targets[0].index, 1);
    assert.equal(renderer.next, items[2].url);
    assert.equal((await session.stop()).ok, true);
    assert.equal(renderer.next ?? '', '');
    assert.equal((await session.start(target, items[2], {...options, queue: {items, index: 2, repeat: true}})).ok, true);
    assert.equal(renderer.next, items[0].url);
    renderer.uri = renderer.track = renderer.next;
    renderer.next = '';
    assert.equal((await session.status()).targets[0].index, 0);
    assert.equal((await session.stop()).ok, true);
    renderer.unsupported = ['SetNextAVTransportURI'];
    assert.equal((await session.start(target, items[0], options)).ok, true);
    assert.equal(session.hasHandoff, false);
    assert.equal((await session.stop()).ok, true);
});

test('Cast queues the requested order, follows receiver skips and does not reload at a native skip', async t => {
    const {Client, DefaultMediaReceiver} = require('castv2-client');
    const target = {id: 'cast:queue', protocol: 'cast', host: 'speaker.lan'};
    const app = {appId: DefaultMediaReceiver.APP_ID, sessionId: 'native-app'};
    const calls = [];
    let active;
    let status;
    let items;
    const receiver = {
        getStatus: cb => cb(null, status),
        media: {request(message, cb) {
            calls.push(message.type);
            if (message.type === 'QUEUE_LOAD') {
                items = message.items;
                status = {mediaSessionId: 7, media: items[message.startIndex].media, playerState: 'PLAYING'};
                status.repeatMode = message.repeatMode;
            } else if (message.type === 'STOP') status = undefined;
            cb(null, {type: 'MEDIA_STATUS', status: status ? [status] : []});
        }}
    };
    t.mock.method(Client.prototype, 'connect', (_, cb) => cb());
    t.mock.method(Client.prototype, 'getStatus', cb => cb(null, {applications: active ? [app] : []}));
    t.mock.method(Client.prototype, 'launch', (Receiver, cb) => {
        assert.equal(Receiver.APP_ID, app.appId);
        active = true;
        cb(null, receiver);
    });
    t.mock.method(Client.prototype, 'join', (_, __, cb) => cb(null, receiver));
    t.mock.method(Client.prototype, 'close', () => {});
    const controller = new DirectSpeakerSession({playback: {select: async () => target}, device: {}});
    const order = [file(1), file(3), file(2)].map((item, index) => ({...item, index: [0, 2, 1][index]}));
    const started = await controller.start(target, order[0], {queue: {items: order, index: 0}, restore: false});
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.deepEqual(items.map(item => item.media.contentId), order.map(item => item.url));
    status.media = items[1].media;
    status.currentTime = 3;
    assert.deepEqual((await controller.status()).targets[0], {
        id: target.id, url: order[1].url, state: 'PLAYING', position: 3000, handoff: true, index: 2, finished: false
    });
    status.media = items[2].media;
    assert.equal((await controller.status()).targets[0].index, 1);
    status = {mediaSessionId: 7, idleReason: 'FINISHED', playerState: 'IDLE'};
    assert.equal((await controller.status()).targets[0].finished, true);
    assert.equal((await controller.stop()).ok, true);
    assert.deepEqual(calls, ['QUEUE_LOAD']);
    assert.equal((await controller.start(target, order[2], {queue: {items: order, index: 2, repeat: true}, restore: false})).ok, true);
    assert.equal(status.repeatMode, 'REPEAT_ALL');
    status.media = items[0].media;
    assert.equal((await controller.status()).targets[0].index, 0);
    assert.equal((await controller.stop()).ok, true);
});

test('Sonos plays successive tracks without resnapshotting, directly controls transport and restores original queue after restart', async t => {
    const primary = room('A', {uri: queue, state: 'PAUSED_PLAYBACK', mute: 1});
    const {calls, speaker, controller} = await setup(t, [primary]);
    const selection = speaker(primary, {volumeOffset: 10, maxVolume: 45});
    const session = controller(selection);
    assert.equal((await session.start(selection, file(1), {volume: 0})).ok, true);
    assert.equal(primary.volume, 0);
    assert.equal(primary.mute, 1);
    assert.match(primary.metadata, /audio\/flac/);
    assert.match(primary.metadata, /A &amp; B/);
    assert.equal((await session.start(selection, file(2))).ok, true);
    assert.equal(primary.uri, file(2).url);
    assert.equal(calls.filter(call => call.action === 'SetAVTransportURI').length, 2);
    assert.equal((await session.setVolume(40)).ok, true);
    assert.equal(primary.volume, 45);
    assert.equal((await session.setMute(false)).ok, true);
    assert.equal(primary.mute, 0);
    primary.time = '0:00:23';
    const paused = await session.pause();
    assert.equal(paused.ok, true);
    const restarted = controller(selection);
    const status = await restarted.status();
    assert.equal(status.persisted, true);
    assert.deepEqual(status.targets, [{id: selection.id, url: file(2).url, state: 'PAUSED_PLAYBACK', position: 23000}]);
    assert.equal((await restarted.resume()).ok, true);
    assert.equal(primary.time, '0:00:23');
    primary.volume = 32; // Changed by the user.
    const stopped = await restarted.stop();
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.equal(stopped.persisted, false);
    assert.equal(primary.uri, queue);
    assert.equal(primary.number, '3');
    assert.equal(primary.time, '0:01:14');
    assert.equal(primary.state, 'PAUSED_PLAYBACK');
    assert.equal(primary.volume, 32);
    assert.equal(primary.mute, 1);
    assert.equal(primary.metadata, '<DIDL-Lite>Original &amp; preserved</DIDL-Lite>');
});

test('music leaves the original Sonos queue stopped, while a notification restores it', async t => {
    const primary = room('A', {uri: queue, state: 'PAUSED_PLAYBACK'});
    const {calls, speaker, controller, store} = await setup(t, [primary]);
    const target = speaker(primary);
    const session = controller(target);
    assert.equal((await session.start(target, file(1), {restoreQueue: false})).ok, true);
    const blocked = await session.playNotification(target, file(2, 20));
    assert.equal(blocked.ok, false);
    assert.equal(primary.uri, file(1).url);
    assert.equal((await session.stop()).ok, true);
    assert.equal(primary.uri, file(1).url);
    assert.equal(primary.state, 'STOPPED');
    assert.equal(calls.some(call => call.args?.CurrentURI === queue), false);

    Object.assign(primary, {uri: queue, track: old, state: 'PAUSED_PLAYBACK', time: '0:01:14', number: '3'});
    const result = await session.playNotification(target, file(2, 20));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.persisted, false);
    assert.equal(primary.uri, queue);
    assert.equal(primary.state, 'PAUSED_PLAYBACK');
    assert.equal(primary.time, '0:01:14');
    assert.equal(primary.number, '3');
    assert.equal(store.get('directSpeakerSessionV1').notification, undefined);
});

test('Stop after restart undoes temporary Sonos grouping without reloading saved announcements', async t => {
    const wrapped = `x-rincon-mp3radio://${announcement}`;
    const primary = room('A', {uri: wrapped, track: announcement});
    const wav = announcement.replace(/\.mp3$/, '.wav');
    const follower = room('B', {uri: wav, track: wav, state: 'PAUSED_PLAYBACK'});
    const {calls, speaker, controller} = await setup(t, [primary, follower]);
    const group = {id: 'group:both', targets: [speaker(primary), speaker(follower)]};
    assert.equal((await controller(group).start(group, file(1), {groupSonos: true})).ok, true);
    assert.equal(follower.leader, primary.id);

    calls.length = 0;
    const stopped = await controller(group).stop();
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.equal(stopped.persisted, false);
    assert.equal(primary.leader, primary.id);
    assert.equal(follower.leader, follower.id);
    assert.equal(primary.state, 'STOPPED');
    assert.equal(follower.state, 'STOPPED');
    assert.ok(calls.some(call => call.action === 'BecomeCoordinatorOfStandaloneGroup'));
    assert.deepEqual(calls.filter(call => ['SetAVTransportURI', 'Seek', 'Play'].includes(call.action)), []);
});

test('idle volume and mute control the selected rooms without changing playback or grouping', async t => {
    const first = room('A', {bonded: 'RINCON_SATELLITE', bond: 'RINCON_A:RF;RINCON_SATELLITE:LF'});
    const second = room('B');
    const {calls, speaker, controller, store} = await setup(t, [first, second]);
    const group = {id: 'group:both', targets: [speaker(first, {maxVolume: 30}), speaker(second)]};
    const session = controller(group);
    assert.equal((await session.setVolume(45, group)).ok, true);
    const muted = await session.setMute(true, group);
    assert.equal(muted.ok, true);
    assert.equal(muted.persisted, false);
    assert.equal(store.size, 0);
    assert.deepEqual([first.volume, second.volume], [30, 45]);
    assert.deepEqual([first.mute, second.mute], [1, 1]);
    assert.ok(calls.every(call => ['SetVolume', 'SetMute'].includes(call.action)));
    assert.deepEqual([first.state, second.state], ['PLAYING', 'PLAYING']);
    assert.deepEqual([first.leader, second.leader], [first.id, second.id]);
});

test('Tuin-only and no-TV selections refuse existing mixed groups; a bonded secondary cannot be controlled', async t => {
    const tuin = room('TUIN', {bonded: 'RINCON_HIDDEN', bond: 'RINCON_TUIN:RF;RINCON_HIDDEN:LF'});
    const tv = room('TV', {leader: tuin.id, uri: `x-rincon:${tuin.id}`});
    const {calls, speaker, controller} = await setup(t, [tuin, tv]);
    const individual = speaker(tuin);
    assert.equal((await controller(individual).start(individual, file(1))).ok, false);
    const selected = {id: 'all_no_tv_speakers', targets: [individual], excludedSonos: [speaker(tv)]};
    assert.equal((await controller(selected).start(selected, file(1))).ok, false);
    const hidden = {...individual, id: 'dlna:uuid:rincon_hidden'};
    assert.equal((await controller(hidden).start(hidden, file(1))).ok, false);
    assert.deepEqual(calls, []);
});

test('temporary Sonos group favors stereo coordinator, survives lost replies and restores without touching bonded member', async t => {
    const primary = room('A', {bonded: 'RINCON_SECOND', bond: 'RINCON_A:RF;RINCON_SECOND:LF'});
    const single = room('B', {state: 'PAUSED_PLAYBACK', lostJoin: true, lostDetach: true});
    const {calls, speaker, controller} = await setup(t, [primary, single]);
    const group = {id: 'group:both', targets: [speaker(single), speaker(primary)]};
    const session = controller(group);
    const started = await session.start(group, file(1), {groupSonos: true});
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(single.leader, primary.id);
    assert.equal(single.uri, `x-rincon:${primary.id}`);
    assert.equal((await session.start(group, file(2))).ok, true);
    assert.equal(calls.filter(call => call.args?.CurrentURI === `x-rincon:${primary.id}`).length, 1);
    const result = await session.stop();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(single.leader, single.id);
    assert.equal(single.uri, old);
    assert.equal(single.state, 'PAUSED_PLAYBACK');
    assert.equal(primary.uri, old);
    assert.equal(primary.state, 'PLAYING');
    assert(calls.every(call => [primary.id, single.id].includes(call.target)));
});

test('user transport and topology changes are not overwritten on pause, target handoff or stop', async t => {
    const a = room('A'), b = room('B');
    const {calls, speaker, controller} = await setup(t, [a, b]);
    const group = {id: 'group:both', targets: [speaker(a), speaker(b)]};
    const session = controller(group);
    assert.equal((await session.start(group, file(1))).ok, true);
    b.leader = b.id;
    b.uri = b.track = 'x-rincon-stream:RINCON_B';
    b.state = 'PLAYING';
    const before = calls.length;
    assert.equal((await session.pause()).ok, false);
    assert.equal((await session.setTarget({id: 'different'}, file(2))).ok, false);
    assert.equal(calls.length, before);
    assert.equal(b.uri, 'x-rincon-stream:RINCON_B');
});

test('verified natural end can advance; external same-URI pause cannot', async t => {
    const a = room('A');
    const {calls, speaker, controller} = await setup(t, [a]);
    const selection = speaker(a);
    const session = controller(selection);
    assert.equal((await session.start(selection, file(1, 200))).ok, true);
    a.state = 'STOPPED';
    assert.equal((await session.start(selection, file(2))).ok, true);
    a.uri = `x-rincon-mp3radio://${file(2).url}`;
    a.state = 'PAUSED_PLAYBACK';
    const before = calls.length;
    assert.equal((await session.start(selection, file(3))).ok, false);
    assert.equal(calls.length, before);
});

for (const protocol of ['sonos', 'dlna']) test(`${protocol}: radio restoration retries read-only until the original stream plays`, async t => {
    const radio = `x-rincon-mp3radio://${old}`;
    const tuin = room('TUIN', {uri: radio, reconnectUri: radio});
    const {calls, speaker, controller} = await setup(t, [tuin]);
    const selection = speaker(tuin, {protocol});
    const session = controller(selection);
    const started = await session.start(selection, file(1));
    assert.equal(started.ok, true);

    const timedOut = await session.stop();
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.persisted, true);
    assert.equal(timedOut.active, false);
    assert.match(timedOut.failures[0].message, /original radio source resumed playing/);
    assert.equal(tuin.uri, radio);
    assert.equal(tuin.state, 'TRANSITIONING');

    const restarted = controller(selection);
    const before = calls.length;
    const retry = await restarted.start(selection, file(2));
    assert.equal(retry.ok, false);
    assert.equal(retry.persisted, true);
    assert.equal(calls.length, before, 'retry must not reload the same URI, Play again, or start a new track');

    tuin.state = 'PLAYING';
    const restored = await restarted.stop();
    assert.equal(restored.ok, true);
    assert.equal(restored.persisted, false);
    assert.equal(calls.length, before, 'approval of restoration must be read-only');
});

for (const uri of [old, `x-rincon-mp3radio://${old}`]) test(`DLNA requires seek verification for finite media (${uri.split(':')[0]})`, async t => {
    const renderer = room('DLNA', {uri, trackDuration: '0:04:00'});
    const {calls, speaker, controller, store} = await setup(t, [renderer]);
    const selection = speaker(renderer, {protocol: 'dlna'});
    assert.equal((await controller(selection).start(selection, file(1))).ok, true);

    // Simulate a restart after restoring the URI but before verifying seek.
    const [{units: [unit]}] = store.values();
    Object.assign(unit, {releasing: true, restoreOnRelease: true, restoringSource: true});
    Object.assign(renderer, {uri, track: old, state: 'PLAYING', time: '0:00:00'});
    const before = calls.length;
    const result = await controller(selection).stop();
    assert.equal(result.ok, false);
    assert.match(result.failures[0].message, /previous position could not be verified/);
    assert.equal(calls.length, before);
});

test('playback without restoration still stops, removes temporary grouping and restores owned volume', async t => {
    const a = room('A'), b = room('B');
    const {speaker, controller} = await setup(t, [a, b]);
    const group = {id: 'group:both', targets: [speaker(a), speaker(b)]};
    const session = controller(group);
    assert.equal((await session.start(group, file(1), {volume: 25, restore: false})).ok, true);
    assert.equal((await session.stop()).ok, true);
    assert.equal(a.uri, file(1).url);
    assert.equal(a.state, 'STOPPED');
    assert.equal(b.leader, b.id);
    assert.equal(b.state, 'STOPPED');
    assert.deepEqual([a.volume, b.volume], [39, 39]);
});

test('group volume rules use each room’s current level once and restore only owned changes after restart', async t => {
    const a = room('A', {volume: 60});
    const b = room('B', {volume: 30});
    const c = room('C', {volume: 0});
    const d = room('D', {volume: 75, unsupported: ['GetVolume']});
    const {calls, speaker, controller} = await setup(t, [a, b, c, d]);
    const group = {id: 'group:levels', targets: [
        speaker(a, {maxVolume: 45}),
        speaker(b, {volumeOffset: 10}),
        speaker(c, {volumeOffset: 25}),
        speaker(d)
    ]};
    const session = controller(group);
    const started = await session.start(group, file(1));
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(b.leader, a.id);
    assert.deepEqual([a.volume, b.volume, c.volume, d.volume], [45, 40, 0, 75]);
    const writes = calls.filter(call => call.action === 'SetVolume');
    assert.deepEqual(writes.map(call => call.target), [a.id, b.id]);
    assert(calls.indexOf(writes[1]) < calls.findIndex(call => call.args?.CurrentURI === file(1).url));
    b.volume = 33; // Manual change should survive the next track and stop.
    const restarted = controller(group);
    assert.equal((await restarted.start(group, file(2))).ok, true);
    assert.deepEqual([a.volume, b.volume], [45, 33]);
    assert.equal(calls.filter(call => call.action === 'SetVolume').length, 2);
    assert.equal((await restarted.stop()).ok, true);
    assert.deepEqual([a.volume, b.volume, c.volume, d.volume], [60, 33, 0, 75]);
});

test('unverifiable member volume prevents playback on the temporary group and restores earlier adjustments', async t => {
    const a = room('A', {volume: 50});
    const b = room('B', {volume: 40, unsupported: ['SetVolume']});
    const {calls, speaker, controller} = await setup(t, [a, b]);
    const group = {id: 'group:capped', targets: [speaker(a, {maxVolume: 0}), speaker(b, {maxVolume: 20})]};
    const report = await controller(group).start(group, file(1));
    assert.equal(report.ok, false);
    assert.equal(report.active, false);
    assert.equal(report.persisted, false);
    assert.equal(calls.some(call => call.args?.CurrentURI === file(1).url), false);
    assert.deepEqual(calls.filter(call => call.target === a.id && call.action === 'SetVolume')
        .map(call => Number(call.args.DesiredVolume)), [0, 50]);
    assert.deepEqual([a.volume, b.volume], [50, 40]);
    assert.equal(b.leader, b.id);
    assert.deepEqual([a.state, b.state], ['PLAYING', 'PLAYING']);
});

test('DLNA reports unsupported pause rather than substituting Stop or reloading on resume', async t => {
    const renderer = room('DLNA', {unsupported: ['Pause']});
    const {calls, speaker, controller} = await setup(t, [renderer]);
    const selection = speaker(renderer, {protocol: 'dlna'});
    const session = controller(selection);
    assert.equal((await session.start(selection, file(1))).ok, true);
    const pause = await session.pause();
    assert.equal(pause.ok, false);
    assert.match(pause.failures[0].message, /not supported/);
    assert.equal(renderer.state, 'PLAYING');
    assert.equal((await session.resume()).ok, true);
    assert.deepEqual(calls.map(call => call.action), ['SetAVTransportURI', 'Play', 'Pause']);
    assert.equal((await session.stop()).ok, true);
});

test('concurrent operations serialize, target handoff restores first, and another playlist cannot take over', async t => {
    const a = room('A'), b = room('B');
    const {calls, speaker, device} = await setup(t, [a, b]);
    const first = speaker(a), second = speaker(b);
    const playback = {select: async selection => selection};
    const session = new DirectSpeakerSession({device, playback});
    const competing = new DirectSpeakerSession({playback});
    const [started, refused, paused] = await Promise.all([
        session.start(first, file(1)), competing.start(first, file(2)), session.pause()
    ]);
    assert.equal(started.ok, true);
    assert.equal(refused.ok, false);
    assert.equal(paused.ok, true);
    assert.equal(a.uri, file(1).url);
    assert.equal(a.state, 'PAUSED_PLAYBACK');
    assert.equal((await session.setTarget(second, file(3))).ok, true);
    assert.equal(a.uri, old);
    assert.equal(a.state, 'PLAYING');
    assert.equal(b.uri, file(3).url);
    assert(calls.findIndex(call => call.target === a.id && call.args?.CurrentURI === old) <
        calls.findIndex(call => call.target === b.id && call.args?.CurrentURI === file(3).url));
    assert.equal((await session.stop()).ok, true);
});

test('Cast binds media session IDs, reads restart position and restores the previous Default Media Receiver media', async t => {
    const {Client, DefaultMediaReceiver} = require('castv2-client');
    const target = {id: 'cast:receiver', protocol: 'cast', host: 'speaker.lan'};
    const application = {appId: DefaultMediaReceiver.APP_ID, sessionId: 'original-application'};
    const calls = [];
    let media = {mediaSessionId: 4, playerState: 'PAUSED', currentTime: 29,
        media: {contentId: old, contentType: 'audio/mpeg', streamType: 'BUFFERED'}};
    const player = {
        getStatus(cb) { cb(null, media); },
        load(content, options, cb) {
            calls.push(['load', content, options]);
            media = {mediaSessionId: (media?.mediaSessionId ?? 100) + 1,
                playerState: options.autoplay ? 'PLAYING' : 'PAUSED', currentTime: options.currentTime ?? 0, media: content};
            cb(null, media);
        },
        pause(cb) { calls.push(['pause']); media.playerState = 'PAUSED'; cb(null, media); },
        play(cb) { calls.push(['play']); media.playerState = 'PLAYING'; cb(null, media); },
        stop(cb) { calls.push(['stop']); media = undefined; cb(); }
    };
    t.mock.method(Client.prototype, 'connect', (options, cb) => cb());
    t.mock.method(Client.prototype, 'getStatus', cb => cb(null, {applications: [application]}));
    t.mock.method(Client.prototype, 'join', (session, Receiver, cb) => cb(null, player));
    t.mock.method(Client.prototype, 'close', () => {});

    let saved;
    const device = {getStoreValue: () => saved, setStoreValue: async (key, value) => { saved = value; }};
    const controller = () => new DirectSpeakerSession({device, playback: {select: async () => target}});
    const session = controller();
    assert.equal((await session.start(target, file(1))).ok, true);
    assert.equal(calls[0][1].contentType, 'audio/flac');
    assert.equal((await session.pause()).ok, true);
    media.currentTime = 14;
    const restarted = controller();
    assert.equal((await restarted.status()).targets[0].position, 14000);
    assert.equal((await restarted.resume()).ok, true);
    assert.equal(media.currentTime, 14);
    assert.equal((await restarted.stop()).ok, true);
    assert.equal(media.media.contentId, old);
    assert.equal(media.playerState, 'PAUSED');
    assert.equal(media.currentTime, 29);

    assert.equal((await restarted.start(target, file(2))).ok, true);
    media.mediaSessionId++; // Another sender loaded the same URL.
    const before = calls.length;
    assert.equal((await restarted.stop()).ok, false);
    assert.equal(calls.length, before);

    media = {mediaSessionId: 20, playerState: 'PLAYING', currentTime: 1,
        media: {contentId: announcement, contentType: 'audio/mpeg', streamType: 'BUFFERED'}};
    assert.equal((await restarted.start(target, file(3))).ok, true);
    const beforeAnnouncementStop = calls.length;
    const stopped = await controller().stop();
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.equal(stopped.persisted, false);
    assert.deepEqual(calls.slice(beforeAnnouncementStop), [['stop']]);
});
