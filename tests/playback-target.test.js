'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const registerPlayerSetup = require('../drivers/upnpplayer/player-setup');
const widget = require('../widgets/media/api');

const group = {id: 'group:room', name: 'Group', description: 'Speakers', extra: 'canonical data'};
const offline = {id: 'cast:offline', name: 'Offline'};

function fixture() {
    const calls = [];
    const store = {announcement_speaker: offline, unowned: 'keep'};
    const settings = {ip: '192.0.2.1:8080', delay: 2000, silentPause: true, recentFolderLimit: 5};
    const homey = {
        __: key => key,
        i18n: {getLanguage: () => 'en'},
        app: {speakerPlayback: {autocomplete: async (...args) => { calls.push(args); return [group]; }}, error() {}},
        drivers: {getDriver: () => ({getDevices: () => [device]})}
    };
    const device = {
        homey,
        getData: () => ({id: 'media'}),
        getName: () => 'Media',
        getAvailable: () => true,
        getCapabilityValue: () => null,
        getSetting: id => settings[id],
        setSettings: async values => Object.assign(settings, values),
        getStoreValue: key => store[key],
        setStoreValue: async (key, value) => { store[key] = value; },
        playlistManager: {playing: true, async setPlaybackTarget(value) {
            calls.push(['apply', value, store.ump_current_speaker ?? store.announcement_speaker]);
        }}
    };
    const handlers = {};
    const session = {setHandler: (event, handler) => { handlers[event] = handler; }};
    const driver = {homey, error() {}};
    const control = (action, input) => widget.control({homey, body: {player: 'media', action, ...input}});
    return {calls, store, settings, device, session, handlers, driver, control};
}

test('pair decorates discovered media servers with opt-in settings and the canonical target', async () => {
    const {driver, session, handlers, calls} = fixture();
    const decorate = registerPlayerSetup(driver, session);
    const media = {name: 'Media', data: {id: 'media'}, settings: {ip: '192.0.2.1:8080', delay: 1200, unrelated: true}};
    const [defaults] = decorate([media]);
    assert.equal(defaults.store.announcement_speaker, null);
    assert.equal(defaults.settings.trigger_when_announcing, false);
    assert.equal(defaults.settings.announcement_resume, true);
    assert.equal(defaults.settings.delay, 1200);
    await handlers.save_player_setup({settings: {delay: 1340, announcement_resume: false}, speaker: group.id});
    const [result] = decorate([media]);
    assert.equal(result.data, media.data);
    assert.deepEqual(result.settings, {...defaults.settings, delay: 1340, announcement_resume: false});
    assert.deepEqual(result.store.announcement_speaker, group);
    assert.deepEqual(calls, [['', false]]);
});

test('repair retains an offline default and existing media-server settings and rejects attempts to change the server', async () => {
    const {driver, device, session, handlers, settings, store, calls} = fixture();
    registerPlayerSetup(driver, session, device);
    await assert.rejects(handlers.save_player_setup({settings: {ip: '192.0.2.2:8080'}, speaker: null}), /invalid_settings/);
    await handlers.save_player_setup({settings: {trigger_when_announcing: true}, speaker: offline.id});
    assert.equal(store.announcement_speaker, offline);
    assert.deepEqual(settings, {
        ip: '192.0.2.1:8080', delay: 2000, silentPause: true, recentFolderLimit: 5, trigger_when_announcing: true
    });
    assert.deepEqual(calls, []);
});

test('pairing and repair default to temporary Sonos grouping and preserve an explicit opt-out', async () => {
    const pair = fixture();
    const decorate = registerPlayerSetup(pair.driver, pair.session);
    const config = pair.handlers.get_player_setup();
    assert.equal(config.settings.announcement_group_sonos, true);
    assert.equal(config.fields.find(field => field.id === 'announcement_group_sonos').type, 'checkbox');
    await pair.handlers.save_player_setup({settings: {announcement_group_sonos: false}, speaker: null});
    assert.equal(decorate([{}])[0].settings.announcement_group_sonos, false);

    const repair = fixture();
    registerPlayerSetup(repair.driver, repair.session, repair.device);
    assert.equal(repair.handlers.get_player_setup().settings.announcement_group_sonos, true);
    await assert.rejects(repair.handlers.save_player_setup({settings: {announcement_group_sonos: 'false'}, speaker: offline.id}), /invalid_settings/);
    await repair.handlers.save_player_setup({settings: {announcement_group_sonos: false}, speaker: offline.id});
    await repair.handlers.save_player_setup({settings: {announcement_resume: false}, speaker: offline.id});
    assert.equal(repair.settings.announcement_group_sonos, false);
    assert.deepEqual(repair.calls, []);
});

test('failed repair handover restores settings and the default without altering the media-server pairing', async () => {
    const {driver, device, session, handlers, store, settings} = fixture();
    registerPlayerSetup(driver, session, device);
    device.playlistManager.setPlaybackTarget = async selection => {
        assert.equal(selection, null);
        assert.equal(store.announcement_speaker, group);
        throw new Error('handover failed');
    };
    await assert.rejects(handlers.save_player_setup({settings: {delay: 1800}, speaker: group.id}), /handover failed/);
    assert.equal(store.announcement_speaker, offline);
    assert.equal(settings.delay, 2000);
    assert.equal(settings.ip, '192.0.2.1:8080');
});

test('widget lists shared targets, applies a canonical override, and resets to the device default', async () => {
    const {control, calls, store} = fixture();
    const {targets} = await control('listTargets', {fresh: true});
    assert.deepEqual(targets, [{id: group.id, name: group.name, description: group.description}]);
    await assert.rejects(control('setTarget', {value: 'fake'}), /targets.invalid/);
    const {player} = await control('setTarget', {value: group.id});
    assert.equal(store.ump_current_speaker, group);
    assert.equal(player.currentTarget.id, group.id);
    assert.equal(player.defaultTarget.id, offline.id);
    await control('setTarget', {value: null});
    assert.equal(store.ump_current_speaker, null);
    assert.deepEqual(calls, [['', true], ['', false], ['', true], ['', false], ['apply', group, group], ['apply', null, offline]]);
});

test('widget fails explicitly and restores the store if active playback cannot change target', async () => {
    const {control, device, store} = fixture();
    for (const apply of [async () => false, async () => { throw new Error('speaker failed'); }, undefined]) {
        device.playlistManager.setPlaybackTarget = apply;
        await assert.rejects(control('setTarget', {value: group.id}), /targets.apply_failed|speaker failed/);
        assert.equal(store.ump_current_speaker, null);
        assert.equal(store.announcement_speaker, offline);
    }
});
