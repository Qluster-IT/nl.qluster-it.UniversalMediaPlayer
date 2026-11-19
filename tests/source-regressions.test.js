'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { Defer } = require('../lib/proto');
const PlaylistManager = require('../lib/playlistmanager');
const {readPlayback, syncPlayback} = require('../lib/sonos-playback');
const UPnPServer = require('../lib/upnpserver');
const upnp = require('node-upnp-utils');
const english = require('../.homeycompose/locales/en.json');
const dutch = require('../.homeycompose/locales/nl.json');

function translator(locale) {
    return (key, values = {}) => {
        const [section, name] = key.split('.');
        return locale[section][name].replace(/__(\w+)__/g, (_, field) => values[field]);
    };
}

test('Defer rejects when its timeout expires and supports promise chaining', async () => {
    const deferred = new Defer(5);
    await assert.rejects(deferred.promise, /Operation timed out/);
    const resolved = new Defer();
    const chained = resolved.then(() => 'chained');
    resolved.resolve();
    assert.equal(await chained, 'chained');
});

test('repeat capability maps to valid playlist modes before and during playback', () => {
    const playlist = Object.create(PlaylistManager.prototype);

    playlist.SetRepeat('playlist');
    assert.equal(playlist.mode, 'repeat');

    playlist.mode = 'randomnormal';
    playlist.SetRepeat('playlist');
    assert.equal(playlist.mode, 'randomrepeat');

    playlist.SetRepeat('none');
    assert.equal(playlist.mode, 'randomnormal');
});

test('random-normal playback stops when every file has already played', () => {
    const playlist = Object.create(PlaylistManager.prototype);
    playlist.files = [{ id: 'one' }];
    playlist.filesIndex = { one: { index: 0, played: true } };
    playlist.ClearTimer = () => {};
    playlist.ClearFinishedTimer = () => {};
    playlist.Stop = () => 'stopped';
    playlist.Play = () => assert.fail('must not replay an exhausted random playlist');

    assert.equal(playlist.PlayNext({ mode: 'randomnormal' }), 'stopped');
});

test('random-repeat resets played state in the playlist index', () => {
    const playlist = Object.create(PlaylistManager.prototype);
    playlist.files = [{ id: 'one' }, { id: 'two' }];
    playlist.filesIndex = {
        one: { index: 0, played: true },
        two: { index: 1, played: true }
    };
    playlist.ClearTimer = () => {};
    playlist.ClearFinishedTimer = () => {};
    playlist.Play = () => playlist.currentFile.id;

    const selected = playlist.PlayNext({ mode: 'randomrepeat' });

    assert.ok(['one', 'two'].includes(selected));
    assert.deepEqual(Object.values(playlist.filesIndex).map(file => file.played), [false, false]);
});

test('shuffle follows its precomputed sequence and preserves it across restarts', async t => {
    const {create, folder, triggered} = restartFixture(t);
    const before = create();
    await before.PlayFolder({folder, mode: 'randomnormal'});
    const order = before.order.slice();
    assert.deepEqual([...order].sort(), [0, 1]);
    const expected = order.map(index => before.files[index].name);
    assert.deepEqual(triggered, [expected[0]]);
    await before.Dispose();
    const after = create();
    after.RestorePlayback();
    assert.deepEqual(after.order, order);
    await after.PlayNext();
    assert.deepEqual(triggered, expected);
    await after.PlayPrevious();
    assert.equal(after.currentFile.name, expected[0]);
    await after.PlayNext();
    assert.equal(after.currentFile.name, expected[1]);
    await after.Dispose();
});

test('shuffled repeat finishes each saved cycle before generating the next sequence', async t => {
    const {create, folder, triggered} = restartFixture(t);
    const playlist = create();
    await playlist.PlayFolder({folder, mode: 'randomrepeat'});
    const firstCycle = playlist.order.map(index => playlist.files[index].name);
    await playlist.PlayNext();
    assert.deepEqual(triggered, firstCycle);
    await playlist.PlayNext();
    const secondCycle = playlist.order.map(index => playlist.files[index].name);
    assert.deepEqual(triggered, [...firstCycle, secondCycle[0]]);
    await playlist.PlayNext();
    assert.deepEqual(triggered, [...firstCycle, ...secondCycle]);
    await playlist.Dispose();
});

test('selecting a playlist track continues from that point after restart in normal and shuffled order', async t => {
    const {create, files, folder, triggered} = restartFixture(t);
    files.push({id: 'third', name: 'third', url: 'http://example.test/third', duration: 20000});
    for (const mode of ['normal', 'randomnormal']) {
        const before = create();
        await before.PlayFolder({folder, mode});
        const order = before.order.slice();
        triggered.length = 0;
        await before.PlayQueueItem(order[1]);
        assert.deepEqual(triggered, [files[order[1]].name]);
        assert.deepEqual(before.order, order);
        await before.Dispose();
        const after = create();
        after.RestorePlayback();
        t.mock.timers.tick(21000);
        assert.deepEqual(triggered, order.slice(1).map(index => files[index].name));
        await after.Dispose();
    }
});

