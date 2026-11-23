'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const SpeakerPlayback = require('../lib/speaker-playback');
const {features, capabilities, values} = require('../lib/speaker-device');

test('speaker capabilities follow protocol and observed support, and stay once seen', () => {
    assert.deepEqual(capabilities(features('dlna')), ['speaker_playing', 'speaker_stop', 'speaker_track',
        'speaker_artist', 'speaker_album', 'speaker_position', 'speaker_duration']);
    assert.ok(capabilities(features('sonos')).includes('speaker_shuffle'));
    assert.ok(capabilities(features('cast')).includes('speaker_next'));

    const seen = features('dlna', {volume: 0.3, muted: false, actions: {next: true}});
    assert.deepEqual([seen.volume, seen.mute, seen.navigate], [true, true, true]);
    const idle = features('dlna', {volume: null, muted: null, actions: {}}, seen);
    assert.ok(capabilities(idle).includes('volume_set'));
    assert.ok(capabilities(idle).includes('speaker_prev'));
});

test('speaker values use seconds and leave unknown audio values untouched', () => {
    assert.deepEqual(values({playing: true, track: 'T', position: 61500, duration: 225400, volume: 0.333,
        repeat: 'bogus', muted: undefined}), {
        speaker_playing: true, speaker_track: 'T', speaker_artist: '', speaker_album: '',
        speaker_position: 62, speaker_duration: 225, speaker_shuffle: false, speaker_repeat: 'none',
        volume_set: 0.33, volume_mute: null
    });
});

test('paired speaker devices keep their Homey name and stay selectable when not discovered', () => {
    const playback = new SpeakerPlayback(() => {});
    playback.paired = () => [{id: 'cast:a', name: 'Living room', protocol: 'cast'},
        {id: 'dlna:uuid:b', name: 'Bedroom TV', protocol: 'dlna'}];
    assert.deepEqual(playback.withPaired([{id: 'cast:a', name: 'Nest Audio', description: 'Google Cast'},
        {id: 'cast:c', name: 'Attic', description: 'Google Cast'}]), [
        {id: 'cast:c', name: 'Attic', description: 'Google Cast'},
        {id: 'dlna:uuid:b', name: 'Bedroom TV', description: 'UPnP / DLNA'},
        {id: 'cast:a', name: 'Living room', description: 'Google Cast'}
    ]);
    playback.paired = () => { throw new Error('driver not ready'); };
    assert.deepEqual(playback.withPaired([{id: 'x', name: 'X', description: ''}]), [{id: 'x', name: 'X', description: ''}]);
});

test('paired speaker devices stay listed when discovery fails', async () => {
    const playback = new SpeakerPlayback(() => {});
    playback.discoveredSpeakers = async () => { throw new Error('Unable to discover speakers on the local network.'); };
    playback.paired = () => [{id: 'dlna:uuid:b', name: 'Bedroom TV', protocol: 'dlna'}];
    assert.deepEqual(await playback.listSpeakers(true), [{id: 'dlna:uuid:b', name: 'Bedroom TV', description: 'UPnP / DLNA'}]);
    assert.deepEqual((await playback.autocomplete('bedroom')).map(item => item.id), ['dlna:uuid:b']);
    playback.paired = () => [];
    await assert.rejects(playback.listSpeakers(true), /Unable to discover/);
});

function samsungDevice(store) {
    const Module = require('node:module');
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        return request === 'homey' ? 'homey-stub' : resolve.call(this, request, ...rest);
    };
    require.cache['homey-stub'] = {id: 'homey-stub', filename: 'homey-stub', loaded: true, exports: {Device: class {}}};
    let SpeakerDevice;
    try { SpeakerDevice = require('../drivers/playbackdevice/device'); }
    finally { Module._resolveFilename = resolve; }
    const device = Object.create(SpeakerDevice.prototype);
    const values = {onoff: true};
    Object.assign(device, {
        speakerId: 'dlna:uuid:frame', available: true, store: {kind: 'tv', protocol: 'dlna', ...store},
        homey: {__: key => key, setTimeout: callback => setImmediate(callback), clearTimeout() {},
            app: {speakerPlayback: {speakerInfo: () => ({host: '192.168.1.61', model: 'QE49LS03', samsung: true})}}},
        getStoreValue(key) { return this.store[key]; },
        async setStoreValue(key, value) { this.store[key] = value; },
        hasCapability: capability => capability in values,
        getCapabilityValue: capability => values[capability],
        async setCapabilityValue(capability, value) { values[capability] = value; },
        async addCapability(capability) { values[capability] = null; },
        async setCapabilityOptions(capability, options) { this.options = {...this.options, [capability]: options}; },
        registerListeners() {},
        getAvailable() { return this.available; },
        async setAvailable() { this.available = true; },
        async setUnavailable() { this.available = false; },
        scheduleRefresh() {},
        log() {}, error() {}
    });
    return {device, values};
}

