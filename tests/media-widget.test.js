'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const widget = require('../widgets/media/api');
const {reportVolume, stepVolume} = require('../lib/speaker-volume');
const {notifyWidget} = require('../lib/widget-updates');

function fixture() {
    const calls = [];
    const values = {speaker_track: 'Track <one>', speaker_artist: 'Artist', speaker_album: 'Album'};
    const playlist = {
        currentFile: {name: 'Track <one>', artist: 'Artist', album: 'Album', duration: 123000},
        files: [{}, {}],
        mode: 'randomrepeat',
        image: {id: 'image-id'},
        _albumUrl: 'http://private-server/art.jpg',
        playing: true,
        TogglePlay: async value => {calls.push(['play', value]); return true;},
        Stop: async () => {calls.push(['stop']); playlist.playing = false;},
        Pause: async () => {calls.push(['pause']); playlist.playing = false; playlist.paused = true;},
        PlayNext: async () => {calls.push(['next']);},
        PlayPrevious: async () => {calls.push(['previous']);},
        SetShuffle: value => {calls.push(['shuffle', value]);},
        SetRepeat: value => {calls.push(['repeat', value]);}
    };
    const player = {
        getData: () => ({id: 'player-id'}),
        getName: () => 'UPnP Player',
        getAvailable: () => true,
        getCapabilityValue: id => values[id],
        setCapabilityValue: async (id, value) => {values[id] = value;},
        playlistManager: playlist
    };
    const homey = {
        __: key => key,
        app: {widgetHomeyId: 'homey-id', error: () => {}},
        drivers: {getDriver: id => {
            assert.equal(id, 'upnpplayer');
            return {getDevices: () => [player]};
        }}
    };
    player.homey = homey;
    player.driver = {Triggers: {mute_requested: {Card: {trigger: async (device, tokens) => {
        assert.equal(device, player);
        calls.push(['mute_requested', tokens]);
    }}}}};
    return {homey, player, playlist, calls, values};
}

test('source preferences are isolated per widget and do not send playback commands', async () => {
    const {homey, calls} = fixture();
    const settings = new Map();
    homey.settings = {get: key => settings.get(key), set: (key, value) => settings.set(key, value)};
    const request = (instance, action, source) => widget.control({homey, body: {widget: instance, action, source}});
    const source = {kind: 'speaker', id: 'dlna:uuid:test-speaker'};
    await request('widget-1', 'saveSourcePreference', source);
    assert.deepEqual(await request('widget-1', 'getSourcePreference'), {source});
    assert.deepEqual(await request('widget-2', 'getSourcePreference'), {source: null});
    await request('widget-1', 'saveSourcePreference', {kind: 'player', id: 'player-id'});
    assert.deepEqual(await request('widget-1', 'getSourcePreference'), {source: {kind: 'player', id: 'player-id'}});
    await assert.rejects(request('widget-1', 'saveSourcePreference', {kind: 'player', id: 'unknown'}), /invalidAction/);
    assert.deepEqual(calls, []);
});

test('widget exposes app player state and HTTPS artwork without leaking the source URL', async () => {
    const {homey} = fixture();
    const result = await widget.getState({homey, query: {player: 'player-id'}});
    assert.equal(result.player.track, 'Track <one>');
    assert.equal(result.player.duration, 123000);
    assert.match(result.player.artwork, /^https:\/\/homey-id\.connect\.athom\.com\/api\/image\/image-id\?v=[a-f0-9]{16}$/);
    assert.equal(result.player.canNavigate, true);
    assert(!JSON.stringify(result).includes('private-server'));
});

test('missing or unavailable player keeps the player list usable', async () => {
    const {homey, player} = fixture();
    for (const id of ['deleted-player', 'player-id']) {
        if (id === 'player-id') player.getAvailable = () => false;
        const result = await widget.getState({homey, query: {player: id}});
        assert.equal(result.players.length, 1);
        assert.equal(result.player, null);
        assert.equal(Boolean(result.error), Boolean(id));
    }
});