test('play next moves an existing track and adds another without reshuffling, including after restart', async t => {
    const {create, files, folder, triggered} = restartFixture(t);
    files.push({id: 'third', name: 'third', url: 'http://example.test/third', duration: 20000});
    for (const mode of ['normal', 'randomnormal']) {
        const before = create();
        await before.PlayFolder({folder, mode});
        const original = before.order.map(index => before.files[index].id);
        const current = before.currentFile;
        const move = before.files.find(file => file.id !== current.id);
        await before.QueueNext(move);
        const external = {id: 'external', name: 'external', url: 'http://example.test/external', duration: 20000};
        await before.QueueNext(external);
        assert.deepEqual(before.order.map(index => before.files[index].id),
            [current.id, 'external', move.id, ...original.filter(id => id !== current.id && id !== move.id)]);
        await assert.rejects(before.QueueNext(current), /Invalid player action/);
        await before.Dispose();
        const after = create();
        after.RestorePlayback();
        triggered.length = 0;
        await after.PlayNext();
        await after.PlayNext();
        assert.deepEqual(triggered, ['external', move.name]);
        await after.Dispose();
    }
});

test('play next after a single track preserves its finished wait and continues with the queued track', async t => {
    const {create, files, triggered} = restartFixture(t);
    const player = create();
    const done = player.PlayFile({file: files[0], finish: true, af: true}, async () => files[0]);
    await Promise.resolve();
    await player.QueueNext(files[1]);
    t.mock.timers.tick(21000);
    assert.equal((await done).name, 'first');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(triggered, ['first', 'finished', 'second']);
    await player.Dispose();
});

test('play next after a single track survives restart before completion', async t => {
    const {create, files, triggered} = restartFixture(t);
    const before = create();
    await before.PlayFile({file: files[0]}, async () => files[0]);
    await before.QueueNext(files[1]);
    await before.Dispose();
    const after = create();
    after.RestorePlayback();
    t.mock.timers.tick(21000);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(triggered, ['first', 'finished', 'second']);
    await after.Dispose();
});

test('a track added with play next remains in playlist repeat cycles', async t => {
    const {create, folder, triggered} = restartFixture(t);
    const player = create();
    await player.PlayFolder({folder, mode: 'repeat'});
    await player.QueueNext({id: 'extra', name: 'extra', url: 'http://example.test/extra', duration: 20000});
    for (let i = 0; i < 4; i++) await player.PlayNext();
    assert.deepEqual(triggered, ['first', 'extra', 'second', 'first', 'extra']);
    await player.Dispose();
});

test('recently played folders are limited, reordered, and restored', async t => {
    const {create, folder} = restartFixture(t);
    const player = create();
    player.uPnPPlayer.getSetting = id => id === 'recentFolderLimit' ? 2 : 1000;
    await player.PlayFolder({folder, mode: 'normal'});
    player.RememberFolder({libraryPath: [{id: 'other', name: 'Other'}]});
    player.RememberFolder({libraryPath: [{id: 'third', name: 'Third'}]});
    player.RememberFolder({libraryPath: [{id: 'other', name: 'Other'}]});
    await player.SavePlayback();
    await player.Dispose();
    const restored = create();
    restored.RestorePlayback();
    assert.deepEqual(restored.recentFolders.map(entry => entry.path[0].id), ['other', 'third']);
    await restored.Dispose();
});

test('timed sleep survives restart and stops without advancing an expired track', async t => {
    const {create, folder, triggered} = restartFixture(t);
    const before = create();
    await before.PlayFolder({folder, mode: 'normal'});
    await before.SetSleep(15);
    await before.Dispose();
    t.mock.timers.tick(901000);
    const after = create();
    after.RestorePlayback();
    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(triggered, ['first', 'stopped']);
    assert.equal(after.sleep, null);
    assert.equal(after.playing, false);
    await after.Dispose();
});

test('timed sleep continues counting while paused', async t => {
    const {create, folder, triggered} = restartFixture(t);
    const player = create();
    await player.PlayFolder({folder, mode: 'normal'});
    await player.SetSleep(15);
    await player.Pause();
    t.mock.timers.tick(900000);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(triggered, ['first', 'paused', 'stopped']);
    assert.equal(player.sleep, null);
    await player.Dispose();
});

test('sleep timer rejects invalid values and can be cancelled', async t => {
    const {create, folder, triggered} = restartFixture(t);
    const player = create();
    await assert.rejects(player.SetSleep('track'), /known duration/);
    await assert.rejects(player.SetSleep(-1), /Invalid player action/);
    await player.PlayFolder({folder, mode: 'normal'});
    await player.SetSleep(15);
    await player.Pause();
    await player.SetSleep(null);
    t.mock.timers.tick(900000);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(triggered, ['first', 'paused']);
    await player.Dispose();
});

test('end-of-track sleep follows a manual skip and survives restart', async t => {
    const {create, folder, triggered} = restartFixture(t);
    const before = create();
    await before.PlayFolder({folder, mode: 'normal'});
    await before.SetSleep('track');
    await before.PlayNext();
    await before.Dispose();
    const after = create();
    after.RestorePlayback();
    t.mock.timers.tick(20000);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(triggered, ['first', 'second', 'stopped']);
    assert.equal(after.sleep, null);
    await after.Dispose();
});

test('end-of-track sleep preserves a single-track Advanced Flow completion wait', async t => {
    const {create, files, triggered} = restartFixture(t);
    const player = create();
    const done = player.PlayFile({file: files[0], finish: true, af: true}, async () => files[0]);
    await Promise.resolve();
    await player.SetSleep('track');
    t.mock.timers.tick(20000);
    assert.equal((await done).name, 'first');
    assert.deepEqual(triggered, ['first', 'finished', 'stopped']);
    await player.Dispose();
});