test('Samsung TV power uses the remote power key and stores the token the TV issues', async () => {
    const samsung = require('../lib/samsung-tv');
    const original = {...samsung};
    const keys = [];
    try {
        const lookups = [];
        samsung.describe = async (host, expected) => {
            lookups.push(expected);
            return expected.model === 'QE49LS03' || expected.id === 'uuid:remote'
                ? {id: 'uuid:remote', power: 'on', frame: true, mac: 'd4:9d:c0:2f:e0:1d'} : null;
        };
        samsung.artMode = async () => false;
        samsung.sendKey = async (host, token, key) => { keys.push([host, token, key]); return 'issued'; };
        const {device} = samsungDevice({samsungToken: 'old'});
        await device.setPower(true);
        assert.deepEqual(keys, []);
        await device.setPower(false);
        assert.deepEqual(keys, [['192.168.1.61', 'old', 'KEY_POWER']]);
        assert.equal(device.store.samsungToken, 'issued');
        assert.deepEqual(device.store.samsung, {id: 'uuid:remote', host: '192.168.1.61', mac: 'd4:9d:c0:2f:e0:1d', frame: true});
        // The renderer UUID differs from the TV's remote ID: match the model once, then require the stored ID.
        assert.deepEqual(lookups, [{model: 'QE49LS03'}, {id: 'uuid:remote'}]);

        // Art mode on a Frame counts as off; switching on leaves art mode with the same key.
        samsung.artMode = async () => true;
        await device.setPower(true);
        assert.equal(keys.length, 2);
    } finally {
        Object.assign(samsung, original);
    }
});

test('an unreadable Frame art status keeps its stored power and treats manual power as the remote button', async () => {
    const samsung = require('../lib/samsung-tv');
    const original = {...samsung};
    const keys = [];
    try {
        samsung.describe = async () => ({id: 'uuid:remote', power: 'on', frame: true, mac: 'd4:9d:c0:2f:e0:1d'});
        samsung.artMode = async () => null;
        samsung.sendKey = async (host, token, key) => { keys.push(key); };
        const {device, values} = samsungDevice({samsungToken: 'token', samsung: {id: 'uuid:remote', host: '192.168.1.61'}});
        values.onoff = false;
        await device.refreshPower();
        assert.equal(values.onoff, false);
        for (const requested of [false, true]) {
            await device.setPower(requested);
            values.onoff = requested; // Homey stores the requested value after the listener.
            await new Promise(setImmediate);
            assert.equal(values.onoff, false);
        }
        assert.deepEqual(keys, ['KEY_POWER', 'KEY_POWER']);
        assert.equal(await device.autoPowerOn(), false);
        assert.equal(keys.length, 2);
    } finally {
        Object.assign(samsung, original);
    }
});

test('a switched-off Samsung TV is woken repeatedly until it reports on and stays available', async () => {
    const samsung = require('../lib/samsung-tv');
    const original = {...samsung};
    const wakes = [];
    let answers = [null, null, {power: 'standby'}, {power: 'on'}];
    try {
        samsung.describe = async () => answers.shift() ?? null;
        samsung.wake = async (host, mac) => { wakes.push([host, mac]); };
        samsung.sendKey = async () => assert.fail('A switched-off TV must not receive keys.');
        const {device, values} = samsungDevice({samsung: {id: 'uuid:remote', host: '192.168.1.61', mac: 'd4:9d:c0:2f:e0:1d', frame: true}});
        await device.setPower(true);
        assert.equal(wakes.length, 3);
        assert.ok(wakes.every(([host, mac]) => host === '192.168.1.61' && mac === 'd4:9d:c0:2f:e0:1d'));

        answers = [];
        device.available = false;
        device.powerCheckedAt = 0;
        await device.refreshPower();
        assert.equal(values.onoff, false);
        assert.equal(device.available, true);
    } finally {
        Object.assign(samsung, original);
    }
});

