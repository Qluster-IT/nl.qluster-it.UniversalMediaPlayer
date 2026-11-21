'use strict';

const {createHash} = require('node:crypto');
const {requestVolume, stepVolume} = require('./speaker-volume');
const speaker = require('./widget-speaker');
const widgetPlayback = require('./widget-playback');
const {DEFAULT_TARGET, CURRENT_TARGET, updateTarget, listTargets, validateTarget, saveTarget} =
    require('../drivers/upnpplayer/playback-target');
const PAGE_SIZE = 50;

function pageSize(homey, size = PAGE_SIZE) {
    if (!Number.isInteger(size) || size < 1 || size > 200) throw new Error(homey.__('widget.invalidAction'));
    return size;
}

function getPlayers(homey) {
    return homey.drivers.getDriver('upnpplayer').getDevices();
}

function getPlayer(homey, id) {
    const player = getPlayers(homey).find(device => device.getData().id === id) || widgetPlayback.byOwner(homey, id);
    if (!player) throw new Error(homey.__('widget.selectPlayer'));
    if (!player.getAvailable() || !player.playlistManager) {
        throw new Error(homey.__('widget.unavailable'));
    }
    return player;
}

function owningPlayer(homey, id) {
    return widgetPlayback.owned(homey, id);
}

async function widgetPlayer(homey, body) {
    return owningPlayer(homey, body.speaker) || widgetPlayback.get(getPlayer(homey, body.player), body.widget);
}

function playerState(homey, player) {
    const playlist = player.playlistManager;
    const file = playlist.currentFile;
    const duration = Number(file && file.duration);
    const path = file?.libraryPath || playlist.folder?.libraryPath || [];
    const folderPath = playlist.folder?.libraryPath || [];
    const playingFolder = Boolean(playlist.folder) && (!file?.libraryPath
        || JSON.stringify(file.libraryPath.map(part => part.id)) === JSON.stringify(folderPath.map(part => part.id)));
    const setting = player.getSetting?.('recentFolderLimit');
    const recentLimit = Number.isInteger(setting) && setting >= 0 && setting <= 100 ? setting : 10;
    return {
        id: player.widgetPlayerId || player.getData().id,
        contextId: player.getData().id + ':' + (playlist.PlaybackTarget?.()?.id || ''),
        ownerWidget: player.getStoreValue?.('widgetPlaybackController')?.widget || null,
        libraryPlayer: player.widgetPlayerId || player.getData().id,
        canBrowse: true,
        name: player.getName(),
        defaultTarget: targetSummary(player.getStoreValue?.(DEFAULT_TARGET)),
        currentTarget: targetSummary(player.getStoreValue?.(CURRENT_TARGET)),
        playing: Boolean(playlist.playing),
        paused: Boolean(playlist.paused),
        interrupted: Boolean(playlist.paused && playlist.restartOnSpeakerResume),
        track: file?.name || '',
        artist: file?.artist || '',
        album: file?.album || '',
        duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
        position: playlist.position || 0,
        artwork: playlist._albumUrl && playlist.image && homey.app.widgetHomeyId
            ? `https://${homey.app.widgetHomeyId}.connect.athom.com/api/image/${playlist.image.id}?v=${createHash('sha256').update(playlist._albumUrl).digest('hex').slice(0, 16)}`
            : null,
        shuffle: Boolean(playlist.mode && playlist.mode.startsWith('random')),
        repeat: playlist.mode?.endsWith('repeat') ? 'playlist'
            : playlist.mode?.endsWith('single') && player.getCapabilityValue('speaker_repeat') === 'track' ? 'track' : 'none',
        volume: player.getCapabilityValue('volume_set') ?? null,
        muted: player.getCapabilityValue('volume_mute') ?? null,
        canPlay: Boolean(file),
        canNavigate: Boolean(file && playlist.files && playlist.files.length > 1),
        recentFolders: (playlist.recentFolders || []).slice(0, recentLimit),
        sleep: playlist.sleep || null,
        selection: file ? {
            path,
            folder: playingFolder,
            file: {id: String(file.id), name: file.name}
        } : null
    };
}

function targetSummary(target) {
    return target ? {id: target.id, name: target.name, description: target.description} : null;
}

function browsePage(homey, player, folder, offset, size = PAGE_SIZE) {
    if (typeof folder !== 'string' || !folder || folder.length > 1024
        || !Number.isSafeInteger(offset) || offset < 0) {
        throw new Error(homey.__('widget.invalidAction'));
    }
    return player.server.browseById({id: folder, search: 'folders,files', page: {offset, size: pageSize(homey, size)}});
}