test('sleep expiry during an announcement waits across restart for the speaker to resume', async t => {
    const {create, folder, triggered} = restartFixture(t);
    const before = create();
    await before.PlayFolder({folder, mode: 'normal'});
    await before.SetSleep(15);
    const url = before.currentFile.url;
    await before.ReportSpeakerPlayback({url: 'http://announcement/speech.mp3', state: 'PLAYING'});
    t.mock.timers.tick(900000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(before.sleep.mode, 'deferred');
    assert.deepEqual(triggered, ['first']);
    assert.throws(() => before.PlayNext(), /Waiting for speaker to resume/);
    await assert.rejects(before.Play(), /Waiting for speaker to resume/);
    assert.equal(before.currentFile.url, url);
    await before.Dispose();
    const after = create();
    after.RestorePlayback();
    assert.equal(after.sleep.mode, 'deferred');
    await after.ReportSpeakerPlayback({url, state: 'PLAYING'});
    assert.deepEqual(triggered, ['first', 'stopped']);
    assert.equal(after.sleep, null);
    assert.equal(after.playing, false);
    await after.Dispose();
});

test('a sleep timer expiring offline during an announcement defers Stop until speaker playback resumes', async t => {
    const {create, folder, triggered} = restartFixture(t);
    const before = create();
    await before.PlayFolder({folder, mode: 'normal'});
    await before.SetSleep(15);
    const url = before.currentFile.url;
    await before.ReportSpeakerPlayback({url: 'http://announcement/speech.mp3', state: 'PLAYING'});
    await before.Dispose();
    t.mock.timers.tick(901000);
    const after = create();
    after.RestorePlayback();
    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(after.sleep.mode, 'deferred');
    assert.deepEqual(triggered, ['first']);
    await after.ReportSpeakerPlayback({url, state: 'PLAYING'});
    assert.deepEqual(triggered, ['first', 'stopped']);
    await after.Dispose();
});

test('a deferred sleep Stop interrupted by a restart is completed after recovery', async t => {
    const {create, folder, triggered} = restartFixture(t);
    const before = create();
    await before.PlayFolder({folder, mode: 'normal'});
    await before.SetSleep(15);
    await before.ReportSpeakerPlayback({url: 'http://announcement/speech.mp3', state: 'PLAYING'});
    t.mock.timers.tick(900000);
    await new Promise(resolve => setImmediate(resolve));
    await before.MarkStopped();
    await before.Dispose();
    const after = create();
    after.RestorePlayback();
    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(triggered, ['first', 'stopped']);
    assert.equal(after.sleep, null);
    await after.Dispose();
});

test('shuffled folder playback starts with the selected file and queues every other file once', async t => {
    const {create, files, triggered} = restartFixture(t);
    const playlist = create();
    await playlist.PlayFolder({mode: 'randomnormal', startFile: 'second'}, async () => ({id: 'album'}));
    assert.equal(playlist.currentFile, files[1]);
    assert.deepEqual(playlist.order, [1, 0]);
    await playlist.PlayNext();
    assert.deepEqual(triggered, ['second', 'first']);
    await playlist.Dispose();
});

test('playback reports when no URL-trigger flow handles the file', async () => {
    const messages = [];
    const playlist = Object.create(PlaylistManager.prototype);
    playlist.currentFile = { id: 'one', duration: 1000 };
    playlist.filesIndex = { one: { index: 0, played: false } };
    playlist.uPnPPlayer = {
        driver: {
            Triggers: {
                url_trigger: { Card: { trigger: async () => false } }
            }
        },
        log: message => messages.push(message),
        setCapabilityValue: () => {}
    };

    assert.equal(await playlist.Play(), false);
    assert.equal(playlist.playing, false);
    assert.match(messages[0], /Add a flow using the URL changed trigger/);
});

test('cancelling a finished-playback wait rejects instead of leaving it pending', async () => {
    const playlist = Object.create(PlaylistManager.prototype);
    playlist.homey = {__: translator(english)};
    playlist.currentFile = { id: 'one', duration: 60000 };
    playlist.uPnPPlayer = {
        getSetting: () => 1000
    };
    const finished = playlist.SetFinishedTimer();
    const rejection = assert.rejects(finished, /Playback finished wait was cancelled/);

    playlist.ClearFinishedTimer();
    await rejection;
});

test('Flow location lookup records the containing path for files and the full path for folders', async () => {
    const searches = [];
    const server = {
        async find(name, id, search) {
            searches.push(search);
            return { id: name, name, realName: name };
        }
    };

    const result = await UPnPServer.prototype.getFromLocation.call(server, {
        item: { location: 'Music[/]Album[/]song.mp3' },
        search: 'file'
    });

    assert.equal(result.name, 'song.mp3');
    const path = [{id: 'Music', name: 'Music'}, {id: 'Album', name: 'Album'}];
    assert.deepEqual(result.libraryPath, path);
    assert.deepEqual(searches, ['folders, files', 'folders, files', 'files']);
    const folder = await UPnPServer.prototype.getFromLocation.call(server, {
        item: {location: 'Music[/]Album'},
        search: 'folders'
    });
    assert.deepEqual(folder.libraryPath, path);
});

test('stopping while the URL trigger is pending does not restart playback', async () => {
    const urlTrigger = new Defer();
    const playlist = Object.create(PlaylistManager.prototype);
    playlist.currentFile = { id: 'one', name: 'one', url: 'http://example.test/one', duration: 1000 };
    playlist.filesIndex = { one: { played: false } };
    playlist.uPnPPlayer = {
        driver: { Triggers: {
            url_trigger: { Card: { trigger: () => urlTrigger.promise } },
            stopped_trigger: { Card: { trigger: async () => true } }
        } },
        setCapabilityValue: () => {}
    };

    const playing = playlist.Play();
    await playlist.Stop();
    urlTrigger.resolve(true);

    assert.equal(await playing, false);
    assert.equal(playlist.playing, false);
    assert.equal(playlist.timer, null);
});

test('newer file requests win when lookups finish out of order', async () => {
    const first = new Defer();
    const second = new Defer();
    const playlist = Object.create(PlaylistManager.prototype);
    playlist.folder = {id: 'previous-folder'};
    playlist.uPnPPlayer = {
        server: { getFromLocation: ({item}) => item.name === 'first' ? first.promise : second.promise }
    };
    playlist.PlayNext = () => playlist.files[0].name;

    const firstRequest = playlist.PlayFile({file: {name: 'first'}});
    const secondRequest = playlist.PlayFile({file: {name: 'second'}});
    second.resolve({id: 'second', name: 'second', url: 'http://example.test/second'});
    assert.equal(await secondRequest, 'second');
    first.resolve({id: 'first', name: 'first'});
    assert.equal(await firstRequest, false);
    assert.equal(playlist.files[0].name, 'second');
    assert.equal(playlist.folder, null);
});

test('missing files and folders report a useful error', async () => {
    const playlist = Object.create(PlaylistManager.prototype);
    playlist.homey = {__: translator(english)};
    playlist.uPnPPlayer = {server: {getFromLocation: async () => null}};
    await assert.rejects(playlist.PlayFile({file: {location: 'missing'}}), /file not found/i);
    await assert.rejects(playlist.PlayFolder({folder: {location: 'missing'}}), /folder not found/i);
});

test('UPnP browse accepts string resources and relative artwork URLs', async () => {
    const original = upnp.invokeAction;
    upnp.invokeAction = (params, callback) => callback(null, {
        's:Body': {'u:BrowseResponse': {Result:
            '<DIDL-Lite xmlns:dc="urn:dc" xmlns:upnp="urn:upnp">' +
            '<item id="1"><dc:title>Track</dc:title><res>http://example.test/track.mp3</res>' +
            '<upnp:albumArtURI>/art.jpg</upnp:albumArtURI></item></DIDL-Lite>'}}
    }, null, {statusCode: 200});
    const server = Object.create(UPnPServer.prototype);
    server._ip = '192.0.2.1:1234';
    server.homey = {__: translator(dutch), app: {error: () => {}}};
    server.getSoapActionFromSoapBody = async () => 'Browse';
    try {
        const files = await server.browseById({id: '0', search: 'files'});
        assert.equal(files[0].url, 'http://example.test/track.mp3');
        assert.equal(files[0].albumUrl, 'http://192.0.2.1:1234/art.jpg');
        const picker = await server.browseById({id: '12', ids: '12', locations: ['Music'], search: 'folders'});
        assert.deepEqual(picker.map(({id, name, description, location}) => ({id, name, description, location})), [
            {id: 'Back', name: 'Terug :[0]', description: 'Blader door de bovenliggende map', location: undefined},
            {id: '12', name: 'Music', description: 'Speel deze map af', location: 'Music'}
        ]);
    } finally {
        upnp.invokeAction = original;
    }
});

test('paged browse XML-escapes UPnP IDs and reports the next offset without registering art', async t => {
    const server = Object.create(UPnPServer.prototype);
    server.homey = {__: translator(english), app: {error: () => {}}};
    server._ip = '192.0.2.1:1234';
    server.getSoapActionFromSoapBody = async () => 'Browse';
    server.getImage = () => assert.fail('Widget browsing must not register artwork');
    let response = '<DIDL-Lite><container id="child"><dc:title>Folder</dc:title></container></DIDL-Lite>';
    t.mock.method(upnp, 'invokeAction', ({soap}, callback) => {
        assert.match(soap, /<ObjectID>A&amp;B&lt;C<\/ObjectID>/);
        assert.match(soap, /<StartingIndex>2<\/StartingIndex>/);
        assert.match(soap, /<RequestedCount>1<\/RequestedCount>/);
        callback(null, {'s:Body': {'u:BrowseResponse': {Result: response, TotalMatches: '4'}}}, null, {statusCode: 200});
    });
    const args = {id: 'A&B<C', search: 'folders,files', page: {offset: 2, size: 1}};
    const page = await server.browseById(args);
    assert.equal(page.items[0].realName, 'Folder');
    assert.equal(page.next, 3);
    response = '<DIDL-Lite/>';
    assert.deepEqual(await server.browseById(args), {items: [], next: null});
});

test('playback warns when the server does not provide a duration', async () => {
    const messages = [];
    const playlist = Object.create(PlaylistManager.prototype);
    playlist.currentFile = {id: 'track', duration: 0};
    playlist.filesIndex = {track: {played: false}};
    playlist.uPnPPlayer = {
        log: message => messages.push(message),
        setCapabilityValue: () => {},
        driver: {Triggers: {url_trigger: {Card: {trigger: async () => true}}}}
    };
    playlist.SetFinishedTimer = async () => true;

    assert.equal(await playlist.Play({mode: 'single'}), true);
    assert.match(messages[0], /did not provide a valid duration/);
    await playlist.Dispose();
});

function restartFixture(t) {
    t.mock.timers.enable({apis: ['Date', 'setTimeout', 'setInterval'], now: 100000});
    const triggered = [];
    const published = new Map();
    const files = ['first', 'second'].map(id => ({
        id, name: id, url: `http://example.test/${id}`, duration: 20000
    }));
    const folder = {id: 'album', libraryPath: [{id: 'album', name: 'Album'}]};
    const stored = new Map();
    let writes = 0;
    const uPnPPlayer = {
        getStoreValue: key => stored.get(key),
        setStoreValue: async (key, value) => {
            stored.set(key, JSON.parse(JSON.stringify(value)));
            writes++;
        },
        getSetting: () => 1000,
        setCapabilityValue: (key, value) => published.set(key, value),
        log: () => {},
        error: (...args) => assert.fail(args.join(' ')),
        server: {
            getFromLocation: async () => folder,
            browseById: async () => files
        },
        driver: {Triggers: {
            url_trigger: {Card: {trigger: async (_, file) => { triggered.push(file.name); return true; }}},
            stopped_trigger: {Card: {
                trigger: async () => { triggered.push('stopped'); return true; },
                getArgumentValues: async () => [{}]
            }},
            paused_trigger: {Card: {
                trigger: async () => { triggered.push('paused'); },
                getArgumentValues: async () => []
            }},
            finished_trigger: {Card: {trigger: async () => { triggered.push('finished'); }}}
        }}
    };
    const create = () => Object.assign(Object.create(PlaylistManager.prototype),
        {uPnPPlayer, homey: {__: translator(english)}});
    return {create, triggered, published, folder, files, writes: () => writes};
}

test('playback changes notify widgets without publishing periodic progress updates', async t => {
    const {create, folder} = restartFixture(t);
    const playlist = create();
    const events = [];
    playlist.uPnPPlayer.getData = () => ({id: 'player'});
    playlist.uPnPPlayer.homey = {api: {realtime: async (event, payload) => events.push([event, payload])}};
    await playlist.PlayFolder({folder, mode: 'normal'});
    await playlist.SetShuffle(true);
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(5000);
    await new Promise(resolve => setImmediate(resolve));
    const change = ['media_state_changed', {player: 'player'}];
    assert.deepEqual(events, [change]);
    await playlist.ReportSpeakerPlayback({url: playlist.currentFile.url, state: 'PAUSED_PLAYBACK'});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, [change, change]);
    await playlist.Dispose();
});