test('slow TV power commands finish in the background, fast failures are reported', async () => {
    const {device} = samsungDevice({});
    const logged = [];
    device.error = (...args) => logged.push(args.join(' '));
    await assert.rejects(device.settle(Promise.reject(new Error('denied'))), /denied/);
    let fail;
    await device.settle(new Promise((resolve, reject) => { fail = reject; }));
    fail(new Error('late'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(logged, ['TV power command failed: late']);
});


test('Samsung TV inputs become media_input values and are selected with their remote keys', async () => {
    const samsung = require('../lib/samsung-tv');
    const original = {...samsung};
    const keys = [];
    let power = 'on';
    try {
        samsung.describe = async () => ({id: 'uuid:remote', power, frame: false, mac: 'd4:9d:c0:2f:e0:1d'});
        samsung.sendKey = async (host, token, key) => { keys.push(key); return token; };
        const {device} = samsungDevice({samsungToken: 'token', samsung: {id: 'uuid:remote', host: '192.168.1.61'}});
        await device.describeTv();
        assert.deepEqual(device.options.media_input.values.map(item => item.id), ['tv', 'hdmi_1', 'hdmi_2', 'hdmi_3', 'hdmi_4']);
        assert.equal(device.options.media_input.values[0].title, 'speakerDevice.inputs.samsung_tv');
        await device.selectInput('hdmi_2');
        assert.deepEqual(keys, ['KEY_HDMI2']);
        await assert.rejects(device.selectInput('component'), /unsupported/);
        power = 'standby';
        await assert.rejects(device.selectInput('tv'), /tvOff/);
        assert.deepEqual(keys, ['KEY_HDMI2']);
    } finally {
        Object.assign(samsung, original);
    }
});
test('announcement auto-power only switches on confirmed-off TVs and switches off only what it switched on', async () => {
    const samsung = require('../lib/samsung-tv');
    const autoPower = require('../lib/auto-power');
    const {DirectSpeakerSession} = require('../lib/direct-speaker-session');
    const original = {...samsung};
    const keys = [];
    try {
        let power = null;
        samsung.describe = async () => power && {id: 'uuid:remote', power, frame: false};
        samsung.wake = async () => { power = power === null ? 'standby' : 'on'; };
        samsung.sendKey = async (host, token, key) => { keys.push(key); power = null; };
        const {device: off} = samsungDevice({samsung: {id: 'uuid:remote', host: '192.168.1.61', mac: 'd4:9d:c0:2f:e0:1d'}});
        const {device: unknown} = samsungDevice({});
        unknown.speakerId = 'dlna:uuid:frame-unknown';
        unknown.readPower = async () => ({tv: {power: 'on', frame: true}, on: null});
        unknown.setPower = async () => assert.fail('An unknown power state must never be switched.');
        const {device: ignored} = samsungDevice({});
        ignored.speakerId = 'dlna:uuid:not-flagged';
        const settings = {all: false};
        const homey = {
            setTimeout: callback => setImmediate(callback),
            settings: {get: () => settings.all},
            drivers: {getDriver: id => ({getDevices: () => id === 'playbackdevice' ? [off, unknown, ignored] : []})},
            app: {speakerPlayback: {
                speakers: [],
                groups: () => [{id: 'group:00000000-0000-0000-0000-000000000001', members: [
                    {id: 'dlna:uuid:frame', autoPower: true}, {id: 'dlna:uuid:frame-unknown', autoPower: true},
                    {id: 'dlna:uuid:not-flagged'}]}],
                refresh: async () => [{id: 'dlna:uuid:frame'}],
                speakerInfo: () => ({host: '192.168.1.61'})
            }}
        };
        for (const device of [off, unknown, ignored]) {
            device.homey = {...device.homey, ...homey, app: homey.app};
            device.getSetting = () => false;
        }
        assert.deepEqual(autoPower.candidates(homey, {id: 'all'}), []);
        assert.deepEqual(autoPower.candidates(homey, {id: 'dlna:uuid:frame'}), []);
        settings.all = true;
        assert.equal(autoPower.candidates(homey, {id: 'all'}).length, 3);
        assert.deepEqual(autoPower.candidates(homey, {id: 'all_no_tvs'}), []);
        assert.deepEqual(autoPower.candidates(homey, {id: 'all_no_tv_speakers'}), []);
        settings.all = false;

        const order = [];
        const session = new DirectSpeakerSession({playback: {}, device: {getData: () => ({id: 'p'})}});
        await session.withPower(() => autoPower.prepare(homey, {id: 'group:00000000-0000-0000-0000-000000000001'}),
            async () => order.push(`play:${power}`));
        assert.deepEqual(order, ['play:on']);
        assert.deepEqual(keys, ['KEY_POWER']);

        // A TV that was already on is left on afterwards.
        keys.length = 0;
        power = 'on';
        await session.withPower(() => autoPower.prepare(homey, {id: 'group:00000000-0000-0000-0000-000000000001'}),
            async () => {});
        assert.deepEqual(keys, []);

        // An unreachable TV that answers already on was never confirmed off, so it is left on afterwards.
        power = null;
        samsung.wake = async () => { power = 'on'; };
        await session.withPower(() => autoPower.prepare(homey, {id: 'group:00000000-0000-0000-0000-000000000001'}),
            async () => {});
        assert.equal(power, 'on');
        assert.deepEqual(keys, []);

        // A Frame that wakes only to standby gets one Power press after two standby reads, and is switched off afterwards.
        power = null;
        samsung.wake = async () => { if (power === null) power = 'standby'; };
        samsung.sendKey = async (host, token, key) => { keys.push(key); power = power === 'standby' ? 'on' : null; };
        const played = [];
        await session.withPower(() => autoPower.prepare(homey, {id: 'group:00000000-0000-0000-0000-000000000001'}),
            async () => played.push(power));
        assert.deepEqual(played, ['on']);
        assert.deepEqual(keys, ['KEY_POWER', 'KEY_POWER']);
        assert.equal(power, null);
    } finally {
        Object.assign(samsung, original);
    }
});