test('widget exposes the last track, folder and estimated position even when stopped', async () => {
    const {homey, playlist} = fixture();
    const path = [{id: 'music', name: 'Music'}, {id: 'album', name: 'Album'}];
    playlist.folder = {id: 'album', libraryPath: path};
    playlist.currentFile = {id: 'track', name: 'Track'};
    const request = {homey, query: {player: 'player-id'}};
    const selection = {
        path, folder: true, file: {id: 'track', name: 'Track'}
    };
    assert.deepEqual((await widget.getState(request)).player.selection, selection);
    playlist.playing = false;
    playlist.position = 23000;
    const {player} = await widget.getState(request);
    assert.deepEqual(player.selection, selection);
    assert.equal(player.position, 23000);
    assert.equal(player.playing, false);
    await assert.rejects(widget.control({homey, body: {player: 'player-id', action: 'seek', value: 1000}}),
        /playback.seekUnsupported/);
});

test('speaker interruption is distinguished from an ordinary pause', async () => {
    const {homey, playlist} = fixture();
    playlist.playing = false;
    playlist.paused = true;
    assert.equal((await widget.getState({homey, query: {player: 'player-id'}})).player.interrupted, false);
    playlist.restartOnSpeakerResume = true;
    assert.equal((await widget.getState({homey, query: {player: 'player-id'}})).player.interrupted, true);
    playlist.paused = false;
    assert.equal((await widget.getState({homey, query: {player: 'player-id'}})).player.interrupted, false);
});

test('a queued track from another folder reveals its own Library path', async () => {
    const {homey, playlist} = fixture();
    playlist.folder = {id: 'first', libraryPath: [{id: 'first', name: 'First'}]};
    playlist.currentFile = {id: 'track', name: 'Track', libraryPath: [{id: 'other', name: 'Other'}]};
    const {player} = await widget.getState({homey, query: {player: 'player-id'}});
    assert.deepEqual(player.selection, {
        path: [{id: 'other', name: 'Other'}], folder: false, file: {id: 'track', name: 'Track'}
    });
});

test('widget controls call playlist methods and update shuffle/repeat capabilities', async () => {
    const {homey, calls, values} = fixture();
    for (const [action, value] of [['play'], ['pause'], ['stop'], ['previous'], ['next'], ['shuffle', true], ['repeat', 'playlist']]) {
        await widget.control({homey, body: {player: 'player-id', action, value}});
    }
    assert.deepEqual(calls, [['play', true], ['pause'], ['stop'], ['previous'], ['next'], ['shuffle', true], ['repeat', 'playlist']]);
    assert.equal(values.speaker_shuffle, true);
    assert.equal(values.speaker_repeat, 'playlist');
});

test('widget rejects invalid actions, values and players without issuing playback', async () => {
    const {homey, calls} = fixture();
    for (const body of [
        {player: 'unknown', action: 'play'},
        {player: 'player-id', action: 'setUrl'},
        {player: 'player-id', action: 'shuffle', value: 'true'},
        {player: 'player-id', action: 'repeat', value: 'track'}
    ]) await assert.rejects(widget.control({homey, body}));
    assert.deepEqual(calls, []);
});

test('idle volume updates the native capability and only unmute dispatches a custom trigger', async () => {
    const {homey, playlist, calls} = fixture();
    playlist.currentFile = undefined;
    const control = (action, value) => widget.control({homey, body: {player: 'player-id', action, value}});
    for (const value of [-0.01, 1.01, NaN, '0.5', null]) {
        await assert.rejects(control('volume', value), /widget.invalidAction/);
    }
    await assert.rejects(control('mute', 'false'), /widget.invalidAction/);
    assert.deepEqual(calls, []);
    assert.equal((await control('volume', 0)).player.volume, 0);
    assert.equal((await control('mute', false)).player.muted, false);
    assert.deepEqual(calls, [['mute_requested', {muted: false}]]);
});

