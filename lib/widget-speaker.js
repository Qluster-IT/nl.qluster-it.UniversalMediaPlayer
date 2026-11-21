'use strict';

const {parseStringPromise, processors} = require('xml2js');
const {readSamsungTv} = require('./samsung-tv-info');
const {adapter, soap, topology, roomGroup, groupKey, idOf, seconds, waitFor, castCall, sonosInput, isOwned, runExclusive} =
    require('./direct-speaker-session').controller;

const xmlOptions = {explicitArray: false, tagNameProcessors: [processors.stripPrefix]};
const list = value => [].concat(value ?? []);
const text = value => typeof value === 'string' ? value : value?._ || '';
const positive = value => ['string', 'number'].includes(typeof value) &&
    Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const unavailableQueue = () => ({items: [], offset: 0, next: null, unavailable: true});
const idPattern = /^(?:cast:|dlna:uuid:)[^\s]{1,200}$/;
const volumeRanges = new WeakMap();
const pendingStates = new WeakMap();
const rejectedAudio = new WeakMap();
const transportActions = {play: 'Play', pause: 'Pause', stop: 'Stop', next: 'Next', previous: 'Previous', seek: 'Seek'};
// HTAudioIn identifiers documented in SoCo's soundbar audio format table.
const tvFormats = new Map([
    [2, 'Stereo'], [7, 'Dolby Digital 2.0'], [18, 'Dolby Digital 5.1'],
    [59, 'Dolby Atmos (DD+)'], [61, 'Dolby Atmos (TrueHD)'], [63, 'Dolby Atmos (MAT 2.0)'],
    [33554434, 'PCM 2.0'], [33554488, 'Dolby Digital 2.0'], [33554490, 'Dolby Digital Plus 2.0'],
    [33554492, 'Dolby TrueHD 2.0'], [33554494, 'Dolby Multichannel PCM 2.0'],
    [84934658, 'Multichannel PCM 5.1'], [84934713, 'Dolby Digital 5.1'], [84934714, 'Dolby Digital Plus 5.1'],
    [84934716, 'Dolby TrueHD 5.1'], [84934718, 'Dolby Multichannel PCM 5.1'], [84934721, 'DTS 5.1'],
    [118489090, 'Multichannel PCM 7.1'], [118489146, 'Dolby Digital Plus 7.1'], [118489148, 'Dolby TrueHD 7.1']
]);

async function optional(homey, read) {
    try { return await read(); }
    catch (error) { homey.app.log?.('Speaker controller capability unavailable:', error.message); return null; }
}

async function resolve(homey, id) {
    if (typeof id !== 'string' || !idPattern.test(id)) throw new Error(homey.__('widget.invalidAction'));
    return homey.app.speakerPlayback.selectForControl({id});
}

async function context(homey, id) {
    const room = await resolve(homey, id);
    if (room.protocol !== 'sonos' || !room.topology) return {room, target: room};
    const groups = await topology(room).catch(error => {
        homey.app.speakerPlayback.controlConnectionFailed?.(room, error);
        throw error;
    });
    const group = roomGroup(groups, room);
    const target = group.coordinator === idOf(room) ? room : await resolve(homey, `dlna:uuid:${group.coordinator.toLowerCase()}`);
    return {room, target, groups, group};
}

function trackConnection(homey, ctx, work) {
    return work().catch(error => {
        homey.app.speakerPlayback.controlConnectionFailed?.(ctx.room, error);
        if (ctx.target !== ctx.room) homey.app.speakerPlayback.controlConnectionFailed?.(ctx.target, error);
        throw error;
    });
}

function locked({room, target, group}) {
    return isOwned(room) || isOwned(target) || Boolean(group?.members.some(member =>
        isOwned({id: member.id, protocol: 'sonos'})));
}

async function metadata(homey, value, target) {
    if (!value || typeof value !== 'string') return {};
    const didl = await optional(homey, () => parseStringPromise(value, xmlOptions));
    const item = list(didl?.['DIDL-Lite']?.item)[0];
    return {track: text(item?.title), artist: text(item?.artist) || text(item?.creator), album: text(item?.album),
        artwork: art(text(item?.albumArtURI), target.endpoint)};
}

