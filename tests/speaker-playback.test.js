'use strict';

const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const test = require('node:test');
const SpeakerPlayback = require('../lib/speaker-playback');

test('individual Sonos controls share verification and reuse the endpoint during stale or pending discovery', async () => {
    const room = {id: 'dlna:uuid:rincon_000e58abcdf001400', protocol: 'sonos'};
    const service = new SpeakerPlayback(() => {});
    service.pending = new Promise(() => {});
    const verified = {...room, host: '192.168.1.25'};
    let checks = 0;
    service.verifyKnownSonos = async ids => {
        checks++;
        assert.deepEqual(ids, [room.id]);
        return [verified];
    };
    assert.deepEqual(await Promise.all([service.selectForControl(room), service.selectForControl(room)]),
        [verified, verified]);
    service.discoveredAt = 0;
    assert.equal(await service.selectForControl(room), verified);
    assert.equal(checks, 1);

    const moved = {...room, host: '192.168.1.26'};
    service.pending = Promise.resolve([moved]);
    service.verifyKnownSonos = async () => undefined;
    service.refresh = async () => assert.fail('reuse the pending scan after verification fails');
    service.controlConnectionFailed(verified, {code: 'ECONNREFUSED'});
    assert.equal(await service.selectForControl(room), moved);
});

test('endpoint recovery ignores delayed old failures and refuses stale scans or another Sonos room', async () => {
    const old = {id: 'dlna:uuid:rincon_000e58abcdf001400', protocol: 'sonos', host: '192.168.1.25', endpoint: 'http://192.168.1.25/av'};
    const current = {...old, host: '192.168.1.26', endpoint: 'http://192.168.1.26/av'};
    const service = new SpeakerPlayback(() => {});
    service.refreshInBackground = () => {};
    service.rememberControlRooms([old]);
    const revision = ++service.controlRevision;
    service.rememberControlRooms([current]);
    service.controlConnectionFailed(old, {code: 'ECONNRESET'});
    service.rememberControlRooms([old], revision);
    assert.equal(await service.selectForControl(old), current);
    service.refresh = async () => assert.fail('a newer verified endpoint is already available');
    assert.equal(await service.rediscoverSonosEndpoint(old, {code: 'ECONNREFUSED'}), current);
    service.controlConnectionFailed(current, {code: 'ECONNREFUSED'});
    service.rememberControlRooms([current], revision);
    service.pending = Promise.resolve([current]);
    service.verifyControlAddress = async () => undefined;
    await assert.rejects(service.selectForControl(old), /not available/);
    let scans = 0;
    service.pending = null;
    service.refresh = async () => {
        scans++;
        service.rememberControlRooms([{...current, id: 'dlna:uuid:rincon_000e58abcdf101400'}]);
    };
    assert.equal(await service.rediscoverSonosEndpoint(current, {code: 'ECONNREFUSED'}), undefined);
    assert.equal(scans, 1);
});