test('speaker feedback updates widget state without dispatching requests or touching omitted values', async () => {
    const {homey, player, calls, values} = fixture();
    await reportVolume(player, {volume: 0.42, muted: true});
    await reportVolume(player, {muted: 'false'});
    await assert.rejects(reportVolume(player, {volume: 0.1, muted: 'invalid'}), /widget.invalidAction/);
    await assert.rejects(reportVolume(player, {}), /widget.invalidAction/);
    const state = await widget.getState({homey, query: {player: 'player-id'}});
    assert.equal(state.player.volume, 0.42);
    assert.equal(state.player.muted, false);
    assert.equal(values.volume_set, 0.42);
    assert.deepEqual(calls, []);
});

test('speaker feedback notifies widgets after applying changes, but not for unchanged reports', async () => {
    const {homey, player, calls, values} = fixture();
    const updates = [];
    homey.api = {realtime: async (event, payload) => {
        updates.push({event, payload, volume: values.volume_set, muted: values.volume_mute});
    }};
    await reportVolume(player, {volume: 0.42, muted: true});
    await new Promise(resolve => setImmediate(resolve));
    await reportVolume(player, {volume: 0.42, muted: true});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(updates, [{
        event: 'media_state_changed', payload: {player: 'player-id'}, volume: 0.42, muted: true
    }]);
    assert.deepEqual(calls, []);
});

test('a player rename refreshes all source lists even when coalesced with playback changes', async () => {
    const {homey, player} = fixture();
    const updates = [];
    homey.api = {realtime: async (event, payload) => updates.push({event, payload})};
    notifyWidget(player);
    notifyWidget(player, true);
    notifyWidget(player);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(updates, [{
        event: 'media_state_changed', payload: {player: 'player-id', playersChanged: true}
    }]);
    player.getName = () => 'Renamed player';
    const state = await widget.getState({homey, query: {player: 'player-id'}});
    assert.equal(state.players[0].name, 'Renamed player');
    assert.equal(state.player.name, 'Renamed player');
});

test('the device rename hook notifies widgets without requiring playback', async () => {
    const fs = require('node:fs');
    const vm = require('node:vm');
    const filename = require.resolve('../drivers/upnpplayer/device');
    const localRequire = require('node:module').createRequire(filename);
    const module = {exports: {}};
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module,
        require: id => id === 'homey' ? {Device: class {}} : localRequire(id)
    }, {filename});
    const device = new module.exports();
    const updates = [];
    device.log = () => {};
    device.getData = () => ({id: 'renamed-player'});
    device.homey = {api: {realtime: async (event, payload) => updates.push({event, payload})}};
    device.error = (...args) => assert.fail(args.join(' '));
    await device.onRenamed('New name');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(updates, [{
        event: 'media_state_changed', payload: {player: 'renamed-player', playersChanged: true}
    }]);
});

test('volume steps use the current volume, clamp to 0–100%, and never change mute', async () => {
    const {player, calls, values} = fixture();
    await reportVolume(player, {volume: 0.43, muted: true});
    await stepVolume(player, 1);
    assert.equal(values.volume_set, 0.48);
    await stepVolume(player, -1);
    assert.equal(values.volume_set, 0.43);
    for (const [volume, direction, expected] of [[0.98, 1, 1], [0.02, -1, 0]]) {
        await reportVolume(player, {volume});
        await stepVolume(player, direction);
        assert.equal(values.volume_set, expected);
    }
    player.setCapabilityValue = async () => assert.fail('Volume already at the limit');
    await stepVolume(player, -1);
    assert.equal(values.volume_mute, true);
    assert.deepEqual(calls, []);
});