function queueView(playlist) {
    const single = playlist.mode?.endsWith('single');
    const files = playlist.files || [];
    const order = !single && playlist.order ? playlist.order : null;
    return {
        files,
        order,
        total: single ? Number(Boolean(playlist.currentFile)) : files.length,
        indexAt: position => single ? files.indexOf(playlist.currentFile) : order ? order[position] : position
    };
}

module.exports = {
    getPlayers,
    async browse({homey, body}) {
        const player = await widgetPlayer(homey, body);
        const size = pageSize(homey, body.size);
        const query = body.filter ?? '';
        if (typeof query !== 'string' || query.length > 200) throw new Error(homey.__('widget.invalidAction'));
        const filter = query.trim().toLocaleLowerCase();
        const cursor = body.offset ?? 0;
        let offset = typeof cursor === 'object' && cursor ? cursor.offset : cursor;
        let skip = typeof cursor === 'object' && cursor ? cursor.skip : 0;
        if (!Number.isInteger(skip) || skip < 0 || skip >= size) throw new Error(homey.__('widget.invalidAction'));
        const results = [];
        const deadline = Date.now() + 20000;
        do {
            const page = await browsePage(homey, player, body.folder ?? '0', offset, size);
            for (let i = skip; i < page.items.length; i++) {
                const item = page.items[i];
                if (filter && !(item.realName || item.name || '').toLocaleLowerCase().includes(filter)) continue;
                if (results.length === size) return {items: results, next: {offset, skip: i}};
                results.push({
                    id: item.id,
                    name: item.realName || item.name,
                    folder: Object.hasOwn(item, 'realName'),
                    playable: Boolean(item.url),
                    offset,
                    size
                });
            }
            if (!filter || page.next == null) return {items: results, next: page.next};
            if (!Number.isSafeInteger(page.next) || page.next <= offset || Date.now() > deadline) {
                throw new Error(homey.__('browse.browseError'));
            }
            offset = page.next;
            skip = 0;
        } while (true);
    },
    async playlist({homey, body}) {
        const size = pageSize(homey, body.size);
        const requestedOffset = body.offset ?? 0;
        if (requestedOffset !== 'current' && (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0)) {
            throw new Error(homey.__('widget.invalidAction'));
        }
        const owned = body.speaker && owningPlayer(homey, body.speaker);
        if (body.speaker && !owned) return speaker.playlist(homey, body.speaker, requestedOffset, size);
        const player = owned || await widgetPlayer(homey, body);
        if (body.observing) {
            if (body.observing !== player.playlistManager.PlaybackTarget?.()?.id) {
                throw new Error(homey.__('widget.invalidAction'));
            }
            if (!player.playlistManager.currentFile) return speaker.playlist(homey, body.observing, requestedOffset, size);
        }
        const playlist = player.playlistManager;
        const {files, order, total, indexAt} = queueView(playlist);
        const currentIndex = files.indexOf(playlist.currentFile);
        const currentPosition = currentIndex < 0 ? -1 : playlist.mode?.endsWith('single') ? 0
            : order ? order.indexOf(currentIndex) : currentIndex;
        const pageOffset = position => Math.floor(Math.max(0, position) / size) * size;
        let offset = requestedOffset;
        if (offset === 'current') {
            const index = files.indexOf(playlist.currentFile);
            offset = total === 1 ? 0 : pageOffset(order ? order.indexOf(index) : index);
        } else if (offset >= total) {
            offset = pageOffset(total - 1);
        }
        return {
            items: Array.from({length: Math.max(0, Math.min(size, total - offset))}, (_, i) => {
                const file = files[indexAt(offset + i)];
                return {id: file.id, name: file.name, number: offset + i + 1, current: file === playlist.currentFile};
            }),
            offset,
            currentNumber: currentPosition < 0 ? null : currentPosition + 1,
            next: offset + size < total ? offset + size : null,
            total,
            shuffle: Boolean(playlist.mode?.startsWith('random'))
        };
    },
    async state({homey, query}) {
        const devices = getPlayers(homey);
        const players = devices.map(player => ({
            id: player.getData().id,
            name: player.getName()
        }));
        if (query.speaker) {
            try {
                const native = await speaker.state(homey, query.speaker);
                const owned = owningPlayer(homey, query.speaker);
                if (owned) {
                    const local = playerState(homey, owned);
                    return {players, player: {...native, managed: true, locked: false,
                        contextId: local.contextId, libraryPlayer: local.libraryPlayer, canBrowse: true,
                        ownerWidget: local.ownerWidget,
                        selection: local.selection, recentFolders: local.recentFolders, sleep: local.sleep,
                        shuffle: local.shuffle, repeat: local.repeat, canNavigate: local.canNavigate,
                        actions: {...native.actions, play: local.canPlay, pause: local.playing, stop: local.canPlay,
                            next: local.canNavigate, previous: local.canNavigate,
                            seek: false,
                            shuffle: local.canPlay, repeat: local.canPlay, playQueueItem: local.canPlay}}, error: ''};
                }
                return {players, player: native, error: ''};
            }
            catch (error) {
                homey.app.log?.('Unable to read widget speaker:', error.message);
                homey.app.speakerPlayback?.refreshInBackground?.(true);
                return {players, player: null, error: homey.__('widget.unavailable')};
            }
        }
        const selected = devices.find(player => player.getData().id === query.player)
            || (!query.player && devices.length === 1 ? devices[0] : null);
        const available = selected && selected.getAvailable() && selected.playlistManager;
        const actual = available ? await widgetPlayback.get(selected, query.widget) : null;
        const preference = available && widgetPlayback.preference(selected, query.widget);
        let state = actual ? playerState(homey, actual) : null;
        const target = actual?.playlistManager.PlaybackTarget?.();
        if (query.widget != null && actual && !actual.playlistManager.currentFile &&
            /^(?:dlna:uuid:|cast:)/.test(target?.id)) {
            const native = await speaker.state(homey, target.id);
            state = {...state, ...native, contextId: state.contextId, libraryPlayer: state.libraryPlayer,
                canBrowse: true, observing: target.id,
                canNavigate: Boolean(native.actions?.next || native.actions?.previous)};
        }
        const destination = available && widgetPlayback.selection(selected, query.widget);
        if (query.widget != null && destination?.id !== target?.id && /^(?:dlna:uuid:|cast:)/.test(destination?.id)) {
            const native = await speaker.state(homey, destination.id);
            state = {...state, volume: native.volume, muted: native.muted};
        }
        return {
            players,
            player: state ? {...state, id: selected.getData().id,
                ...(preference ? {currentTarget: targetSummary(preference.target)} : {})} : null,
            error: query.player && !available ? homey.__('widget.unavailable') : ''
        };
    },
    async control({homey, body}) {
        if (body.action === 'getSourcePreference' || body.action === 'saveSourcePreference') {
            if (typeof body.widget !== 'string' || !/^[\w-]{1,128}$/.test(body.widget)) {
                throw new Error(homey.__('widget.invalidAction'));
            }
            const key = `widget-source-${body.widget}`;
            if (body.action === 'getSourcePreference') return {source: homey.settings.get(key) ?? null};
            const {kind, id} = body.source ?? {};
            if (typeof id !== 'string' || !id || id.length > 205 || !(
                kind === 'speaker' && /^(?:cast:|dlna:uuid:)[^\s]{1,200}$/.test(id) ||
                kind === 'player' && getPlayers(homey).some(device => device.getData().id === id)
            )) throw new Error(homey.__('widget.invalidAction'));
            await homey.settings.set(key, {kind, id});
            return {source: {kind, id}};
        }
        const owned = body.speaker && owningPlayer(homey, body.speaker);
        const audio = ['volume', 'volumeUp', 'volumeDown', 'mute'].includes(body.action);
        const selectedTarget = body.widget != null && body.player && !body.speaker &&
            widgetPlayback.selection(getPlayer(homey, body.player), body.widget);
        const selectedOwner = selectedTarget && owningPlayer(homey, selectedTarget.id);
        const memberAudio = audio && selectedOwner && selectedOwner.playlistManager.PlaybackTarget?.()?.id !== selectedTarget.id;
        if ((body.observing || memberAudio) && !body.speaker && ['play', 'pause', 'stop', 'next', 'previous', 'seek', 'shuffle',
            'repeat', 'playQueueItem', 'volume', 'volumeUp', 'volumeDown', 'mute'].includes(body.action)) {
            const player = await widgetPlayer(homey, body);
            if (body.observing && body.observing !== player.playlistManager.PlaybackTarget?.()?.id) {
                throw new Error(homey.__('widget.invalidAction'));
            }
            const result = await module.exports.control({homey, body: {...body,
                speaker: body.observing || selectedTarget.id, observing: undefined}});
            if (body.observing && audio && !result.player?.controlRejected) {
                if (result.player?.volume != null) await player.setCapabilityValue('volume_set', result.player.volume);
                if (result.player?.muted != null) await player.setCapabilityValue('volume_mute', result.player.muted);
            }
            const state = await module.exports.state({homey, query: {player: body.player, widget: body.widget}});
            return {...state, player: {...state.player, controlRejected: result.player?.controlRejected}};
        }
        const forwarded = owned && ['play', 'pause', 'stop', 'next', 'previous', 'shuffle', 'repeat', 'playQueueItem',
            'sleep', 'playFile', 'playFrom', 'playNext', 'playFolder'].includes(body.action);
        if ((body.speaker && !forwarded) || body.action === 'listSources') {
            const result = await speaker.control(homey, body);
            if (owned && ['volume', 'volumeUp', 'volumeDown', 'mute'].includes(body.action)) {
                if (!result.player?.controlRejected) await widgetPlayback.claim(owned, body.widget);
                if (owned.playlistManager.PlaybackTarget?.()?.id === body.speaker) {
                    if (result.player?.volume != null) await owned.setCapabilityValue('volume_set', result.player.volume);
                    if (result.player?.muted != null) await owned.setCapabilityValue('volume_mute', result.player.muted);
                }
                const state = await module.exports.state({homey, query: {speaker: body.speaker}});
                return {...state, player: {...state.player, controlRejected: result.player?.controlRejected}};
            }
            return result;
        }
        if (body.action === 'setTarget' && body.widget) {
            const parent = getPlayer(homey, body.player);
            return updateTarget(parent, async () => {
                const previous = (await widgetPlayback.get(parent, body.widget)).playlistManager.PlaybackTarget?.();
                const target = await validateTarget(homey, body.value, previous);
                await widgetPlayback.select(parent, body.widget, target);
                return module.exports.state({homey, query: {player: body.player, widget: body.widget}});
            });
        }
        const player = forwarded ? owned : await widgetPlayer(homey, body);
        const playlist = player.playlistManager;
        try {
            switch (body.action) {
                case 'listRooms':
                case 'joinRoom':
                case 'leaveRoom':
                case 'roomVolume':
                case 'groupVolume': {
                    const controlRooms = () => {
                        const target = selectedTarget || player.getStoreValue?.(CURRENT_TARGET) || player.getStoreValue?.(DEFAULT_TARGET);
                        if (!target || target.id !== body.target || !/^dlna:uuid:[^\s]{1,200}$/.test(target.id)) {
                            throw new Error(homey.__('widget.invalidAction'));
                        }
                        return speaker.control(homey, {...body, speaker: target.id}, true);
                    };
                    return await (body.action === 'listRooms' ? controlRooms() : updateTarget(player, controlRooms));
                }
                case 'listTargets': {
                    const targets = await listTargets(homey, body.fresh === true, body.wait === true);
                    return {targets: targets.map(targetSummary), refreshing: Boolean(homey.app.speakerPlayback.pending)};
                }
                case 'setTarget':
                    await updateTarget(player, async () => {
                        const previous = player.getStoreValue(CURRENT_TARGET) ?? null;
                        const target = await validateTarget(homey, body.value, previous);
                        await saveTarget(player, CURRENT_TARGET, target, previous, true);
                    });
                    break;
                case 'sleep':
                    await playlist.SetSleep(body.value);
                    break;
                case 'playQueueItem': {
                    if (!Number.isSafeInteger(body.number) || body.number < 1
                        || typeof body.item !== 'string' || !body.item || body.item.length > 1024) {
                        throw new Error(homey.__('widget.invalidAction'));
                    }
                    const {files, total, indexAt} = queueView(playlist);
                    const index = indexAt(body.number - 1);
                    if (body.number > total || files[index]?.id !== body.item) {
                        throw new Error(homey.__('playback.missingFile'));
                    }
                    if (!await playlist.PlayQueueItem(index)) throw new Error(homey.__('widget.noPlayback'));
                    break;
                }
                case 'volumeDown':
                case 'volumeUp':
                    await stepVolume(player, body.action === 'volumeUp' ? 1 : -1, body.step);
                    break;
                case 'volume':
                case 'mute':
                    await requestVolume(player, body.action === 'volume' ? 'volume_set' : 'volume_mute', body.value);
                    break;
                case 'playFile':
                case 'playFrom':
                case 'playNext':
                case 'playFolder': {
                    if (typeof body.item !== 'string' || !body.item || body.item.length > 1024) {
                        throw new Error(homey.__('widget.invalidAction'));
                    }
                    const folder = body.action === 'playFolder';
                    const path = body.path;
                    if (!Array.isArray(path) || path.length > 64 || path.some(part =>
                        !part || typeof part.id !== 'string' || !part.id || part.id.length > 1024
                        || typeof part.name !== 'string' || part.name.length > 1024
                        || (part.offset != null && (!Number.isSafeInteger(part.offset) || part.offset < 0))
                        || (part.size != null && (!Number.isInteger(part.size) || part.size < 1 || part.size > 200))
                    ) || (path.at(-1)?.id ?? '0') !== body.folder) {
                        throw new Error(homey.__('widget.invalidAction'));
                    }
                    const resolve = async () => {
                        // Paths captured by Flows don't have a paged browse offset.
                        const entries = folder && body.offset == null
                            ? await player.server.browseById({id: body.folder, search: 'folders'})
                            : (await browsePage(homey, player, body.folder, body.offset, body.size)).items;
                        const item = entries.find(item => item.id === body.item && Object.hasOwn(item, 'realName') === folder);
                        if (!item) return null;
                        const libraryPath = path.map(({id, name, offset, size}) =>
                            ({id, name, ...(offset == null ? {} : {offset}), ...(size == null ? {} : {size})}));
                        if (folder) libraryPath.push({
                            id: item.id, name: item.realName, offset: body.offset,
                            ...(body.size == null ? {} : {size: body.size})
                        });
                        return {...item, libraryPath};
                    };
                    if (body.action === 'playNext') {
                        const current = playlist.currentFile;
                        const revision = playlist.playbackRevision;
                        const file = await resolve();
                        if (!file) throw new Error(homey.__('playback.missingFile'));
                        if (current !== playlist.currentFile || revision !== playlist.playbackRevision) {
                            throw new Error(homey.__('widget.invalidAction'));
                        }
                        await playlist.QueueNext(file);
                        break;
                    }
                    const result = await (folder || body.action === 'playFrom'
                        ? playlist.PlayFolder({
                            mode: (playlist.mode?.startsWith('random') ? 'random' : '')
                                + (playlist.mode?.endsWith('repeat') ? 'repeat' : 'normal'),
                            ...(body.action === 'playFrom' ? {startFile: body.item} : {})
                        }, body.action === 'playFrom' ? async () => {
                            const file = await resolve();
                            if (!file) throw new Error(homey.__('playback.missingFile'));
                            return {id: body.folder, libraryPath: file.libraryPath};
                        } : resolve)
                        : playlist.PlayFile({}, resolve));
                    if (!result) throw new Error(homey.__('widget.noPlayback'));
                    break;
                }
                case 'play':
                    if (!playlist.currentFile) throw new Error(homey.__('widget.startFlow'));
                    if (await playlist.TogglePlay(true) === false) {
                        throw new Error(homey.__('widget.noPlayback'));
                    }
                    break;
                case 'stop':
                    await playlist.Stop();
                    break;
                case 'pause':
                    await playlist.Pause();
                    break;
                case 'previous':
                case 'next':
                    if (!playlist.currentFile || !playlist.files || playlist.files.length < 2) {
                        throw new Error(homey.__('widget.noPlaylist'));
                    }
                    if (await (body.action === 'previous' ? playlist.PlayPrevious() : playlist.PlayNext()) === false) {
                        throw new Error(homey.__('widget.noPlayback'));
                    }
                    break;
                case 'shuffle': {
                    if (typeof body.value !== 'boolean') throw new Error(homey.__('widget.invalidAction'));
                    await playlist.SetShuffle(body.value);
                    await player.setCapabilityValue('speaker_shuffle', body.value);
                    break;
                }
                case 'repeat':
                    if (!['none', 'playlist'].includes(body.value)) {
                        throw new Error(homey.__('widget.invalidAction'));
                    }
                    await playlist.SetRepeat(body.value);
                    await player.setCapabilityValue('speaker_repeat', body.value);
                    break;
                case 'seek':
                    throw new Error(homey.__('playback.seekUnsupported'));
                default:
                    throw new Error(homey.__('widget.invalidAction'));
            }
            await widgetPlayback.claim(player, body.widget);
        } catch (error) {
            homey.app.error('Media widget control failed:', error);
            throw error;
        }
        if (forwarded) return module.exports.state({homey, query: {speaker: body.speaker}});
        const state = playerState(homey, player);
        if (body.widget != null && body.player) {
            const preference = widgetPlayback.preference(getPlayer(homey, body.player), body.widget);
            state.id = body.player;
            if (preference) state.currentTarget = targetSummary(preference.target);
        }
        return {player: state};
    }
};