test('restart restores active position and sends only the next track at the original deadline', async t => {
    const {create, triggered, published, folder, writes} = restartFixture(t);
    const before = create();
    await before.PlayFolder({folder, mode: 'normal'});
    t.mock.timers.tick(5000);
    assert.equal(published.get('speaker_position'), 5);
    assert.equal(writes(), 1);
    await before.Dispose();
    t.mock.timers.tick(3000);

    const after = create();
    after.RestorePlayback();
    assert.equal(after.playing, true);
    assert.equal(after.position, 8000);
    assert.equal(published.get('speaker_position'), 8);
    assert.equal(published.get('speaker_duration'), 20);
    assert.deepEqual(after.folder.libraryPath, folder.libraryPath);
    assert.equal(after.filesIndex.first.played, true);
    t.mock.timers.tick(12999);
    assert.deepEqual(triggered, ['first']);
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.deepEqual(triggered, ['first', 'second']);
    assert.equal(after.position, 0);
    await after.Dispose();
});

test('shuffle and repeat selected before the first track survive a restart', async t => {
    const {create, published, triggered} = restartFixture(t);
    const before = create();
    await before.SetShuffle(true);
    await before.SetRepeat('playlist');
    await before.Dispose();
    const after = create();
    after.RestorePlayback();
    assert.equal(after.mode, 'randomrepeat');
    assert.equal(published.get('speaker_shuffle'), true);
    assert.equal(published.get('speaker_repeat'), 'playlist');
    assert.equal(after.playing, false);
    assert.deepEqual(triggered, []);
    await after.SetShuffle(false);
    await after.SetRepeat('none');
    await after.Dispose();
    const disabled = create();
    disabled.RestorePlayback();
    assert.equal(disabled.mode, 'normal');
    assert.equal(published.get('speaker_shuffle'), false);
    assert.equal(published.get('speaker_repeat'), 'none');
    await disabled.Dispose();
});