test('volume step refuses to send an absolute volume before the current value is known', async () => {
    const {player, values} = fixture();
    await assert.rejects(stepVolume(player, 1), /playback.volumeUnknown/);
    assert.equal(values.volume_set, undefined);
});

test('widget volume buttons use five-point steps and leave mute unchanged', async () => {
    const {homey, values} = fixture();
    values.volume_set = 0.43;
    values.volume_mute = true;
    const control = action => widget.control({homey, body: {player: 'player-id', action}});
    assert.equal((await control('volumeDown')).player.volume, 0.38);
    assert.equal((await control('volumeUp')).player.volume, 0.43);
    assert.equal(values.volume_mute, true);
});

test('widget volume buttons accept a per-widget step and reject invalid steps without changing volume', async () => {
    const {homey, values} = fixture();
    values.volume_set = 0.43;
    const control = (action, step) => widget.control({homey, body: {player: 'player-id', action, step}});
    assert.equal((await control('volumeUp', 10)).player.volume, 0.53);
    assert.equal((await control('volumeDown', 2.5)).player.volume, 0.505);
    assert.equal((await control('volumeUp', 2.5)).player.volume, 0.53);
    assert.equal((await control('volumeDown', 2.5)).player.volume, 0.505);
    for (const step of [0, -1, 101, '10', null]) {
        await assert.rejects(control('volumeUp', step), /widget.invalidAction/);
    }
    assert.equal(values.volume_set, 0.505);
    assert.equal((await control('volumeUp', 100)).player.volume, 1);
    assert.equal((await control('volumeDown', 100)).player.volume, 0);
});

test('widget handles idle playback and unhandled URL Flows explicitly', async () => {
    const {homey, playlist} = fixture();
    playlist.TogglePlay = async () => false;
    await assert.rejects(widget.control({homey, body: {player: 'player-id', action: 'play'}}), /widget.noPlayback/);
    playlist.currentFile = undefined;
    for (const action of ['play', 'next', 'previous']) {
        await assert.rejects(widget.control({homey, body: {player: 'player-id', action}}));
    }
    const {player} = await widget.getState({homey, query: {player: 'player-id'}});
    assert.equal(player.canPlay, false);
    assert.equal(player.canNavigate, false);
    assert.equal(player.duration, 0);
});

test('widget browses a page and resolves exact file and folder IDs for playback', async () => {
    const {homey, player, playlist} = fixture();
    const file = {id: 'file', name: 'Same title', url: 'http://server/track.mp3'};
    const folder = {id: 'folder', name: 'Same title :[folder]', realName: 'Same title'};
    player.server = {
        async browseById(args) {
            assert.deepEqual(args, {id: 'parent', search: 'folders,files', page: {offset: 50, size: 50}});
            return {items: [file, folder], next: 52};
        }
    };
    const page = await widget.browse({homey, body: {player: 'player-id', folder: 'parent', offset: 50}});
    assert.deepEqual(page, {items: [
        {id: 'file', name: 'Same title', folder: false, playable: true, offset: 50, size: 50},
        {id: 'folder', name: 'Same title', folder: true, playable: false, offset: 50, size: 50}
    ], next: 52});
    playlist.PlayFile = async (_, resolve) => {
        assert.deepEqual(await resolve(), {...file, libraryPath: [{id: 'parent', name: 'Music'}]});
        return true;
    };
    playlist.PlayFolder = async ({mode}, resolve) => {
        assert.equal(mode, 'randomrepeat');
        assert.deepEqual(await resolve(), {...folder, libraryPath: [
            {id: 'parent', name: 'Music'}, {id: 'folder', name: 'Same title', offset: 50}
        ]});
        return true;
    };
    const body = {player: 'player-id', folder: 'parent', offset: 50, path: [{id: 'parent', name: 'Music'}]};
    await widget.control({homey, body: {...body, action: 'playFile', item: 'file'}});
    await widget.control({homey, body: {...body, action: 'playFolder', item: 'folder'}});
    playlist.PlayFolder = async ({mode, startFile}, resolve) => {
        assert.equal(mode, 'randomrepeat');
        assert.equal(startFile, 'file');
        assert.deepEqual(await resolve(), {id: 'parent', libraryPath: [{id: 'parent', name: 'Music'}]});
        return true;
    };
    await widget.control({homey, body: {...body, action: 'playFrom', item: 'file'}});
    playlist.PlayFolder = async (_, resolve) => resolve();
    await assert.rejects(widget.control({homey, body: {...body, action: 'playFrom', item: 'missing'}}),
        /playback.missingFile/);
    await assert.rejects(widget.browse({homey, body: {...body, offset: -50}}), /widget.invalidAction/);
});