test('saved Sonos verification coalesces canonical and alias reads, rejects UDN changes and hidden rooms', async () => {
    const id = 'dlna:uuid:rincon_000e58abcdf001400';
    const alias = 'dlna:uuid:rincon_000e58abcdf101400';
    const source = require.resolve('../lib/speaker-playback');
    const loaded = new Module(source, module);
    loaded.filename = source;
    loaded.paths = module.paths;
    let reads = 0, hidden = false, identity = id.slice(5);
    const escaped = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    loaded.require = name => name !== 'node-fetch' ? Module.prototype.require.call(loaded, name) : async url => {
        reads++;
        const own = id.slice('dlna:uuid:'.length).toUpperCase();
        const secondary = alias.slice('dlna:uuid:'.length).toUpperCase();
        const topology = `<ZoneGroupState><ZoneGroups><ZoneGroup Coordinator="${own}">
            <ZoneGroupMember UUID="${own}" Invisible="${hidden ? 1 : 0}" ChannelMapSet="${own}:LF;${secondary}:RF">
            <Satellite UUID="${secondary}"/></ZoneGroupMember></ZoneGroup></ZoneGroups></ZoneGroupState>`;
        return {ok: true, text: async () => url.endsWith('/topology') ?
            `<Envelope><Body><GetZoneGroupStateResponse><ZoneGroupState>${escaped(topology)}</ZoneGroupState></GetZoneGroupStateResponse></Body></Envelope>` :
            `<root><device><deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><manufacturer>Sonos</manufacturer>
            <UDN>${identity}</UDN><friendlyName>Room</friendlyName><serviceList>
            <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service>
            <service><serviceType>urn:schemas-upnp-org:service:ZoneGroupTopology:1</serviceType><controlURL>/topology</controlURL></service>
            </serviceList></device></root>`};
    };
    loaded._compile(fs.readFileSync(source, 'utf8'), source);
    const service = new loaded.exports(() => {}, undefined, undefined, undefined,
        {get: () => [{id, host: '192.168.1.25', aliases: [alias]}]});
    service.refreshInBackground = () => {};
    const [primary, paired] = await Promise.all([service.selectForControl({id}), service.selectForControl({id: alias})]);
    assert.equal(primary, paired);
    assert.equal(primary.id, id);
    assert.equal(reads, 2);
    hidden = true;
    assert.equal(await service.verifyKnownSonos([id]), undefined);
    assert.equal(service.controlRooms.has(id), false);
    hidden = false;
    identity = 'uuid:RINCON_000E58ABCDFF01400';
    assert.equal(await service.verifyKnownSonos([id]), undefined);
});

test('unmanaged Sonos retries only an unconnected first URI write, never a later Play or ambiguous timeout', async () => {
    const source = require.resolve('../lib/speaker-playback');
    const loaded = new Module(source, module);
    loaded.filename = source;
    loaded.paths = module.paths;
    let failAction, failure, calls;
    loaded.require = name => name !== 'node-fetch' ? Module.prototype.require.call(loaded, name) : async (url, options) => {
        const action = /#(\w+)/.exec(options.headers.SOAPAction)[1];
        calls.push({url, action});
        if (action === failAction && url.includes('.25')) throw failure;
        return {ok: true, body: {destroy() {}}};
    };
    loaded._compile(fs.readFileSync(source, 'utf8'), source);
    const old = {id: 'dlna:uuid:rincon_000e58abcdf001400', protocol: 'sonos', host: '192.168.1.25',
        endpoint: 'http://192.168.1.25/av', service: 'urn:schemas-upnp-org:service:AVTransport:1'};
    const moved = {...old, host: '192.168.1.26', endpoint: 'http://192.168.1.26/av'};
    for (const scenario of ['connect', 'timeout', 'reset', 'play']) {
        const service = new loaded.exports(() => {});
        let retries = 0;
        service.rediscoverSonosEndpoint = async () => { retries++; return moved; };
        service.controlConnectionFailed = () => {};
        calls = [];
        failAction = scenario === 'play' ? 'Play' : 'SetAVTransportURI';
        failure = Object.assign(new Error('Disconnected'), scenario === 'connect' ?
            {code: 'ECONNREFUSED', syscall: 'connect'} : scenario === 'timeout' ?
            {type: 'request-timeout'} : {code: 'ECONNRESET', syscall: 'read'});
        const job = service.playSingle(old, {url: 'http://nas/alert.mp3', type: 'audio/mpeg'});
        if (scenario === 'connect') {
            await job;
            assert.deepEqual(calls.map(call => call.action), ['SetAVTransportURI', 'SetAVTransportURI', 'Play']);
        } else {
            await assert.rejects(job, /Disconnected/);
            assert.equal(calls.length, scenario === 'play' ? 2 : 1);
        }
        assert.equal(retries, scenario === 'connect' ? 1 : 0);
    }
});