test('an existing device without a playback snapshot restores its saved capability preferences', async t => {
    const {create, published} = restartFixture(t);
    const playlist = create();
    published.set('speaker_shuffle', true);
    published.set('speaker_repeat', 'playlist');
    playlist.uPnPPlayer.getCapabilityValue = id => published.get(id);
    playlist.RestorePlayback();
    assert.equal(playlist.mode, 'randomrepeat');
    assert.equal(published.get('speaker_shuffle'), true);
    assert.equal(published.get('speaker_repeat'), 'playlist');
    await playlist.Dispose();
});

test('mode changes survive restarts with both a playing and a paused queue', async t => {
    const {create, folder, published, triggered} = restartFixture(t);
    const before = create();
    await before.PlayFolder({folder, mode: 'normal'});
    await before.SetShuffle(true);
    await before.SetRepeat('playlist');
    t.mock.timers.tick(5000);
    await before.Dispose();
    const active = create();
    active.RestorePlayback();
    assert.equal(active.mode, 'randomrepeat');
    assert.equal(active.playing, true);
    assert.equal(active.position, 5000);
    assert.equal(published.get('speaker_shuffle'), true);
    assert.equal(published.get('speaker_repeat'), 'playlist');
    await active.ReportSpeakerPlayback({url: active.currentFile.url, state: 'PAUSED_PLAYBACK'});
    await active.Dispose();
    const paused = create();
    paused.RestorePlayback();
    assert.equal(paused.mode, 'randomrepeat');
    assert.equal(paused.paused, true);
    assert.equal(paused.position, 5000);
    assert.equal(paused.currentFile.id, 'first');
    assert.equal(paused.filesIndex.first.played, true);
    assert.deepEqual(triggered, ['first']);
    await paused.Dispose();
});