test('folder filtering scans unloaded pages and resumes from the next matching entry', async () => {
    const {homey, player} = fixture();
    const entries = Array.from({length: 17}, (_, i) => ({
        id: String(i), name: i % 3 === 0 ? `Match ${i}` : `Other ${i}`, url: `http://server/${i}`
    }));
    const offsets = [];
    player.server = {browseById: async ({page}) => {
        offsets.push(page.offset);
        assert.equal(page.size, 2);
        return {items: entries.slice(page.offset, page.offset + page.size),
            next: page.offset + page.size < entries.length ? page.offset + page.size : null};
    }};
    const body = {player: 'player-id', folder: 'parent', size: 2, filter: 'MATCH'};
    const first = await widget.browse({homey, body});
    assert.deepEqual(first.items.map(item => item.id), ['0', '3']);
    assert.deepEqual(first.next, {offset: 6, skip: 0});
    const second = await widget.browse({homey, body: {...body, offset: first.next}});
    assert.deepEqual(second.items.map(item => item.id), ['6', '9']);
    const third = await widget.browse({homey, body: {...body, offset: second.next}});
    assert.deepEqual(third.items.map(item => item.id), ['12', '15']);
    assert.equal(third.next, null);
    assert(offsets.includes(16));
    const none = await widget.browse({homey, body: {...body, filter: 'Missing'}});
    assert.deepEqual(none, {items: [], next: null});
    for (const size of [0, 201, 2.5, '2']) {
        await assert.rejects(widget.browse({homey, body: {...body, size}}), /widget.invalidAction/);
    }
});

test('filtered results retain their source page for exact playback resolution', async () => {
    const {homey, player, playlist} = fixture();
    const file = {id: 'correct', name: 'Duplicate', url: 'http://server/correct'};
    player.server = {browseById: async ({page}) => {
        assert.deepEqual(page, {offset: 6, size: 2});
        return {items: [file], next: null};
    }};
    playlist.PlayFile = async (_, resolve) => {
        assert.equal((await resolve()).id, 'correct');
        return true;
    };
    await widget.control({homey, body: {
        player: 'player-id', action: 'playFile', item: 'correct', folder: 'parent',
        offset: 6, size: 2, path: [{id: 'parent', name: 'Parent'}]
    }});
});

test('playlist view pages the saved shuffled sequence without exposing URLs', async () => {
    const {homey, playlist} = fixture();
    playlist.files = ['a', 'b', 'c'].map(id => ({id, name: id, url: `http://server/${id}`}));
    playlist.order = [2, 0, 1];
    playlist.currentFile = playlist.files[2];
    const result = await widget.playlist({homey, body: {player: 'player-id', offset: 0, size: 2}});
    assert.deepEqual(result, {
        items: [{id: 'c', name: 'c', number: 1, current: true}, {id: 'a', name: 'a', number: 2, current: false}],
        total: 3, offset: 0, currentNumber: 1, next: 2, shuffle: true
    });

    assert(!JSON.stringify(result).includes('http'));
    const final = await widget.playlist({homey, body: {player: 'player-id', offset: 2, size: 2}});
    assert.deepEqual(final.items.map(item => item.id), ['b']);
    assert.equal(final.next, null);
    playlist.mode = 'single';
    const single = await widget.playlist({homey, body: {player: 'player-id', size: 2}});
    assert.deepEqual(single.items.map(item => item.id), ['c']);
    assert.equal(single.total, 1);
});