test('DLNA addresses survive restart and are checked against the advertised renderer identity', async () => {
    const source = require.resolve('../lib/speaker-playback');
    const loaded = new Module(source, module);
    loaded.filename = source;
    loaded.paths = module.paths;
    const id = 'dlna:uuid:renderer';
    const host = '192.168.1.5';
    const location = `http://${host}/desc`;
    let identity = 'renderer';
    let reads = 0;
    loaded.require = name => name !== 'node-fetch' ? Module.prototype.require.call(loaded, name) : async url => {
        assert.equal(url, location);
        reads++;
        return {ok: true, text: async () => `<root><device><UDN>uuid:${identity}</UDN><friendlyName>Renderer</friendlyName>
            <serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
            <controlURL>/av</controlURL></service></serviceList></device></root>`};
    };
    loaded._compile(fs.readFileSync(source, 'utf8'), source);
    const store = new Map();
    const start = () => new loaded.exports(() => {}, undefined, undefined, undefined, store);
    await start().rememberRendererAddresses([{id, host, location, protocol: 'dlna', identity: 'uuid:renderer'}]);
    await start().rememberRendererAddresses([]);
    const restarted = start();
    restarted.pending = new Promise(() => {});
    assert.equal((await restarted.selectForControl({id})).endpoint, `http://${host}/av`);
    await restarted.selectForControl({id});
    assert.equal(reads, 1);
    identity = 'new-device-at-same-address';
    const changed = start();
    const discovered = {id, host: '192.168.1.6', protocol: 'dlna'};
    changed.pending = Promise.resolve([discovered]);
    assert.equal(await changed.selectForControl({id}), discovered);
    assert.equal(reads, 2);
});

test('interactive pickers return saved choices while Flow autocomplete and playback wait for discovery', async () => {
    const saved = [{id: 'cast:one', name: 'Old name', description: 'Google Cast'}];
    const live = {id: 'cast:one', name: 'New name', protocol: 'cast', host: '192.168.1.25'};
    const player = new SpeakerPlayback(() => {}, undefined, undefined, undefined, {get: () => saved});
    let finish;
    let scans = 0;
    player.refresh = () => {
        scans++;
        player.pending = new Promise(resolve => { finish = resolve; }).then(speakers => {
            player.speakers = speakers;
            player.discoveredAt = Date.now();
            player.pending = null;
            return speakers;
        });
        return player.pending;
    };
    let autocompleteDone = false;
    const autocomplete = player.autocomplete('name', false, true).then(result => { autocompleteDone = true; return result; });
    assert.deepEqual(await player.listSpeakers(), saved);
    assert.equal(scans, 1);
    let resolved = false;
    const selecting = player.select({id: live.id}).then(result => { resolved = true; return result; });
    const refreshing = player.listSpeakers(false, true);
    await Promise.resolve();
    assert.equal(resolved, false);
    assert.equal(autocompleteDone, false);
    finish([live]);
    assert.deepEqual(await selecting, live);
    const choices = [{...saved[0], name: live.name}];
    assert.deepEqual(await refreshing, choices);
    assert.deepEqual(await autocomplete, choices);
    assert.deepEqual(await player.autocomplete('name', false, true), choices);
    assert.equal(scans, 1);
});

test('speaker selections preserve aliases, saved group volume rules and TV exclusions', async () => {
    const speakers = [
        {id: 'cast:audio', name: 'Audio', protocol: 'cast'},
        {id: 'cast:tv', name: 'TV', protocol: 'cast', kind: 'tv'},
        {id: 'dlna:uuid:room', name: 'Room', protocol: 'sonos', kind: 'tvSpeaker', aliases: ['dlna:uuid:old']}
    ];
    const saved = [{id: 'group:00000000-0000-0000-0000-000000000001', name: 'Group',
        members: [{id: 'dlna:uuid:old', volumeOffset: -10, maxVolume: 30}]}];
    const player = new SpeakerPlayback(() => {}, undefined, undefined, () => saved);
    player.refresh = async () => speakers;
    player.speakers = speakers;
    player.discoveredAt = Date.now();
    assert.equal((await player.select({id: 'dlna:uuid:old'})).id, 'dlna:uuid:room');
    const group = await player.select({id: saved[0].id});
    assert.equal(group.targets[0].id, 'dlna:uuid:room');
    assert.equal(group.targets[0].maxVolume, 30);
    assert.equal(group.targets[0].volumeOffset, -10);
    assert.equal(group.restrictSonosToTargets, true);
    assert.deepEqual((await player.select({id: 'all_no_tv_speakers'})).targets.map(s => s.id), ['cast:audio']);
    assert.deepEqual((await player.select({id: 'all_no_tvs'})).targets.map(s => s.id),
        ['cast:audio', 'dlna:uuid:room']);
});