async function nowPlaying(homey, playback, target) {
    const trackMetadata = playback.position?.TrackMetaData;
    const info = await metadata(homey, trackMetadata || playback.metadata, target);
    if (!info.artwork && trackMetadata && trackMetadata !== playback.metadata) {
        const source = await metadata(homey, playback.metadata, target);
        info.artwork = source.artwork;
    }
    return info;
}

function art(value, base) {
    if (!value) return null;
    try {
        const url = new URL(value, base);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
}

async function range(homey, room, control) {
    if (!volumeRanges.has(room)) volumeRanges.set(room, optional(homey, () => control.volumeRange()));
    return volumeRanges.get(room);
}

async function snapshot(homey, ctx, control, volumeControl) {
    const {room, target} = ctx;
    const cast = target.protocol === 'cast';
    const tvInfo = readSamsungTv(room, (...args) => homey.app.log?.(...args));
    const observed = await control.read(cast).catch(async error => {
        if (!await tvInfo) throw error;
        homey.app.log?.('Samsung TV playback status unavailable:', error.message);
        return null;
    });
    const playback = observed || {};
    const activeInput = target.protocol === 'sonos' ? sonosInput(playback.uri || playback.track) : null;
    const isLocked = locked(ctx);
    const [rangeInfo, rawVolume, muted, currentActions, mode, info, zone, televisionInfo] = await Promise.all([
        range(homey, room, volumeControl),
        (cast || room.rendering) && optional(homey, () => volumeControl.getVolume()),
        (cast || room.rendering) && optional(homey, () => volumeControl.getMute()),
        observed && !cast && optional(homey, () => soap(target, 'GetCurrentTransportActions')),
        observed && !cast && optional(homey, () => soap(target, 'GetTransportSettings')),
        observed && !cast && !activeInput && nowPlaying(homey, playback, target),
        activeInput === 'tv' && target.properties && optional(homey, () => soap(target.properties, 'GetZoneInfo', {}, false)),
        tvInfo
    ]);
    const actions = {};
    const status = playback.status;
    const mask = status?.supportedMediaCommands;
    const maskHas = bit => typeof mask === 'number' && Boolean(mask & bit);
    const current = typeof currentActions?.Actions === 'string'
        ? currentActions.Actions.split(',').map(value => value.trim().toLowerCase()) : null;
    const hasMedia = Boolean(playback.uri || activeInput);
    const castItems = Array.isArray(status?.items) ? status.items : [];
    const nextTrack = cast ? castItems.findIndex(item => item.itemId === status.currentItemId) : -1;
    const nativeQueue = !cast && target.protocol === 'sonos' && Boolean(target.directory) && /^x-rincon-queue:/i.test(playback.uri);
    if (cast && status?.mediaSessionId != null) {
        actions.play = true;
        actions.pause = maskHas(1);
        actions.seek = maskHas(2) && Number.isFinite(playback.media?.duration);
        actions.stop = true;
        actions.next = maskHas(64) || (nextTrack >= 0 && nextTrack + 1 < castItems.length);
        actions.previous = maskHas(128) || nextTrack > 0;
        actions.repeat = maskHas(32);
    } else if (!cast && hasMedia) {
        for (const [action, command] of Object.entries(transportActions)) {
            actions[action] = current ? current.includes(command.toLowerCase()) :
                ['play', 'pause', 'stop'].includes(action);
        }
        actions.seek = !activeInput && actions.seek && seconds(playback.position?.TrackDuration) > 0;
        actions.repeat = actions.shuffle = target.protocol === 'sonos' && nativeQueue && Boolean(mode?.PlayMode);
    }
    const volume = rangeInfo && Number.isFinite(rawVolume)
        ? Math.max(0, Math.min(1, (rawVolume - rangeInfo.min) / (rangeInfo.max - rangeInfo.min))) : null;
    const rejected = !hasMedia ? rejectedAudio.get(room) : null;
    actions.volume = volume != null && !rejected?.has('volume');
    actions.mute = typeof muted === 'number' && !rejected?.has('mute');
    actions.playQueueItem = nativeQueue || (cast && status?.mediaSessionId != null && castItems.length > 0);
    const media = playback.media?.metadata;
    const rawArtwork = cast ? art(media?.images?.[0]?.url) : info?.artwork;
    const artwork = rawArtwork && homey.app.speakerArtwork
        ? await optional(homey, () => homey.app.speakerArtwork.host(rawArtwork, target)) || rawArtwork
        : rawArtwork;
    return {
        id: room.id, name: room.name, native: true, protocol: room.protocol, locked: isLocked,
        ...(room.kind === 'tv' && {television: true, model: televisionInfo?.model || room.model, televisionInfo}),
        activeInput,
        audioFormat: tvFormats.get(Number(zone?.HTAudioIn)) ?? null,
        currentTarget: {id: room.id, name: room.name}, coordinator: target.name,
        roomCount: ctx.group?.members.filter(member => !member.hidden).length,
        playing: playback.state === 'PLAYING', paused: playback.state === 'PAUSED_PLAYBACK',
        ...(cast ? {track: media?.title || '', artist: media?.artist || '', album: media?.albumName || '',
        } : info),
        artwork,
        artworkFallback: artwork !== rawArtwork ? rawArtwork : null,
        position: activeInput ? 0 : cast ? (Number(playback.currentTime) || 0) * 1000 : seconds(playback.position?.RelTime) * 1000 || 0,
        duration: activeInput ? 0 : cast ? (Number(playback.media?.duration) || 0) * 1000 : seconds(playback.position?.TrackDuration) * 1000 || 0,
        trackNumber: activeInput ? null : cast ? (nextTrack < 0 ? null : nextTrack + 1) : positive(playback.position?.Track),
        trackTotal: activeInput ? null : cast ? castItems.length || null : positive(playback.trackCount),
        canPlay: hasMedia, volume, muted: typeof muted === 'number' ? Boolean(muted) : null, actions,
        shuffle: cast ? status?.repeatMode === 'REPEAT_ALL_AND_SHUFFLE' : /SHUFFLE/.test(mode?.PlayMode || ''),
        repeat: cast ? (status?.repeatMode === 'REPEAT_SINGLE' ? 'track' : /^REPEAT_ALL/.test(status?.repeatMode) ? 'playlist' : 'none')
            : mode?.PlayMode === 'REPEAT_ONE' || mode?.PlayMode === 'SHUFFLE_REPEAT_ONE' ? 'track'
                : ['REPEAT_ALL', 'SHUFFLE'].includes(mode?.PlayMode) ? 'playlist' : 'none'
    };
}

async function withControls(ctx, work) {
    const control = adapter(ctx.target);
    const volumeControl = ctx.room === ctx.target ? control : adapter(ctx.room);
    try { return await work(control, volumeControl); }
    finally {
        control.close();
        if (volumeControl !== control) volumeControl.close();
    }
}

async function nativeQueue(ctx, control, requested, size) {
    const {target} = ctx;
    const cast = target.protocol === 'cast';
    const state = await control.read(cast);
    const pageFor = number => Math.floor(Math.max(0, number - 1) / size) * size;
    if (cast) {
        const {items, mediaSessionId, currentItemId} = state.status || {};
        if (!Array.isArray(items) || !items.length || mediaSessionId == null) return unavailableQueue();
        const currentNumber = items.findIndex(item => item.itemId === currentItemId) + 1;
        const offset = requested === 'current' ? pageFor(currentNumber) : Math.min(requested, pageFor(items.length));
        return {offset, currentNumber, total: items.length, next: offset + size < items.length ? offset + size : null,
            items: items.slice(offset, offset + size).map((item, index) => ({
                id: `${state.app}:${mediaSessionId}:${item.itemId}`, name: item.media?.metadata?.title || '',
                number: offset + index + 1, current: item.itemId === currentItemId
            }))};
    }
    if (target.protocol !== 'sonos' || !target.directory || !/^x-rincon-queue:/i.test(state.uri)) return unavailableQueue();
    const currentNumber = positive(state.position?.Track);
    const read = offset => soap(target.directory, 'Browse', {
        ObjectID: 'Q:0', BrowseFlag: 'BrowseDirectChildren', Filter: 'dc:title',
        StartingIndex: offset, RequestedCount: size, SortCriteria: ''
    }, false);
    let offset = requested === 'current' ? pageFor(currentNumber) : requested;
    let result = await read(offset);
    if (offset > 0 && Number(result.TotalMatches) <= offset) {
        offset = pageFor(Number(result.TotalMatches));
        result = await read(offset);
    }
    const items = Number(result.TotalMatches) === 0 && !result.Result ? [] :
        list((await parseStringPromise(result.Result, xmlOptions))?.['DIDL-Lite']?.item);
    if (items.length > size || !items.every(item => typeof item.$?.id === 'string')) throw new Error('Invalid Sonos queue page.');
    const total = Number(result.TotalMatches);
    return {offset, currentNumber, total, next: offset + items.length < total && items.length ? offset + items.length : null,
        items: items.map((item, index) => ({id: `${target.id}:${result.UpdateID}:${item.$.id}`, name: text(item.title),
            number: offset + index + 1, current: offset + index + 1 === currentNumber}))};
}

async function groups(homey, ctx) {
    if (!ctx.group) return [];
    const speakers = await homey.app.speakerPlayback.listSpeakers();
    const names = new Map(speakers.map(speaker => [idOf(speaker), speaker.name]));
    const enabled = !locked(ctx);
    return ctx.groups.flatMap(group => {
        const joined = group === ctx.group;
        const members = group.members.filter(member => !member.hidden);
        const inUse = group.members.some(member => isOwned({id: member.id, protocol: 'sonos'}));
        return members.map(member => ({
            id: `dlna:uuid:${member.id.toLowerCase()}`, name: names.get(member.id) || member.id,
            joined, coordinator: member.id === group.coordinator,
            otherGroup: !joined && members.length > 1 ? names.get(group.coordinator) || group.coordinator : null,
            editable: enabled && !inUse && names.has(member.id) && (joined ?
                member.id !== idOf(ctx.room) && member.id !== group.coordinator : members.length === 1)
        }));
    }).sort((a, b) => Number(b.joined) - Number(a.joined) || a.name.localeCompare(b.name));
}

async function roomVolume(homey, ctx, id, value) {
    const room = await resolve(homey, id);
    if (!ctx.group || room.protocol !== 'sonos' || roomGroup(ctx.groups, room) !== ctx.group) {
        throw new Error(homey.__('widget.invalidAction'));
    }
    if (value !== undefined && groupKey(roomGroup(await topology(ctx.room), ctx.room)) !== groupKey(ctx.group)) {
        throw new Error('Sonos grouping changed; reload rooms.');
    }
    const selected = {room, target: room};
    return trackConnection(homey, selected, () => withControls(selected, async control => {
        if (value !== undefined) await control.setVolume(Math.round(value * 100));
        return (await control.getVolume()) / 100;
    }));
}

async function roomPanel(homey, ctx) {
    const rooms = await groups(homey, ctx);
    // Read room levels only with this panel open, in bounded batches.
    const joined = rooms.filter(room => room.joined);
    for (let i = 0; i < joined.length; i += 4) {
        await Promise.all(joined.slice(i, i + 4).map(async room => {
            room.volume = await optional(homey, () => roomVolume(homey, ctx, room.id));
        }));
    }
    const groupVolume = ctx.target.groupRendering && await optional(homey, async () => {
        const {CurrentVolume} = await soap(ctx.target.groupRendering, 'GetGroupVolume');
        return /^\d{1,3}$/.test(CurrentVolume) && Number(CurrentVolume) <= 100 ? Number(CurrentVolume) / 100 : null;
    });
    return {rooms, groupVolume: groupVolume ?? null, roomCount: joined.length, locked: locked(ctx)};
}

async function groupRoom(homey, ctx, value, joined) {
    const room = await resolve(homey, value);
    if (!ctx.group || room.protocol !== 'sonos' || idOf(room) === idOf(ctx.room)) throw new Error(homey.__('widget.invalidAction'));
    const previous = roomGroup(ctx.groups, room);
    if (locked({...ctx, group: previous}) || locked(ctx) || idOf(room) === ctx.group.coordinator ||
        (joined ? previous === ctx.group || previous.members.filter(member => !member.hidden).length !== 1 : previous !== ctx.group)) {
        throw new Error(homey.__('widget.invalidAction'));
    }
    const latest = await topology(ctx.room);
    if (groupKey(roomGroup(latest, ctx.room)) !== groupKey(ctx.group) ||
        groupKey(roomGroup(latest, room)) !== groupKey(previous)) throw new Error('Sonos grouping changed; reload rooms.');
    if (joined) await soap(room, 'SetAVTransportURI', {CurrentURI: `x-rincon:${ctx.group.coordinator}`, CurrentURIMetaData: ''});
    else await soap(room, 'BecomeCoordinatorOfStandaloneGroup');
    await waitFor(async () => {
        const observed = roomGroup(await topology(ctx.room), room);
        return observed.coordinator === (joined ? ctx.group.coordinator : idOf(room));
    }, 'Sonos did not confirm the requested grouping.');
}

async function command(homey, ctx, body, control, volumeControl) {
    const before = await snapshot(homey, ctx, control, volumeControl);
    const {action, value} = body;
    const writeAudio = async (capability, write) => {
        try {
            await write();
            return true;
        } catch (error) {
            if (!before.television || !['401', '501'].includes(error.upnpCode)) throw error;
            homey.app.log?.('TV rejected DLNA audio control:', error.message);
            if (!before.canPlay) {
                if (!rejectedAudio.has(ctx.room)) rejectedAudio.set(ctx.room, new Set());
                rejectedAudio.get(ctx.room).add(capability);
            }
            before.actions[capability] = false;
            before.controlRejected = true;
            return false;
        }
    };
    const cast = ctx.target.protocol === 'cast';
    const castCommand = async (type, options = {}) => {
        const status = await castCall(control.player, 'getStatus');
        if (status?.mediaSessionId == null) throw new Error('No active Cast media session.');
        const response = await castCall(control.player.media, 'request', {type, ...options, mediaSessionId: status.mediaSessionId});
        if (response?.type !== 'MEDIA_STATUS') throw new Error(`Cast did not confirm ${type}.`);
    };
    const requireValid = condition => { if (!condition) throw new Error(homey.__('widget.invalidAction')); };
    if (['volume', 'volumeDown', 'volumeUp'].includes(action)) {
        requireValid(before.actions.volume);
        const step = body.step ?? 5;
        requireValid(action === 'volume' ? Number.isFinite(value) && value >= 0 && value <= 1 :
            Number.isInteger(step) && step > 0 && step <= 100);
        const level = action === 'volume' ? value : Math.max(0, Math.min(1, before.volume + (action === 'volumeUp' ? step : -step) / 100));
        const {min, max, step: increment} = await range(homey, ctx.room, volumeControl);
        if (!await writeAudio('volume', () => volumeControl.setVolume(
            Math.min(max, min + Math.round(level * (max - min) / increment) * increment)))) return before;
    } else if (action === 'mute') {
        requireValid(before.actions.mute && typeof value === 'boolean');
        if (before.muted !== value) {
            if (!await writeAudio('mute', () => volumeControl.setMute(Number(value)))) return before;
            if (ctx.room.kind === 'tv' && (await volumeControl.getMute()) !== Number(value)) {
                homey.app.log?.('The TV did not confirm the requested mute state.');
                return {...before, controlRejected: true};
            }
        }
    } else if (action === 'playQueueItem') {
        requireValid(before.actions.playQueueItem && positive(body.number) === body.number && typeof body.item === 'string');
        const page = await nativeQueue(ctx, control, body.number - 1, 1);
        requireValid(page.items[0]?.id === body.item && page.items[0].number === body.number);
        if (cast) await castCommand('QUEUE_UPDATE', {currentItemId: Number(body.item.split(':').at(-1))});
        else await soap(ctx.target, 'Seek', {Unit: 'TRACK_NR', Target: body.number});
    } else if (action === 'repeat' || action === 'shuffle') {
        requireValid(before.actions[action] && (action === 'repeat' ? ['none', 'playlist', 'track'].includes(value) : typeof value === 'boolean'));
        const shuffle = action === 'shuffle' ? value : before.shuffle;
        const repeat = action === 'repeat' ? value : before.repeat;
        if (cast) await castCommand('QUEUE_UPDATE', {
            repeatMode: repeat === 'track' ? 'REPEAT_SINGLE' : repeat === 'playlist' ?
                (shuffle ? 'REPEAT_ALL_AND_SHUFFLE' : 'REPEAT_ALL') : 'REPEAT_OFF'});
        else await soap(ctx.target, 'SetPlayMode', {NewPlayMode: shuffle ?
            ({none: 'SHUFFLE_NOREPEAT', playlist: 'SHUFFLE', track: 'SHUFFLE_REPEAT_ONE'})[repeat] :
            ({none: 'NORMAL', playlist: 'REPEAT_ALL', track: 'REPEAT_ONE'})[repeat]});
    } else {
        requireValid(Object.hasOwn(transportActions, action) && before.actions[action]);
        if (action === 'seek') {
            requireValid(Number.isFinite(value) && value >= 0 && value <= before.duration);
            if (cast) await castCommand('SEEK', {currentTime: value / 1000});
            else {
                const time = Math.floor(value / 1000);
                const parts = [Math.floor(time / 3600), Math.floor(time / 60) % 60, time % 60];
                await soap(ctx.target, 'Seek', {Unit: 'REL_TIME', Target: parts.map(n => String(n).padStart(2, '0')).join(':')});
            }
        } else if (cast && ['next', 'previous'].includes(action)) {
            await castCommand('QUEUE_UPDATE', {jump: action === 'next' ? 1 : -1});
        } else if (cast) await castCommand(transportActions[action].toUpperCase());
        else await control.command(transportActions[action]);
    }
    return snapshot(homey, ctx, control, volumeControl);
}

module.exports = {
    async state(homey, id) {
        if (!pendingStates.has(homey.app)) pendingStates.set(homey.app, new Map());
        const pending = pendingStates.get(homey.app);
        if (!pending.has(id)) pending.set(id, (async () => {
            const ctx = await context(homey, id);
            for (const endpoint of [ctx.target.events, ctx.target.directory?.events, ctx.room.rendering?.events,
                ctx.room.topologyEvents, ctx.target.groupRendering?.events]) homey.app.speakerEvents?.watch(id, endpoint);
            return trackConnection(homey, ctx, () =>
                withControls(ctx, (control, volumeControl) => snapshot(homey, ctx, control, volumeControl)));
        })().finally(() => pending.delete(id)));
        return pending.get(id);
    },
    async playlist(homey, id, offset, size) {
        const ctx = await context(homey, id);
        return trackConnection(homey, ctx, () => withControls(ctx, control => nativeQueue(ctx, control, offset, size)));
    },
    async control(homey, body, destination = false) {
        if (body.action === 'listSources') {
            const playback = homey.app.speakerPlayback;
            const sources = await playback.listSpeakers(body.fresh === true, body.wait === true);
            return {sources, refreshing: Boolean(playback.pending)};
        }
        if (body.action === 'listRooms') {
            if (body.summary === true) {
                const room = await resolve(homey, body.speaker);
                if (room.protocol !== 'sonos' || !room.topology) return {supported: false};
                const group = roomGroup(await trackConnection(homey, {room, target: room}, () => topology(room)), room);
                homey.app.speakerEvents?.watch(body.speaker, room.topologyEvents);
                return {roomCount: group.members.filter(member => !member.hidden).length};
            }
            const ctx = await context(homey, body.speaker);
            if (destination && !ctx.group) return {supported: false};
            homey.app.speakerEvents?.watch(body.speaker, ctx.room.topologyEvents);
            return trackConnection(homey, ctx, () => roomPanel(homey, ctx));
        }
        return runExclusive(async () => {
            const ctx = await context(homey, body.speaker);
            return trackConnection(homey, ctx, async () => {
                if (['roomVolume', 'groupVolume'].includes(body.action)) {
                    if (!ctx.group || !Number.isFinite(body.value) || body.value < 0 || body.value > 1 ||
                        (body.action === 'groupVolume' && !ctx.target.groupRendering)) throw new Error(homey.__('widget.invalidAction'));
                    if (body.action === 'roomVolume') await roomVolume(homey, ctx, body.room, body.value);
                    else {
                        if (groupKey(roomGroup(await topology(ctx.room), ctx.room)) !== groupKey(ctx.group)) {
                            throw new Error('Sonos grouping changed; reload rooms.');
                        }
                        await soap(ctx.target.groupRendering, 'SnapshotGroupVolume');
                        await soap(ctx.target.groupRendering, 'SetGroupVolume', {DesiredVolume: Math.round(body.value * 100)});
                    }
                    return roomPanel(homey, ctx);
                }
                if (locked(ctx) && !['volume', 'volumeUp', 'volumeDown', 'mute'].includes(body.action)) {
                    throw new Error(homey.__('widget.invalidAction'));
                }
                if (['joinRoom', 'leaveRoom'].includes(body.action)) {
                    await groupRoom(homey, ctx, body.value, body.action === 'joinRoom');
                    return roomPanel(homey, await context(homey, body.speaker));
                }
                return {player: await withControls(ctx, (control, volumeControl) => command(homey, ctx, body, control, volumeControl))};
            });
        });
    }
};