test('speaker pause freezes playback; verified resume restarts only the remaining timer', async t => {
    const {create, triggered, folder} = restartFixture(t);
    const playlist = create();
    await playlist.PlayFolder({folder, mode: 'normal'});
    t.mock.timers.tick(4500);
    const url = playlist.currentFile.url;
    await playlist.ReportSpeakerPlayback({url, state: 'PAUSED_PLAYBACK'});
    assert.equal(playlist.paused, true);
    assert.equal(playlist.playing, false);
    t.mock.timers.tick(30000);
    assert.equal(playlist.position, 4500);
    assert.deepEqual(triggered, ['first']);
    await playlist.ReportSpeakerPlayback({url, state: 'PLAYING'});
    assert.equal(playlist.playing, true);
    t.mock.timers.tick(16499);
    assert.deepEqual(triggered, ['first']);
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.deepEqual(triggered, ['first', 'second']);
    await playlist.Dispose();
});

test('an announcement temporarily suspends the queue and restores it without echoing commands', async t => {
    const {create, triggered, published, folder} = restartFixture(t);
    const playlist = create();
    await playlist.PlayFolder({folder, mode: 'normal'});
    t.mock.timers.tick(5000);
    const original = playlist.currentFile;
    await playlist.ReportSpeakerPlayback({url: original.url, state: 'PAUSED_PLAYBACK'});
    await playlist.ReportSpeakerPlayback({url: 'http://announcement/speech.mp3', state: 'PLAYING'});
    assert.equal(playlist.paused, true);
    assert.equal(playlist.files.length, 2);
    t.mock.timers.tick(40000);
    assert.equal(playlist.currentFile, original);
    assert.equal(playlist.position, 5000);
    assert.deepEqual(triggered, ['first']);
    await playlist.ReportSpeakerPlayback({url: 'http://other/music.mp3', state: 'PLAYING'});
    assert.equal(playlist.playing, false);
    playlist.uPnPPlayer.playlistManager = playlist;
    await syncPlayback(playlist.uPnPPlayer, '192.168.1.177', address => readPlayback(address, async (_, opts) => {
        const action = opts.headers.SOAPACTION.match(/#(\w+)/)[1];
        const body = action === 'GetPositionInfo'
            ? `<TrackURI>x-rincon-mp3radio://${original.url}</TrackURI>`
            : '<CurrentTransportState>PLAYING</CurrentTransportState>';
        return {ok: true, text: async () => `<Envelope><Body><${action}Response>${body}</${action}Response></Body></Envelope>`};
    }));
    assert.equal(playlist.playing, true);
    assert.equal(playlist.position, 0);
    assert.equal(published.get('speaker_position'), 0);
    assert.deepEqual(triggered, ['first']);
    t.mock.timers.tick(1000);
    await playlist.ReportSpeakerPlayback({url: original.url, state: 'PLAYING'});
    t.mock.timers.tick(19999);
    assert.deepEqual(triggered, ['first']);
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.deepEqual(triggered, ['first', 'second']);
    await playlist.Dispose();
});

test('speaker Stop followed by Play restarts the local timer without a foreign-track snapshot', async t => {
    const {create, triggered, folder} = restartFixture(t);
    const playlist = create();
    await playlist.PlayFolder({folder, mode: 'normal'});
    t.mock.timers.tick(5000);
    const url = playlist.currentFile.url;
    await playlist.ReportSpeakerPlayback({url, state: 'STOPPED'});
    await playlist.ReportSpeakerPlayback({url, state: 'PLAYING'});
    assert.equal(playlist.position, 0);
    assert.deepEqual(triggered, ['first']);
    await playlist.Dispose();
});

test('announcement restart timing survives an app restart while interrupted', async t => {
    const {create, triggered, folder} = restartFixture(t);
    const before = create();
    await before.PlayFolder({folder, mode: 'normal'});
    t.mock.timers.tick(5000);
    const url = before.currentFile.url;
    await before.ReportSpeakerPlayback({url: 'http://announcement/speech.mp3', state: 'PLAYING'});
    await before.Dispose();
    const after = create();
    after.RestorePlayback();
    assert.equal(after.position, 5000);
    await after.ReportSpeakerPlayback({url, state: 'PLAYING'});
    assert.equal(after.position, 0);
    t.mock.timers.tick(20999);
    assert.deepEqual(triggered, ['first']);
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.deepEqual(triggered, ['first', 'second']);
    await after.Dispose();
});

test('natural Sonos completion still advances the queue and stopped playback does not revive', async t => {
    const {create, triggered, folder} = restartFixture(t);
    const playlist = create();
    await playlist.PlayFolder({folder, mode: 'normal'});
    t.mock.timers.tick(20000);
    await playlist.ReportSpeakerPlayback({url: playlist.currentFile.url, state: 'STOPPED'});
    t.mock.timers.tick(1000);
    await Promise.resolve();
    assert.deepEqual(triggered, ['first', 'second']);
    await playlist.Stop();
    await playlist.ReportSpeakerPlayback({url: playlist.currentFile.url, state: 'PLAYING'});
    assert.equal(playlist.playing, false);
    await playlist.Dispose();
});

test('an announcement preserves an Advanced Flow completion wait, even beyond its old timeout', async t => {
    const {create, triggered, files} = restartFixture(t);
    const playlist = create();
    playlist.currentFile = files[0];
    playlist.files = [files[0]];
    playlist.filesIndex = {first: {file: files[0], index: 0, played: false}};
    const done = playlist.Play({mode: 'single', finish: true, af: true});
    await Promise.resolve();
    const originalWait = playlist.finishedTimerDeferred;
    assert(originalWait);
    t.mock.timers.tick(5000);
    await playlist.ReportSpeakerPlayback({url: 'http://announcement/speech.mp3', state: 'PLAYING'});
    t.mock.timers.tick(90000);
    assert.equal(originalWait.isSettled, false);
    await playlist.ReportSpeakerPlayback({url: files[0].url, state: 'PLAYING'});
    assert.equal(playlist.finishedTimerDeferred, originalWait);
    t.mock.timers.tick(20999);
    assert.equal(originalWait.isSettled, false);
    t.mock.timers.tick(1);
    assert.deepEqual(await done, {url: files[0].url, duration: files[0].duration, name: files[0].name});
    assert.deepEqual(triggered, ['first', 'finished']);
    await playlist.Dispose();
});

test('stopped playback keeps its track and position without scheduling a trigger on restart', async t => {
    const {create, triggered, folder} = restartFixture(t);
    const before = create();
    await before.PlayFolder({folder, mode: 'normal'});
    t.mock.timers.tick(4500);
    await before.Stop();
    await before.Dispose();
    t.mock.timers.tick(30000);

    const after = create();
    after.RestorePlayback();
    t.mock.timers.tick(30000);
    assert.equal(after.playing, false);
    assert.equal(after.position, 4500);
    assert.equal(after.currentFile.id, 'first');
    assert.deepEqual(triggered, ['first', 'stopped']);
    await after.Dispose();
});

test('opted-in manual Stop sends silence even with a Stop Flow and preserves the saved track', async t => {
    const {create, triggered, folder} = restartFixture(t);
    const player = create();
    player.homey.cloud = {getLocalAddress: async () => '192.0.2.10:80'};
    player.homey.manifest = {id: 'nl.qluster-it.UniversalMediaPlayer'};
    player.uPnPPlayer.getSetting = key => key === 'silentStop' ? true : 1000;
    await player.PlayFolder({folder, mode: 'normal'});
    const sent = [];
    player.uPnPPlayer.driver.Triggers.url_trigger.Card.trigger = async (_, tokens) => { sent.push(tokens); };
    t.mock.timers.tick(4500);
    await player.Stop();
    t.mock.timers.tick(30000);
    assert.deepEqual(triggered, ['first', 'stopped']);
    assert.deepEqual(sent, [{
        url: 'https://192-0-2-10.homey.homeylocal.com/app/nl.qluster-it.UniversalMediaPlayer/assets/audio/silence.wav',
        duration: 500,
        name: english.widget.stopped
    }]);
    assert.equal(player.currentFile.id, 'first');
    assert.equal(player.position, 4500);
    assert.equal(player.playing, false);
    await player.Dispose();
    const restored = create();
    restored.RestorePlayback();
    assert.equal(restored.currentFile.id, 'first');
    assert.equal(restored.position, 4500);
    await restored.Dispose();
});

test('Pause fires its own card, freezes position, and uses only its own silence setting', async t => {
    const {create, triggered, folder} = restartFixture(t);
    const player = create();
    player.homey.cloud = {getLocalAddress: async () => '192.0.2.10:80'};
    player.homey.manifest = {id: 'nl.qluster-it.UniversalMediaPlayer'};
    let silentPause = false;
    player.uPnPPlayer.getSetting = key => ({silentStop: true, silentPause, delay: 1000})[key];
    const pauseCard = player.uPnPPlayer.driver.Triggers.paused_trigger.Card;
    for (const [enabled, configured, expected] of [
        [false, false, ['first', 'paused']],
        [true, true, ['first', 'paused', english.widget.paused]],
        [true, false, ['first', 'paused', english.widget.paused]]
    ]) {
        silentPause = enabled;
        pauseCard.trigger = async () => { triggered.push('paused'); return configured; };
        pauseCard.getArgumentValues = async () => configured ? [{}] : [];
        triggered.length = 0;
        await player.PlayFolder({folder, mode: 'normal'});
        t.mock.timers.tick(5000);
        await player.TogglePlay(false);
        t.mock.timers.tick(30000);
        assert.deepEqual(triggered, expected);
        assert.equal(player.paused, true);
        assert.equal(player.position, 5000);
    }
    await player.Dispose();
    const restored = create();
    restored.RestorePlayback();
    assert.equal(restored.paused, true);
    assert.equal(restored.position, 5000);
    await restored.Dispose();
});

test('queue exhaustion uses the original stopped trigger even with silent Stop enabled', async t => {
    const {create, triggered, folder, files} = restartFixture(t);
    const player = create();
    files.pop();
    player.uPnPPlayer.getSetting = key => key === 'silentStop' ? true : 1000;
    await player.PlayFolder({folder, mode: 'normal'});
    await player.PlayNext();
    assert.deepEqual(triggered, ['first', 'stopped']);
    assert.equal(player.playing, false);
    await player.Dispose();
});

test('a single track that ended during downtime fires only the finish trigger', async t => {
    const {create, triggered, files} = restartFixture(t);
    const before = create();
    await before.PlayFile({file: {}}, async () => files[0]);
    await before.Dispose();
    t.mock.timers.tick(30000);

    const after = create();
    after.RestorePlayback();
    assert.equal(after.position, 20000);
    assert.deepEqual(triggered, ['first']);
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.deepEqual(triggered, ['first', 'finished']);
    assert.equal(after.playing, false);
    await after.Dispose();
});

test('album art arriving before image initialization is applied afterward', async () => {
    const created = new Defer();
    const streams = [];
    const image = {
        setUrl: () => {},
        setStream: stream => streams.push(stream),
        update: async () => {}
    };
    const player = {setAlbumArtImage: async () => {}, error: error => assert.fail(error)};
    const playlist = new PlaylistManager({
        homey: {images: {createImage: () => created.promise}},
        uPnPPlayer: player
    });
    playlist.albumUrl = 'http://example.test/cover.jpg';
    created.resolve(image);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(streams.length, 1);
});

test('invalid UPnP browse responses reject instead of appearing empty', async () => {
    const original = upnp.invokeAction;
    upnp.invokeAction = (params, callback) => callback(null, {}, null, {statusCode: 200});
    const server = Object.create(UPnPServer.prototype);
    server._ip = '192.0.2.1:1234';
    server.homey = {__: translator(english)};
    server.getSoapActionFromSoapBody = async () => 'Browse';
    try {
        await assert.rejects(server.browseById({id: '0', search: 'files'}), /Invalid UPnP browse response/);
    } finally {
        upnp.invokeAction = original;
    }
});

test('folder playback browses the resolved folder ID, not the saved ID', async () => {
    const playlist = Object.create(PlaylistManager.prototype);
    let browsedId;
    playlist.uPnPPlayer = { server: {
        getFromLocation: async () => ({id: 'new-id'}),
        browseById: async ({id}) => {
            browsedId = id;
            return [{id: 'track'}];
        }
    } };
    playlist.PlayNext = () => true;

    assert.equal(await playlist.PlayFolder({folder: {id: 'old-id'}, mode: 'normal'}), true);
    assert.equal(browsedId, 'new-id');
});

test('folder playback starts at the selected track and continues in server order', async () => {
    const playlist = Object.create(PlaylistManager.prototype);
    playlist.homey = {__: translator(english)};
    const files = [
        {id: 'first', name: 'Duplicate', url: 'http://server/1'},
        {id: 'unplayable', name: 'Duplicate'},
        {id: 'selected', name: 'Duplicate', url: 'http://server/2'},
        {id: 'last', url: 'http://server/3'}
    ];
    playlist.uPnPPlayer = {server: {browseById: async () => files}};
    playlist.ClearTimer = () => {};
    playlist.ClearFinishedTimer = () => {};
    playlist.Play = () => playlist.currentFile.id;
    playlist.Stop = () => 'stopped';
    const resolve = async () => ({id: 'folder'});
    assert.equal(await playlist.PlayFolder({mode: 'normal', startFile: 'selected'}, resolve), 'selected');
    assert.equal(playlist.files.length, 3);
    assert.equal(playlist.PlayNext(), 'last');
    assert.equal(playlist.PlayNext(), 'stopped');
    await assert.rejects(playlist.PlayFolder({mode: 'normal', startFile: 'missing'}, resolve), /file not found/i);
});

test('a cancelled finishing trigger cannot clear a newer playback wait', async () => {
    const started = new Defer();
    const trigger = new Defer();
    const playlist = Object.create(PlaylistManager.prototype);
    playlist.homey = {__: translator(english)};
    playlist.currentFile = {id: 'first', duration: 0};
    playlist.uPnPPlayer = {
        getSetting: () => 1,
        setCapabilityValue: () => {},
        driver: { Triggers: { finished_trigger: { Card: { trigger: () => {
            started.resolve();
            return trigger.promise;
        } } } } }
    };

    const first = playlist.SetFinishedTimer();
    const cancelled = assert.rejects(first, /cancelled/);
    await started.promise;
    playlist.currentFile = {id: 'second', duration: 60000};
    const second = playlist.SetFinishedTimer();
    const secondCancelled = assert.rejects(second, /cancelled/);
    const secondDeferred = playlist.finishedTimerDeferred;
    trigger.resolve();
    await cancelled;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(playlist.finishedTimerDeferred, secondDeferred);
    playlist.ClearFinishedTimer();
    await secondCancelled;
});