test('opening the playlist returns the page containing the current track in playback order', async () => {
    const {homey, playlist} = fixture();
    playlist.files = ['a', 'b', 'c', 'd', 'e'].map(id => ({id, name: 'Same title'}));
    playlist.currentFile = playlist.files[0];
    playlist.order = [4, 3, 2, 0, 1];
    const read = offset => widget.playlist({homey, body: {player: 'player-id', offset, size: 2}});
    const shuffled = await read('current');
    assert.equal(shuffled.offset, 2);
    assert.deepEqual(shuffled.items.filter(item => item.current).map(item => [item.id, item.number]), [['a', 4]]);

    playlist.mode = 'normal';
    playlist.order = [0, 1, 2, 3, 4];
    playlist.currentFile = playlist.files[4];
    const normal = await read('current');
    assert.equal(normal.offset, 4);
    assert.equal(normal.items[0].number, 5);
    assert.equal(normal.items[0].current, true);

    playlist.mode = 'single';
    assert.deepEqual((await read('current')).items.map(item => [item.id, item.number, item.current]), [['e', 1, true]]);
    assert.equal((await read(4)).offset, 0);
    playlist.currentFile = undefined;
    assert.deepEqual((await read('current')).items, []);
    await assert.rejects(read('invalid'), /widget.invalidAction/);
});

test('playlist playback uses the displayed position and rejects stale or invalid selections', async () => {
    const {homey, playlist, calls} = fixture();
    playlist.files = ['a', 'b', 'c'].map(id => ({id, name: 'Same title'}));
    playlist.order = [2, 0, 1];
    playlist.currentFile = playlist.files[2];
    playlist.PlayQueueItem = async index => { calls.push(index); return true; };
    const body = {player: 'player-id', action: 'playQueueItem', item: 'b', number: 3};
    await widget.control({homey, body});
    await assert.rejects(widget.control({homey, body: {...body, item: 'a'}}), /playback.missingFile/);
    await assert.rejects(widget.control({homey, body: {...body, number: 4}}), /playback.missingFile/);
    await assert.rejects(widget.control({homey, body: {...body, number: 0}}), /widget.invalidAction/);
    playlist.mode = 'single';
    await widget.control({homey, body: {...body, item: 'c', number: 1}});
    assert.deepEqual(calls, [1, 2]);
});

test('play next resolves the exact Library entry before queueing it', async () => {
    const {homey, player, playlist, calls} = fixture();
    playlist.currentFile = {id: 'current'};
    playlist.playbackRevision = 1;
    playlist.QueueNext = async file => calls.push(file);
    player.server = {browseById: async () => ({items: [
        {id: 'file', name: 'File', url: 'http://server/file'}
    ], next: null})};
    const body = {player: 'player-id', action: 'playNext', item: 'file', folder: 'album', offset: 0, size: 10,
        path: [{id: 'album', name: 'Album'}]};
    await widget.control({homey, body});
    assert.deepEqual(calls, [{id: 'file', name: 'File', url: 'http://server/file',
        libraryPath: [{id: 'album', name: 'Album'}]}]);
    await assert.rejects(widget.control({homey, body: {...body, item: 'missing'}}), /playback.missingFile/);
    assert.equal(calls.length, 1);
});

test('sleep timer control forwards choices to the player', async () => {
    const {homey, playlist, calls} = fixture();
    playlist.SetSleep = async value => calls.push(value);
    for (const value of [15, 30, 60, 'track', null]) {
        await widget.control({homey, body: {player: 'player-id', action: 'sleep', value}});
    }
    assert.deepEqual(calls, [15, 30, 60, 'track', null]);
});
