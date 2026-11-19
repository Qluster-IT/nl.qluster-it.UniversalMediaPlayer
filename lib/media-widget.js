'use strict';

const {createHash} = require('node:crypto');
const {requestVolume, stepVolume} = require('./speaker-volume');
const PAGE_SIZE = 50;

function pageSize(homey, size = PAGE_SIZE) {
    if (!Number.isInteger(size) || size < 1 || size > 200) throw new Error(homey.__('widget.invalidAction'));
    return size;
}

function getPlayers(homey) {
    return homey.drivers.getDriver('upnpplayer').getDevices();
}

function getPlayer(homey, id) {
    const player = getPlayers(homey).find(device => device.getData().id === id);
    if (!player) throw new Error(homey.__('widget.selectPlayer'));
    if (!player.getAvailable() || !player.playlistManager) {
        throw new Error(homey.__('widget.unavailable'));
    }
    return player;
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
        id: player.getData().id,
        name: player.getName(),
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
        const player = getPlayer(homey, body.player);
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
        const player = getPlayer(homey, body.player);
        const playlist = player.playlistManager;
        const size = pageSize(homey, body.size);
        const requestedOffset = body.offset ?? 0;
        if (requestedOffset !== 'current' && (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0)) {
            throw new Error(homey.__('widget.invalidAction'));
        }
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
        const selected = devices.find(player => player.getData().id === query.player)
            || (!query.player && devices.length === 1 ? devices[0] : null);
        const available = selected && selected.getAvailable() && selected.playlistManager;
        return {
            players,
            player: available ? playerState(homey, selected) : null,
            error: query.player && !available ? homey.__('widget.unavailable') : ''
        };
    },
    async control({homey, body}) {
        const player = getPlayer(homey, body.player);
        const playlist = player.playlistManager;
        try {
            switch (body.action) {
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
        } catch (error) {
            homey.app.error('Media widget control failed:', error);
            throw error;
        }
        return {player: playerState(homey, player)};
    }
};