test('discovery collapses a bonded Sonos pair and excludes rooms with unverified topology', async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const source = require.resolve('../lib/speaker-playback');
    const loaded = new Module(source, module);
    loaded.filename = source;
    loaded.paths = module.paths;
    const escaped = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const topology = '<ZoneGroupState><ZoneGroups><ZoneGroup Coordinator="RINCON_MAIN">' +
        '<ZoneGroupMember UUID="RINCON_MAIN" ChannelMapSet="RINCON_MAIN:LF;RINCON_SAT:RF">' +
        '<Satellite UUID="RINCON_SAT"/></ZoneGroupMember></ZoneGroup></ZoneGroups></ZoneGroupState>';
    const fetch = async url => {
        const host = new URL(url).hostname;
        if (url.endsWith('/topology')) {
            if (host === '192.168.1.4') return {ok: false, status: 503, body: {destroy() {}}};
            return {ok: true, text: async () => `<Envelope><Body><GetZoneGroupStateResponse><ZoneGroupState>${escaped(topology)}</ZoneGroupState></GetZoneGroupStateResponse></Body></Envelope>`};
        }
        const id = {'192.168.1.2': 'MAIN', '192.168.1.3': 'SAT', '192.168.1.4': 'UNKNOWN'}[host];
        return {ok: true, text: async () => `<root><device>
            <deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType>
            <manufacturer>Sonos</manufacturer><friendlyName>${id}</friendlyName><UDN>uuid:RINCON_${id}</UDN>
            <serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
            <controlURL>/av</controlURL></service><service>
            <serviceType>urn:schemas-upnp-org:service:ZoneGroupTopology:1</serviceType><controlURL>/topology</controlURL>
            </service><service><serviceType>urn:schemas-upnp-org:service:DeviceProperties:1</serviceType>
            <controlURL>/properties</controlURL></service></serviceList>
            <deviceList><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
            <controlURL>/queue</controlURL></service></serviceList></device></deviceList></device></root>`};
    };
    let advertised = true;
    const mocks = {
        'node-fetch': fetch,
        'bonjour-service': {Bonjour: class { find() { return {stop() {}}; } destroy() {} }},
        dgram: {createSocket() {
            const socket = new EventEmitter();
            socket.close = () => {};
            socket.send = query => {
                if (!advertised || !query.includes('ZonePlayer:1')) return;
                ['MAIN', 'SAT', 'UNKNOWN'].forEach((id, i) => {
                    const address = `192.168.1.${i + 2}`;
                    socket.emit('message', Buffer.from(`HTTP/1.1 200 OK\r\nUSN: uuid:RINCON_${id}::x\r\nLOCATION: http://${address}/desc\r\n`), {address});
                });
            };
            return socket;
        }}
    };
    loaded.require = id => Object.hasOwn(mocks, id) ? mocks[id] : Module.prototype.require.call(loaded, id);
    loaded._compile(fs.readFileSync(source, 'utf8'), source);
    const errors = [];
    const player = new loaded.exports((...args) => errors.push(args));
    const result = player.listSpeakers();
    t.mock.timers.tick(2500);
    assert.deepEqual(await result, [{id: 'dlna:uuid:rincon_main', name: 'MAIN (Stereo)', description: 'Sonos'}]);
    const main = await player.select({id: 'dlna:uuid:rincon_sat'});
    assert.equal(main.id, 'dlna:uuid:rincon_main');
    assert.equal(main.directory.endpoint, 'http://192.168.1.2/queue');
    assert.equal(main.properties.endpoint, 'http://192.168.1.2/properties');
    assert(errors.some(args => String(args[0]).includes('topology')));
    advertised = false;
    const refreshed = player.listSpeakers(true);
    t.mock.timers.tick(2500);
    assert.deepEqual(await refreshed, await result);
    assert.equal((await player.select({id: main.id})).id, main.id);
});
