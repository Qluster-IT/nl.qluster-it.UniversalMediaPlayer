'use strict';

const fetch = require('node-fetch');
const {randomUUID} = require('node:crypto');
const {parseStringPromise, processors} = require('xml2js');
const {setTimeout: delay} = require('node:timers/promises');
const playClip = require('./sonos-audio-clip');
const SpeakerPlayback = require('./speaker-playback');

const STORE = 'directSpeakerSessionV1';
const MAX_NOTIFICATION_MS = 60_000;
const XML_OPTIONS = {explicitArray: false, tagNameProcessors: [processors.stripPrefix]};
const TOPOLOGY = 'urn:schemas-upnp-org:service:ZoneGroupTopology:1';
const PLAYING = 'PLAYING';
const PAUSED = 'PAUSED_PLAYBACK';
const stopped = state => ['STOPPED', 'NO_MEDIA_PRESENT'].includes(state);
const supportedState = state => [PLAYING, PAUSED].includes(state) || stopped(state);
const array = value => [].concat(value ?? []);
const idOf = value => String(value?.id ?? value ?? '').replace(/^dlna:uuid:/i, '').toUpperCase();
const link = id => `x-rincon:${id}`;
const normalized = uri => uri?.replace(/^x-rincon-mp3radio:\/\/(?=https?:\/\/)/i, '') ?? '';
const sameUri = (a, b) => normalized(a) === normalized(b);
function sonosInput(uri) {
    if (/^x-sonos-htastream:/i.test(uri)) return 'tv';
    if (/^x-rincon-stream:/i.test(uri)) return 'lineIn';
    return null;
}
const input = uri => Boolean(sonosInput(uri));
function isAnnouncementUri(uri) {
    let url;
    try { url = new URL(normalized(uri)); }
    catch { return false; } // Sonos transport identifiers are not always URLs.
    return url.protocol === 'http:' && url.port === '47333' &&
        /^\/tts\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.(?:mp3|wav)$/i.test(url.pathname);
}
function live({uri, position}) {
    // A Sonos radio wrapper can also carry a finite HTTP track.
    return /^(?:x-rincon-mp3radio|x-sonosapi-stream|x-sonosapi-radio):/i.test(uri) &&
        !(seconds(position?.TrackDuration) > 0);
}
const escape = value => String(value).replace(/[&<>"']/g, char =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'})[char]);
const clone = value => JSON.parse(JSON.stringify(value));

class Unsupported extends Error {}
class Changed extends Error {}

function soapValues(value) {
    if (Array.isArray(value)) return value.map(soapValues);
    if (!value || typeof value !== 'object') return value;
    if (typeof value._ === 'string' && Object.keys(value).every(key => key === '_' || key === '$')) return value._;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === '$' ? child : soapValues(child)]));
}

async function soap(service, action, args = {}, instance = true) {
    if (!service?.endpoint || !/^urn:schemas-(?:upnp-org:service:[\w]+:\d+|sonos-com:service:Queue:1)$/.test(service.service)) {
        throw new Unsupported(`${action} has no supported service.`);
    }
    const response = await fetch(service.endpoint, {
        method: 'POST', redirect: 'error', timeout: 5000, size: 512 * 1024,
        headers: {'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${service.service}#${action}"`},
        body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="${service.service}">` +
            (instance ? '<InstanceID>0</InstanceID>' : '') +
            Object.entries(args).map(([key, value]) => `<${key}>${escape(value)}</${key}>`).join('') +
            `</u:${action}></s:Body></s:Envelope>`
    });
    const body = soapValues((await parseStringPromise(await response.text(), XML_OPTIONS))?.Envelope?.Body);
    const code = body?.Fault?.detail?.UPnPError?.errorCode;
    if (code === '401' || (action === 'Seek' && code === '710')) {
        throw Object.assign(new Unsupported(`${action} is not supported.`), {upnpCode: code});
    }
    if (!response.ok || body?.Fault) {
        throw Object.assign(new Error(`${action} failed (HTTP ${response.status}${/^\d+$/.test(code) ? `, UPnP ${code}` : ''}).`),
            {upnpCode: code});
    }
    if (body?.[`${action}Response`] === undefined) throw new Error(`Missing ${action} response.`);
    return body[`${action}Response`] || {};
}

async function optional(action) {
    try { return await action(); }
    catch (error) { if (!(error instanceof Unsupported)) throw error; }
}

async function topology(target) {
    const {ZoneGroupState} = await soap({endpoint: target.topology, service: TOPOLOGY}, 'GetZoneGroupState', {}, false);
    if (typeof ZoneGroupState !== 'string') throw new Error('Missing Sonos topology.');
    const parsed = await parseStringPromise(ZoneGroupState, XML_OPTIONS);
    const groups = array((parsed.ZoneGroupState ?? parsed).ZoneGroups?.ZoneGroup).map(group => ({
        coordinator: idOf(group.$?.Coordinator),
        members: array(group.ZoneGroupMember).flatMap(member => [
            {id: idOf(member.$?.UUID), hidden: member.$?.Invisible === '1', parent: '',
                bond: (member.$?.ChannelMapSet ?? '').toUpperCase()},
            ...array(member.Satellite).map(satellite => ({
                id: idOf(satellite.$?.UUID), hidden: true, parent: idOf(member.$?.UUID),
                bond: (satellite.$?.ChannelMapSet ?? '').toUpperCase()
            }))
        ])
    }));
    const ids = groups.flatMap(group => group.members.map(member => member.id));
    if (!groups.length || ids.includes('') || new Set(ids).size !== ids.length ||
        groups.some(group => !group.members.some(member => !member.hidden && member.id === group.coordinator))) {
        throw new Error('Invalid Sonos topology.');
    }
    return groups;
}

function roomGroup(groups, target) {
    const id = idOf(target);
    const group = groups.find(entry => entry.members.some(member => member.id === id));
    if (!group || !group.members.some(member => member.id === id && !member.hidden)) {
        throw new Changed('Sonos room is missing or bonded to another room.');
    }
    return group;
}

function groupKey(group) {
    return JSON.stringify([group.coordinator, group.members.map(member =>
        JSON.stringify([member.id, member.hidden, member.parent, member.bond])).sort()]);
}

async function waitFor(check, message) {
    for (let attempt = 0; attempt < 21; attempt++) {
        const observed = await check();
        if (observed) return observed;
        if (attempt < 20) await delay(250);
    }
    throw new Error(message);
}

function details(file) {
    let url;
    try { url = new URL(file?.url); } catch { throw new TypeError('An HTTP(S) track URL is required.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('An HTTP(S) track URL is required.');
    const formats = {aac: 'audio/aac', flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'video/mp4',
        mkv: 'video/x-matroska', avi: 'video/x-msvideo', mov: 'video/quicktime', wmv: 'video/x-ms-wmv',
        mp3: 'audio/mpeg', oga: 'audio/ogg', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav'};
    return {url: file.url, name: String(file.name ?? ''), duration: Number(file.duration) || 0,
        type: file.contentType || file.type || file.mimeType || formats[url.pathname.split('.').pop().toLowerCase()] || 'application/octet-stream'};
}

function metadata(media) {
    const mediaClass = media.type.startsWith('video/') ? 'object.item.videoItem'
        : media.type.startsWith('image/') ? 'object.item.imageItem.photo' : 'object.item.audioItem.musicTrack';
    return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
        `<item id="0" parentID="-1" restricted="1"><dc:title>${escape(media.name)}</dc:title><upnp:class>${mediaClass}</upnp:class>` +
        `<res protocolInfo="http-get:*:${escape(media.type)}:*">${escape(media.url)}</res></item></DIDL-Lite>`;
}

class Renderer {
    constructor(target) { this.target = target; }

    async read() {
        const target = this.target;
        const [media, transport, position] = await Promise.all([
            soap(target, 'GetMediaInfo'), soap(target, 'GetTransportInfo'),
            optional(() => soap(target, 'GetPositionInfo'))
        ]);
        const text = value => typeof value === 'string' ? value : value?._;
        const state = text(transport.CurrentTransportState)?.trim();
        const track = text(position?.TrackURI);
        const source = text(media.CurrentURI);
        // Some DLNA renderers expose only the current track URI, not a separate transport URI.
        const uri = source ?? (target.protocol === 'dlna' ? track || (stopped(state) ? '' : undefined) : undefined);
        if (typeof uri !== 'string' || !state ||
            (target.protocol === 'sonos' && typeof track !== 'string')) {
            throw new Error('Incomplete renderer playback state.');
        }
        return {uri, track, state, metadata: text(media.CurrentURIMetaData) || text(position?.TrackMetaData) || '',
            position, trackCount: media.NrTracks, next: text(media.NextURI)};
    }

    async snapshot() {
        return waitFor(async () => {
            const state = await this.read();
            return state.state !== 'TRANSITIONING' && state;
        }, 'Renderer did not settle before saving its source.');
    }

    async source(uri, metadata) {
        await soap(this.target, 'SetAVTransportURI', {CurrentURI: uri, CurrentURIMetaData: metadata});
    }

    async command(command) {
        await soap(this.target, command, command === 'Play' ? {Speed: 1} : {});
    }

    async load(media, beforePlay) {
        await this.source(media.url, metadata(media));
        await beforePlay();
        await this.command('Play');
    }

    next(media) {
        return soap(this.target, 'SetNextAVTransportURI', {NextURI: media?.url ?? '', NextURIMetaData: media ? metadata(media) : ''});
    }

    async queueVersion() {
        const {UpdateID, TotalMatches} = await soap(this.target.queue, 'Browse', {QueueID: 0, StartingIndex: 0, RequestedCount: 1}, false);
        if (!/^\d+$/.test(UpdateID) || !/^\d+$/.test(TotalMatches)) throw new Error('Sonos did not identify its queue revision.');
        return {revision: UpdateID, count: Number(TotalMatches)};
    }

    async loadQueue(items, index, beforePlay, guard, position, repeat) {
        const initial = await this.queueVersion();
        await guard();
        let revision = initial.revision;
        if (initial.count) ({NewUpdateID: revision} = await soap(this.target.queue, 'RemoveAllTracks',
            {QueueID: 0, UpdateID: revision}, false));
        for (const [position, item] of items.entries()) {
            if (!/^\d+$/.test(revision)) throw new Error('Sonos did not confirm the queue revision.');
            const result = await soap(this.target.queue, 'AddURI', {QueueID: 0, UpdateID: revision,
                EnqueuedURI: item.url, EnqueuedURIMetaData: metadata(item),
                DesiredFirstTrackNumberEnqueued: position + 1, EnqueueAsNext: 0}, false);
            if (Number(result.NewQueueLength) !== position + 1 || Number(result.FirstTrackNumberEnqueued) !== position + 1) {
                throw new Error('Sonos did not confirm the queue order.');
            }
            revision = result.NewUpdateID;
        }
        const uri = `x-rincon-queue:${idOf(this.target)}#0`;
        await this.source(uri, '');
        await soap(this.target, 'SetPlayMode', {NewPlayMode: repeat ? 'REPEAT_ALL' : 'NORMAL'});
        await soap(this.target, 'Seek', {Unit: 'TRACK_NR', Target: index + 1});
        await beforePlay({uri, revision});
        await this.command('Play');
        if (position > 0) await this.seek(position);
        return {uri, revision};
    }

    seek(position) {
        const time = Math.floor(position / 1000);
        const parts = [Math.floor(time / 3600), Math.floor(time / 60) % 60, time % 60];
        return soap(this.target, 'Seek', {Unit: 'REL_TIME', Target: parts.map(n => String(n).padStart(2, '0')).join(':')});
    }

    async restore(saved, guard, warn) {
        if (!saved.uri) {
            await this.source('', '');
            return;
        }
        const paused = saved.state === PAUSED;
        const shouldPlay = paused || saved.state === PLAYING;
        const {position, uri} = saved;
        await this.source(uri, saved.metadata);
        const seek = async (Unit, Target) => {
            await guard();
            try { await soap(this.target, 'Seek', {Unit, Target}); return true; }
            catch (error) {
                if (!(error instanceof Unsupported)) throw error;
                warn(error);
                return false;
            }
        };
        const sought = {};
        if (position && !input(uri) && !live(saved)) {
            const track = !/^x-rincon-queue:/i.test(uri) || !(Number(position.Track) > 0) ||
                await seek('TRACK_NR', position.Track);
            if (track && /^x-rincon-queue:/i.test(uri) && Number(position.Track) > 0) sought.track = Number(position.Track);
            if (track && /^\d+:\d{2}:\d{2}(?:\.\d+)?$/.test(position.RelTime) && /[1-9]/.test(position.RelTime)) {
                if (await seek('REL_TIME', position.RelTime)) sought.time = seconds(position.RelTime);
            }
        }
        await guard();
        const loaded = await this.read();
        if (shouldPlay && loaded.state !== PLAYING && (!paused || loaded.state !== PAUSED)) await this.command('Play');
        if (paused && loaded.state !== PAUSED) {
            await waitFor(async () => (await guard()).state === PLAYING, 'Renderer did not play before restoring Pause.');
            await this.command('Pause');
        }
        if (!shouldPlay && !stopped(loaded.state)) await this.command('Stop');
        return state => (sought.track == null || Number(state.position?.Track) === sought.track) &&
            (sought.time == null || Math.abs(seconds(state.position?.RelTime) - sought.time) <= 5);
    }

    async volumeRange() {
        const {rendering, protocol} = this.target;
        if (!rendering) throw new Unsupported('Volume control is unavailable.');
        if (protocol === 'sonos') return {min: 0, max: 100, step: 1};
        if (!rendering.scpd) throw new Unsupported('Renderer volume range is unknown.');
        const response = await fetch(rendering.scpd, {redirect: 'error', timeout: 3000, size: 256 * 1024});
        if (!response.ok) throw new Error(`Renderer service description returned HTTP ${response.status}.`);
        const definition = (await parseStringPromise(await response.text(), XML_OPTIONS))?.scpd;
        const range = array(definition?.serviceStateTable?.stateVariable).find(state => state.name === 'Volume')?.allowedValueRange;
        const min = Number(range?.minimum), max = Number(range?.maximum), step = Number(range?.step ?? 1);
        if (![min, max, step].every(Number.isFinite) || max <= min || step <= 0) {
            throw new Unsupported('Renderer volume range is unknown.');
        }
        return {min, max, step};
    }

    async getVolume() {
        const result = await soap(this.target.rendering, 'GetVolume', {Channel: 'Master'});
        if (result.CurrentVolume === '' || !Number.isFinite(Number(result.CurrentVolume))) {
            throw new Error('Renderer did not return its volume.');
        }
        return Number(result.CurrentVolume);
    }

    async setVolume(value) {
        await soap(this.target.rendering, 'SetVolume', {Channel: 'Master', DesiredVolume: value});
    }

    async getMute() {
        const {CurrentMute} = await soap(this.target.rendering, 'GetMute', {Channel: 'Master'});
        if (!['0', '1', 'true', 'false'].includes(CurrentMute)) throw new Error('Renderer did not return its mute state.');
        return Number(CurrentMute === '1' || CurrentMute === 'true');
    }

    async setMute(value) {
        await soap(this.target.rendering, 'SetMute', {Channel: 'Master', DesiredMute: value});
    }

    close() {}
}

function castCall(receiver, method, ...args) {
    return new Promise((resolve, reject) => {
        const finish = (error, value) => {
            clearTimeout(timer);
            if (error) reject(new Error(`Google Cast ${method} failed.`));
            else resolve(value);
        };
        const timer = setTimeout(() => finish(true), 5000);
        try { receiver[method](...args, finish); }
        catch { finish(true); }
    });
}

class Cast {
    constructor(target) { this.target = target; }

    async connect() {
        if (this.client) return;
        let api;
        try { api = require('castv2-client'); }
        catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') throw error;
            throw new Unsupported('Google Cast control requires castv2-client.');
        }
        this.Receiver = api.DefaultMediaReceiver;
        this.client = new api.Client();
        this.client.on('error', () => {});
        await castCall(this.client, 'connect', {host: this.target.host, port: this.target.port});
    }

    async read(joinExisting = false) {
        await this.connect();
        const receiver = await castCall(this.client, 'getStatus');
        const application = receiver?.applications?.find(app => app.appId !== 'E8C28D3C'); // backdrop
        if (!application) return {uri: '', state: 'NO_MEDIA_PRESENT'};
        if (application.appId !== this.Receiver.APP_ID && !joinExisting) return {foreignApp: true, state: 'UNKNOWN'};
        const app = application.sessionId;
        if (!this.player || this.app !== app) {
            this.player = await castCall(this.client, 'join', application, this.observer());
            this.app = app;
        }
        const status = await castCall(this.player, 'getStatus');
        const state = ({PAUSED, IDLE: 'STOPPED', BUFFERING: 'TRANSITIONING', LOADING: 'TRANSITIONING'})[status?.playerState] ??
            status?.playerState ?? 'NO_MEDIA_PRESENT';
        return {uri: status?.media?.contentId ?? '', state, app, session: status?.mediaSessionId,
            idleReason: status?.idleReason, media: status?.media, currentTime: status?.currentTime,
            status};
    }

    observer() {
        const Application = require('castv2-client/lib/senders/application');
        const RequestResponse = require('castv2-client/lib/controllers/request-response');
        // The default receiver's media controller attempts STOP on channel close.
        // A widget observing someone else's session must never send that command implicitly.
        const id = this.Receiver.APP_ID;
        return class extends Application {
            static APP_ID = id;
            constructor(client, session) {
                super(client, session);
                this.media = this.createController(RequestResponse, 'urn:x-cast:com.google.cast.media');
            }

            getStatus(callback) {
                this.media.request({type: 'GET_STATUS'}, (error, result) => callback(error, result?.status?.[0]));
            }
        };
    }

    async snapshot() {
        const state = await waitFor(async () => {
            const current = await this.read();
            return current.state !== 'TRANSITIONING' && current;
        }, 'Google Cast did not settle before saving its source.');
        if (state.foreignApp) throw new Unsupported('Cannot safely replace or restore a custom Google Cast app.');
        return state;
    }

    async load(media, _beforePlay, position) {
        if (!this.player) this.player = await castCall(this.client, 'launch', this.Receiver);
        const item = {contentId: media.url, contentType: media.type, streamType: 'BUFFERED',
            metadata: {metadataType: 3, title: media.name}};
        const options = {autoplay: true, ...(position > 0 && {currentTime: position / 1000})};
        const status = typeof this.player.load === 'function' ? await castCall(this.player, 'load', item, options)
            : (await castCall(this.player.media, 'request', {type: 'LOAD', media: item, ...options}))?.status?.[0];
        if (status?.mediaSessionId == null) throw new Error('Google Cast did not identify the new media session.');
        return status.mediaSessionId;
    }

    async loadQueue(items, index, token, position, repeat) {
        if (!this.player) this.player = await castCall(this.client, 'launch', this.observer());
        const response = await castCall(this.player.media, 'request', {type: 'QUEUE_LOAD', startIndex: index,
            repeatMode: repeat ? 'REPEAT_ALL' : 'REPEAT_OFF', currentTime: (position || 0) / 1000, items: items.map((item, position) => ({autoplay: true,
                media: {contentId: item.url, contentType: item.type, streamType: 'BUFFERED',
                    metadata: {metadataType: 3, title: item.name}, customData: {umpQueue: token, position}}}))});
        const session = response?.status?.[0]?.mediaSessionId;
        if (response?.type !== 'MEDIA_STATUS' || session == null) throw new Error('Cast did not confirm the new queue.');
        return {session};
    }

    async command(command) {
        if (typeof this.player[command.toLowerCase()] === 'function') {
            await castCall(this.player, command.toLowerCase());
        } else {
            const {mediaSessionId} = await castCall(this.player, 'getStatus') ?? {};
            const response = await castCall(this.player.media, 'request', {type: command.toUpperCase(), mediaSessionId});
            if (response?.type !== 'MEDIA_STATUS') throw new Error(`Cast did not confirm ${command}.`);
        }
    }

    async restore(saved) {
        if (saved.media && [PLAYING, PAUSED].includes(saved.state)) {
            const options = {autoplay: saved.state === PLAYING};
            if (saved.media.streamType !== 'LIVE' && Number.isFinite(saved.currentTime)) options.currentTime = saved.currentTime;
            const result = typeof this.player.load === 'function'
                ? await castCall(this.player, 'load', saved.media, options)
                : (await castCall(this.player.media, 'request', {type: 'LOAD', media: saved.media, ...options}))?.status?.[0];
            if (result?.mediaSessionId == null) throw new Error('Google Cast did not identify the restored media session.');
            return state => state.session === result.mediaSessionId &&
                (options.currentTime == null || Math.abs(state.currentTime - options.currentTime) <= 5);
        }
    }

    async volumeRange() { return {min: 0, max: 1, step: 0.001}; }
    async getVolume() {
        const {level} = await castCall(this.client, 'getVolume');
        if (!Number.isFinite(level)) throw new Error('Google Cast did not return its volume.');
        return level;
    }
    async setVolume(level) { await castCall(this.client, 'setVolume', {level}); }
    async getMute() {
        const {muted} = await castCall(this.client, 'getVolume');
        if (typeof muted !== 'boolean') throw new Error('Google Cast did not return its mute state.');
        return Number(muted);
    }
    async setMute(value) { await castCall(this.client, 'setVolume', {muted: Boolean(value)}); }
    close() {
        // castv2's close() dereferences the socket even after a disconnect.
        if (this.client && this.client.client?.socket !== null) this.client.close();
    }
}

function adapter(target) {
    if (target.protocol === 'cast') return new Cast(target);
    if (['sonos', 'dlna'].includes(target.protocol)) return new Renderer(target);
    throw new Unsupported('Unsupported speaker protocol.');
}

const ownedTargets = new Map();
let serial = Promise.resolve();
let notifications = Promise.resolve();

function keyFor(target) { return `${target.protocol}:${idOf(target)}`; }
function expectedGroup(unit) {
    if (!unit.group) return;
    return {...unit.group, members: [...unit.group.members,
        ...unit.joins.filter(room => room.phase === 'joined').flatMap(room => room.group.members)]};
}

function sourceMatches(current, expected, target, pending = false) {
    if (current.foreignApp || !sameUri(current.uri, expected.uri)) return false;
    if (target.protocol === 'cast') {
        return pending ? Boolean(current.app && current.session != null) :
            current.app === expected.app && current.session === expected.session;
    }
    if (!expected.uri || !/^https?:\/\//i.test(normalized(expected.uri))) {
        return pending || !expected.track || sameUri(current.track, expected.track);
    }
    if (target.protocol === 'sonos') return sameUri(current.track, expected.track || expected.uri);
    return !current.track || sameUri(current.track, expected.track || expected.uri);
}

function canAdvance(state, unit) {
    if (unit.expected.state !== PLAYING || !stopped(state.state)) return false;
    if (unit.handoff?.repeat && unit.target.protocol !== 'dlna') return false;
    if (unit.target.protocol === 'cast') return state.idleReason === 'FINISHED';
    // UPnP does not distinguish an explicit Stop from EOF. Only accept Stop
    // near the expected end, not shortly after starting or resuming a track.
    if (unit.target.protocol === 'dlna' && unit.handoff?.armed != null) {
        // Some renderers report STOPPED briefly before consuming NextURI.
        return Boolean(unit.endAt && Date.now() >= unit.endAt + 1500);
    }
    return Boolean(unit.endAt && Date.now() >= unit.endAt - 1000);
}

// Windows can report EOF as a paused zero reset; ordinary pauses are not completion.
function windowsQueueEnded(state, unit) {
    const proof = unit.endEvidence;
    const now = Date.now();
    return unit.target.protocol === 'dlna' && unit.target.windowsRenderer && !unit.pending &&
        unit.expected.state === PLAYING && state.state === PAUSED && seconds(state.position?.RelTime) === 0 &&
        sourceMatches(state, unit.expected, unit.target) && proof && sameUri(proof.url, unit.expected.uri) &&
        Number.isFinite(proof.at) && now >= proof.at && now - proof.at <= 10000 &&
        Number.isFinite(proof.position) && Number.isFinite(proof.duration) && proof.duration > 0 &&
        proof.position >= proof.duration - 3000 &&
        unit.endAt && now >= unit.endAt - 1000 && now <= unit.endAt + 10000;
}

function seconds(value) {
    if (!/^\d+:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) return NaN;
    const [hours, minutes, seconds] = value.split(':').map(Number);
    return hours * 3600 + minutes * 60 + seconds;
}

function assertState(current, unit, advance = false) {
    const finishedCast = advance && unit.target.protocol === 'cast' && !current.uri &&
        current.app === unit.expected.app && current.session === unit.expected.session && canAdvance(current, unit);
    if ((!finishedCast && !sourceMatches(current, unit.expected, unit.target)) ||
        (current.state !== unit.expected.state && !(stopped(current.state) && stopped(unit.expected.state)) &&
            !(advance && canAdvance(current, unit)))) {
        throw new Changed('Speaker source or playback state changed outside this session.');
    }
}

function setExpected(unit, state) {
    const {uri, track, app, session} = state;
    unit.expected = {uri, track, app, session, state: state.state};
}

function newUnit(target, original, group, rooms = [target]) {
    const unit = {target, original, group, rooms, joins: [], volumes: []};
    setExpected(unit, original);
    return unit;
}

function hasVolumeRule(room) {
    return (room.volumeOffset ?? 0) !== 0 || (room.maxVolume ?? 100) < 100;
}

function policy(options = {}, previous) {
    const volume = options.volume ?? previous?.volume;
    if (volume !== undefined && (!Number.isFinite(volume) || volume < 0 || volume > 100)) {
        throw new TypeError('Speaker volume must be between 0 and 100.');
    }
    return {volume, group: options.groupSonos ?? options.group ?? previous?.group ?? true,
        restore: options.restore ?? options.resume ?? previous?.restore ?? true,
        restoreQueue: options.restoreQueue ?? previous?.restoreQueue ?? true};
}

/**
 * One instance per playlist device. The caller advances tracks and owns all
 * playlist timers and feedback. Calls are serialized and return an operation
 * report {ok, active, persisted, selection, failures, skipped}. A report may
 * describe partial success, so do not equate !ok with no remote playback.
 * status() reads the journal and verifies targets without mutating speakers;
 * position is in milliseconds. Use resume(), not start(), to unpause.
 * Same-selection track loads retain snapshots. A target/group change releases
 * the old session before claiming new targets. The Device Store is optional
 * for in-process controls. Without a requested volume, configured member rules
 * use each member's current volume once per session, before loading a track.
 * Both getStoreValue and setStoreValue are needed for recovery. No constructor
 * side effects or automatic playback on restart.
 */
class DirectSpeakerSession {
    constructor({playback, device, log = () => {}, clip = playClip}) {
        this.playback = playback;
        this.device = device;
        this.log = log;
        this.clip = clip;
        this.owner = device?.getData?.()?.id ?? device ?? this;
        this.journal = {units: []};
    }

    start(selection, file, options) {
        return this.run('start', report => this.startTrack(selection, details(file), options, report));
    }

    selectForControl(selection) {
        return this.playback.selectForControl?.(selection) ?? this.playback.select(selection);
    }

    beforePlaybackRetry(target, attempt, safeToRetry) {
        return this.playback.beforePlaybackRetry?.(target, attempt, safeToRetry) ?? attempt(target);
    }

    setTarget(selection, file, options) {
        return this.run('setTarget', report => this.startTrack(selection, details(file), options, report));
    }

    async playNotification(selection, file, {group, mode, volume, completion} = {}) {
        const media = details(file);
        if (!(media.duration > 0 && media.duration <= MAX_NOTIFICATION_MS)) {
            throw new RangeError('Select a notification sound with a known duration of at most 60 seconds.');
        }
        policy({volume});
        let confirmed;
        const active = new Promise(resolve => { confirmed = resolve; });
        const job = notifications.then(async () => {
            const resolved = mode === 'selected' ? await this.playback.select(selection, true) : null;
            const targets = resolved ? resolved.targets ?? [resolved] : [];
            const clips = targets.filter(target => target.protocol === 'sonos');
            if (!clips.length) return this.managedNotification(selection, media, {group, volume}, confirmed, resolved);
            if (!/^(?:audio\/(?:mpeg|mp3|wav|x-wav|wave|vnd\.wave))$/i.test(media.type.split(';')[0].trim())) {
                throw new Error('Play Separately on Sonos requires an MP3 or WAV notification sound.');
            }
            const rest = targets.filter(target => target.protocol !== 'sonos');
            let remaining = clips.length + Number(rest.length > 0);
            const onActive = () => {
                if (--remaining === 0) confirmed({ok: true, active: true, failures: [], skipped: []});
            };
            const started = clips.map(async target => {
                const level = volume === undefined ? undefined :
                    Math.min(target.maxVolume ?? 100, Math.max(0, volume + (target.volumeOffset ?? 0)));
                const attempt = replacement => this.clip(replacement, media, level, onActive);
                if (!resolved.targets && target.id === selection.id) {
                    await this.beforePlaybackRetry(target, attempt, error => error.beforePlayback === true);
                } else await attempt(target);
            });
            const mixed = rest.length ? this.managedNotification(selection, media, {group, volume}, onActive,
                {...resolved, targets: rest}) : null;
            const results = await Promise.allSettled([...started, ...(mixed ? [mixed] : [])]);
            const report = {ok: true, active: false, failures: [], skipped: []};
            for (const [index, result] of results.entries()) {
                if (result.status === 'rejected') this.note(report, clips[index], 'AudioClip notification', result.reason);
                else if (result.value) {
                    report.failures.push(...result.value.failures);
                    report.skipped.push(...result.value.skipped);
                    report.ok &&= result.value.ok;
                }
            }
            report.ok &&= report.failures.length === 0 && remaining === 0;
            report.active = remaining === 0;
            return report;
        });
        notifications = job.catch(() => {});
        if (completion !== 'continue') return job;
        return Promise.race([active, job]);
    }

    async managedNotification(selection, media, {group, volume}, onActive, resolved) {
        const token = randomUUID();
        let deadline = 0;
        let startedNotification = false;
        const started = await this.run('playNotification', async report => {
            if (this.journal.units.length) {
                throw new Error('Stop this player or use a separate notification player before playing a notification.');
            }
            this.journal.notification = token;
            startedNotification = true;
            await this.startTrack(selection, media, {group, volume, restore: true, restoreQueue: true}, report, true, resolved);
            if (!report.failures.length && this.journal.units.length) {
                deadline = Math.max(...this.journal.units.map(unit => unit.endAt));
            }
        });
        if (!startedNotification) return started;
        if (started.ok && started.active) onActive(started);
        if (deadline) await delay(Math.max(0, deadline - Date.now()));
        const restored = await this.recoverNotification(token);
        return {...restored, ok: started.ok && started.active && restored.ok,
            failures: [...started.failures, ...restored.failures],
            skipped: [...started.skipped, ...restored.skipped]};
    }

    recoverNotification(token) {
        return this.run('recoverNotification', async report => {
            if (token && this.journal.notification !== token) {
                throw new Error('Notification playback was superseded.');
            }
            if (!this.journal.notification) return;
            await this.release(true, report);
            if (!this.journal.units.length) {
                delete this.journal.notification;
                await this.save();
            }
        });
    }

    pause() { return this.run('pause', report => this.control('Pause', report)); }
    resume() { return this.run('resume', report => this.control('Play', report)); }
    status() {
        return this.run('status', async report => {
            report.targets = [];
            for (const unit of this.journal.units) {
                if (!unit.loaded || unit.releasing || unit.pending) {
                    this.note(report, unit.target, 'status', new Error('An interrupted session needs cleanup.'));
                    continue;
                }
                try {
                    await this.withTarget(unit.target, async control => {
                        await this.checkTopology(unit);
                        const state = await this.observe(unit, control);
                        if (unit.handoff && state.state === 'TRANSITIONING') {
                            report.targets.push({id: unit.target.id, handoff: true, state: state.state});
                            return;
                        }
                        assertState(state, unit, true);
                        const time = seconds(state.position?.RelTime);
                        const position = Number.isFinite(time) ? time * 1000
                            : Number.isFinite(state.currentTime) ? state.currentTime * 1000 : undefined;
                        report.targets.push({id: unit.target.id, url: normalized(unit.handoff ?
                            unit.handoff.items[unit.handoff.index]?.url : unit.expected.uri), state: state.state, position,
                            ...(unit.handoff && {handoff: true, index: unit.handoff.items[unit.handoff.index]?.index,
                                finished: canAdvance(state, unit)})});
                    });
                } catch (error) {
                    this.note(report, unit.target, 'status', error);
                }
            }
        });
    }
    setVolume(volume, selection) {
        return this.run('setVolume', report => {
            policy({volume});
            if (volume == null) throw new TypeError('Speaker volume must be between 0 and 100.');
            return this.adjust('Volume', volume, report, selection);
        });
    }
    setMute(mute, selection) {
        return this.run('setMute', report => {
            if (typeof mute !== 'boolean') throw new TypeError('Speaker mute must be a boolean.');
            return this.adjust('Mute', Number(mute), report, selection);
        });
    }
    stop({restore} = {}) {
        return this.run('stop', report => this.release(restore ?? this.journal.options?.restore ?? true, report));
    }

    run(operation, fn) {
        const run = serial.then(async () => {
            if (this.device?.getStoreValue) {
                const saved = await this.device.getStoreValue(STORE);
                if (saved != null && (!Array.isArray(saved.units) || saved.version !== 1)) {
                    throw new Error('The direct speaker session journal is invalid.');
                }
                this.journal = saved ? clone(saved) : {units: []};
            }
            for (const unit of this.journal.units) {
                for (const room of unit.rooms) {
                    if (!ownedTargets.has(keyFor(room))) ownedTargets.set(keyFor(room), this.owner);
                }
            }
            const report = {ok: true, active: false, failures: [], skipped: []};
            try { await fn(report); }
            catch (error) {
                if (error instanceof TypeError || error.journal) throw error;
                this.note(report, null, operation, error);
            }
            report.ok = report.failures.length === 0;
            report.persisted = this.journal.units.length > 0;
            report.active = operation === 'status' ? report.targets?.length > 0 :
                this.journal.units.some(unit => unit.loaded && !unit.releasing && !unit.pending);
            report.selection = report.persisted ? this.journal.selection : null;
            return report;
        });
        serial = run.catch(() => {});
        return run;
    }

    note(report, target, operation, error, skip = false) {
        if (target) this.playback.controlConnectionFailed?.(target, error);
        const issue = {target: target?.id ?? null, operation, message: error.message};
        report[skip ? 'skipped' : 'failures'].push(issue);
        this.log(`Direct speaker ${operation} (${issue.target ?? 'selection'}): ${issue.message}`);
    }

    async save() {
        if (!this.device?.setStoreValue) return;
        try {
            await this.device.setStoreValue(STORE, clone({version: 1, ...this.journal}));
        } catch (cause) {
            const error = new Error('Could not save the direct speaker session journal.', {cause});
            error.journal = true;
            throw error;
        }
    }

    async withTarget(target, fn) {
        const control = adapter(target);
        try { return await fn(control); }
        finally { control.close(); }
    }

    get hasHandoff() { return this.journal.units.some(unit => unit.handoff); }

    async observe(unit, control) {
        let state = await control.read();
        const queue = unit.handoff;
        if (!queue || state.state === 'TRANSITIONING') return state;
        if (windowsQueueEnded(state, unit)) state = {...state, state: 'STOPPED'};
        let index = queue.index;
        if (unit.target.protocol === 'sonos') {
            if (!sameUri(state.uri, queue.uri)) throw new Changed('Sonos is no longer playing the UMP queue.');
            const version = await control.queueVersion();
            if (version.revision !== queue.revision || version.count !== queue.items.length) {
                throw new Changed('The Sonos queue was edited outside UMP.');
            }
            if (!stopped(state.state) || Number(state.position?.Track) > 0) index = Number(state.position?.Track) - 1;
            if (!queue.items[index] || (!stopped(state.state) && !sameUri(state.track, queue.items[index].url))) {
                throw new Changed('Sonos did not report a track in the UMP queue.');
            }
        } else if (unit.target.protocol === 'cast') {
            if (state.app !== unit.expected.app || state.session !== unit.expected.session) {
                throw new Changed('The Cast queue session changed.');
            }
            if (!stopped(state.state)) {
                const data = state.media?.customData;
                index = data?.position;
                if (data?.umpQueue !== queue.token || !Number.isInteger(index) || !queue.items[index] ||
                    !sameUri(state.uri, queue.items[index].url) ||
                    (state.status?.repeatMode != null && state.status.repeatMode !== (queue.repeat ? 'REPEAT_ALL' : 'REPEAT_OFF'))) {
                    throw new Changed('Cast did not report an item in the UMP queue.');
                }
            }
        } else {
            if (!sourceMatches(state, unit.expected, unit.target)) {
                index = queue.armed;
                if (!supportedState(state.state) || stopped(state.state) || !sameUri(state.track || state.uri, queue.items[index]?.url) ||
                    !sameUri(state.uri, queue.items[index]?.url)) throw new Changed('DLNA did not advance to the armed track.');
            }
        }
        if (stopped(state.state)) {
            if (unit.target.protocol === 'dlna' && unit.expected.state === PLAYING && queue.armed != null &&
                unit.endAt && Date.now() >= unit.endAt - 1000 && Date.now() < unit.endAt + 1500) {
                return {...state, state: 'TRANSITIONING'};
            }
            if (index !== queue.index || (index !== queue.items.length - 1 && unit.target.protocol !== 'dlna')) {
                throw new Changed('Speaker stopped before the end of the UMP queue.');
            }
            return state;
        }
        const position = state.currentTime ?? seconds(state.position?.RelTime);
        let saveEvidence = false;
        if (unit.target.windowsRenderer && state.state === PLAYING && Number.isFinite(position)) {
            const item = queue.items[index];
            const reportedDuration = seconds(state.position?.TrackDuration) * 1000;
            const duration = reportedDuration > 0 ? reportedDuration : item.duration;
            const previous = unit.endEvidence;
            if (duration > 0 && position * 1000 >= duration - 3000) {
                unit.endEvidence = {url: item.url, at: Date.now(), position: position * 1000, duration};
                saveEvidence = !previous || !sameUri(previous.url, item.url) || Date.now() - previous.at > 3000;
            } else if (previous) {
                delete unit.endEvidence;
                saveEvidence = true;
            }
        }
        const remaining = Math.max(0, queue.items[index].duration - (Number.isFinite(position) ? position * 1000 : 0));
        if (index !== queue.index || state.state !== unit.expected.state) {
            const advanced = index !== queue.index;
            queue.index = index;
            setExpected(unit, state);
            unit.endAt = state.state === PLAYING ? Date.now() + remaining : 0;
            unit.remaining = remaining;
            await this.save();
            if (advanced && unit.target.protocol === 'dlna') {
                delete queue.armed;
                await this.armNext(unit, control, queue);
            }
        } else if (state.state === PLAYING && Number.isFinite(position)) {
            unit.endAt = Date.now() + remaining;
            if (saveEvidence) await this.save();
        }
        return state;
    }

    async nativeLoad(unit, control, plan, options, guard) {
        if (!plan || this.journal.units.length !== 1 ||
            (unit.target.protocol === 'sonos' && !unit.target.queue) || unit.target.protocol === 'dlna') return;
        if (unit.target.protocol === 'sonos') {
            try { await control.queueVersion(); }
            catch (error) {
                if (!(error instanceof Unsupported)) throw error;
                this.log('Sonos does not support queue handoff:', error.message);
                return;
            }
        }
        const items = plan.items.map(item => ({...details(item), index: item.index}));
        const queue = {items, index: plan.index, repeat: plan.repeat === true, token: randomUUID()};
        unit.pending = {kind: 'queue', token: queue.token};
        await this.save();
        const description = unit.target.protocol === 'cast'
            ? await control.loadQueue(items, plan.index, queue.token, options.position, queue.repeat)
            : await control.loadQueue(items, plan.index, async ({uri, revision}) => {
                await waitFor(async () => {
                    await this.checkTopology(unit);
                    const state = await control.read();
                    const version = await control.queueVersion();
                    if (!sameUri(state.uri, uri) || version.revision !== revision || version.count !== items.length) {
                        throw new Changed('Sonos changed source or queue before playing.');
                    }
                    return sameUri(state.track, items[plan.index].url) ||
                        (stopped(state.state) && Number(state.position?.Track) === plan.index + 1);
                }, 'Sonos did not confirm the requested queue position.');
            }, guard, options.position, queue.repeat);
        Object.assign(queue, description);
        const actual = await waitFor(async () => {
            const state = await control.read();
            if (state.state !== PLAYING) return;
            return (unit.target.protocol === 'cast'
                ? state.session === queue.session && state.media?.customData?.umpQueue === queue.token &&
                    state.media.customData.position === plan.index && sameUri(state.uri, items[plan.index].url)
                : sameUri(state.uri, queue.uri) && sameUri(state.track, items[plan.index].url)) && state;
        }, 'Speaker did not confirm playback of the UMP queue.');
        unit.handoff = queue;
        return actual;
    }

    async armNext(unit, control, queue) {
        const index = queue.repeat ? (queue.index + 1) % queue.items.length : queue.index + 1;
        const next = queue.items[index];
        if (!next || sameUri(next.url, queue.items[queue.index].url)) return;
        const before = await control.read();
        if (!sourceMatches(before, unit.expected, unit.target)) throw new Changed('Source changed before setting the next DLNA track.');
        try {
            await control.next(next);
            if (!sameUri((await control.read()).next, next.url)) {
                await control.next();
                this.log('DLNA did not confirm the next URI; using UMP timing.');
                return;
            }
        } catch (error) {
            if (!(error instanceof Unsupported)) throw error;
            this.log('DLNA does not support setting the next URI:', error.message);
            return;
        }
        queue.armed = index;
        unit.handoff = queue;
        await this.save();
    }

    async clearNext(unit, control, state) {
        if (unit.target.protocol !== 'dlna' || !unit.handoff) return;
        const expected = unit.handoff.items[unit.handoff.armed]?.url;
        if (expected && state.next && !sameUri(state.next, expected)) throw new Changed('DLNA next URI changed outside UMP.');
        if (state.next) await control.next();
        delete unit.handoff;
        await this.save();
    }

    async startTrack(selection, media, options, report, notification = false, resolved) {
        if (typeof selection?.id !== 'string') throw new TypeError('A speaker picker selection is required.');
        const journal = this.journal;
        let next = policy(options, journal.selection === selection.id ? journal.options : undefined);
        if (journal.units.length && ((!notification && journal.notification) || journal.selection !== selection.id || journal.options.group !== next.group ||
            journal.units.some(unit => unit.releasing || unit.pending))) {
            await this.release(journal.options.restore, report);
            if (!report.failures.length && !journal.units.length) next = policy(options);
            else return;
        }
        if (!journal.units.length) {
            if (!notification) delete journal.notification;
            resolved ??= await this.selectForControl(selection);
            journal.selection = selection.id;
            journal.options = next;
            const followGroup = !notification && !resolved.targets && options?.followGroup === true;
            const retryable = !resolved.targets && resolved.protocol === 'sonos' && resolved.id === selection.id;
            const prepare = target => this.prepare(target, next, report, followGroup, retryable);
            journal.units = retryable ? await this.beforePlaybackRetry(resolved, prepare, () => true) : await prepare(resolved);
            if (!journal.units.length) {
                if (!report.failures.length) {
                    this.note(report, null, 'start', new Error(report.skipped[0]?.message ||
                        'No safe speaker targets were available.'));
                }
                return;
            }
        } else {
            journal.options = next;
        }
        await this.save();
        for (const unit of [...journal.units]) {
            for (const room of unit.rooms) {
                if (!ownedTargets.has(keyFor(room))) ownedTargets.set(keyFor(room), this.owner);
            }
        }
        for (const unit of [...journal.units]) {
            try {
                await this.withTarget(unit.target, async control => {
                    if (!unit.loaded) await this.joinRooms(unit, control);
                    await this.checkTopology(unit);
                    const observed = await this.observe(unit, control);
                    assertState(observed, unit, true);
                    if (!notification && options?.queueOnly && unit.loaded && unit.target.protocol === 'dlna') {
                        if (!sameUri(observed.track || observed.uri, media.url)) {
                            throw new Changed('The current DLNA track changed before the queue edit.');
                        }
                        await this.clearNext(unit, control, observed);
                        if (options.queue) await this.armNext(unit, control, {
                            items: options.queue.items.map(item => ({...details(item), index: item.index})),
                            index: options.queue.index, repeat: options.queue.repeat === true
                        });
                        return;
                    }
                    if (next.volume !== undefined || unit.rooms.some(hasVolumeRule)) {
                        const issueCount = report.failures.length + report.skipped.length;
                        await this.applyLevel(unit, control, 'Volume', next.volume, report, false);
                        if ((next.volume === undefined || next.volume === 0) &&
                            report.failures.length + report.skipped.length !== issueCount) {
                            const reason = next.volume === 0 ? 'zero volume' : 'the configured member volume rules';
                            throw new Error(`Track was not loaded because ${reason} could not be applied.`);
                        }
                    }
                    await this.checkTopology(unit);
                    const guard = async () => {
                        await this.checkTopology(unit);
                        const state = await this.observe(unit, control);
                        assertState(state, unit, true);
                        return state;
                    };
                    const before = await guard();
                    await this.clearNext(unit, control, before);
                    const native = !notification && await this.nativeLoad(unit, control, options?.queue, options, guard);
                    if (native) {
                        setExpected(unit, native);
                        unit.pending = null;
                        unit.loaded = true;
                        unit.endAt = media.duration > 0 ? Date.now() + Math.max(0, media.duration - (options.position || 0)) : 0;
                        await this.save();
                        return;
                    }
                    unit.pending = {kind: 'load', uri: media.url};
                    await this.save();
                    let loadError, castSession;
                    try {
                        castSession = await control.load(media, async () => {
                            await this.checkTopology(unit);
                            const state = await control.read();
                            if (!sameUri(state.uri, media.url) ||
                                (state.track && !sameUri(state.track, media.url))) {
                                throw new Changed('The new transport URI could not be verified before playing.');
                            }
                        }, options?.position);
                    } catch (error) { loadError = error; }
                    if (loadError instanceof Changed || (loadError && unit.target.protocol === 'cast')) throw loadError;
                    const actual = await waitFor(async () => {
                        const state = await control.read();
                        const matches = sourceMatches(state, {uri: media.url}, unit.target, true);
                        if (unit.target.protocol === 'cast' && state.session !== castSession) return;
                        return matches && state.state === PLAYING && state;
                    }, 'Speaker did not confirm that the requested track is playing.').catch(error => {
                        throw loadError ?? error;
                    });
                    await this.checkTopology(unit);
                    if (unit.target.protocol === 'cast' && actual.session === unit.expected.session &&
                        actual.app === unit.expected.app) throw new Error('Google Cast did not confirm a new media session.');
                    setExpected(unit, actual);
                    delete unit.handoff;
                    unit.pending = null;
                    unit.loaded = true;
                    unit.endAt = media.duration > 0 ? Date.now() + Math.max(0, media.duration - (options?.position || 0)) : 0;
                    if (options?.position > 0 && unit.target.protocol !== 'cast') {
                        await control.seek(options.position);
                        unit.endAt = Date.now() + Math.max(0, media.duration - options.position);
                    }
                    await this.save();
                    if (!notification && options?.queue && unit.target.protocol === 'dlna' && journal.units.length === 1) {
                        await this.armNext(unit, control, {items: options.queue.items.map(item => ({...details(item), index: item.index})),
                            index: options.queue.index, repeat: options.queue.repeat === true});
                    }
                });
            } catch (error) {
                if (error.journal) throw error;
                this.note(report, unit.target, 'start', error);
                await this.releaseUnit(unit, next.restore, report);
            }
        }
    }

    async prepare(resolved, options, report, followGroup = false, retryable = false) {
        const byId = new Map((resolved.targets ?? [resolved]).map(target => [keyFor(target), target]));
        const targets = [...byId.values()];
        const excluded = new Set(array(resolved.excludedSonos).map(idOf));
        const sonos = new Map(targets.filter(target => target.protocol === 'sonos').map(target => [idOf(target), target]));
        const planned = new Map();
        const observers = new Map();
        const claimed = new Set();
        for (const target of targets) {
            try {
                if (target.protocol !== 'sonos') {
                    this.checkClaim(target);
                    const state = await this.withTarget(target, control => control.snapshot());
                    if (!supportedState(state.state)) throw new Unsupported('The speaker returned an unsupported transport state.');
                    planned.set(keyFor(target), newUnit(target, state));
                    continue;
                }
                observers.set(idOf(target), await topology(target));
            } catch (error) {
                if (retryable && target === resolved && SpeakerPlayback.isConnectionError(error)) throw error;
                this.note(report, target, 'snapshot', error);
                this.playback.refreshInBackground?.(true);
            }
        }
        for (const [id, groups] of observers) {
            const target = sonos.get(id);
            let readTarget = target;
            try {
                const group = roomGroup(groups, target);
                const members = group.members.filter(member => !member.hidden);
                const rooms = await Promise.all(members.map(async member => {
                    if (sonos.has(member.id) || !followGroup) return sonos.get(member.id);
                    const room = await this.selectForControl({id: `dlna:uuid:${member.id.toLowerCase()}`});
                    if (room.protocol !== 'sonos' || idOf(room) !== member.id) {
                        throw new Changed('Could not verify an existing Sonos group member.');
                    }
                    return room;
                }));
                if (group.members.some(member => excluded.has(member.id)) || rooms.some(room => !room)) {
                    throw new Changed('Sonos group contains an excluded or unselected room.');
                }
                if (claimed.has(group.coordinator)) continue;
                claimed.add(group.coordinator);
                const views = await Promise.all(rooms.map(room => observers.get(idOf(room)) ??
                    (followGroup ? topology(room).catch(error => { readTarget = room; throw error; }) : null)));
                if (!rooms.every((room, index) => views[index] &&
                    groupKey(roomGroup(views[index], room)) === groupKey(group))) {
                    throw new Changed('Sonos rooms returned inconsistent group topology.');
                }
                const leader = rooms.find(room => idOf(room) === group.coordinator);
                for (const room of rooms) this.checkClaim(room);
                readTarget = leader;
                const state = await this.withTarget(leader, control => control.snapshot());
                if (!supportedState(state.state) || /^x-rincon:/i.test(state.uri)) {
                    throw new Changed('Sonos group coordinator did not report independent transport.');
                }
                const unit = newUnit(leader, state, group, rooms);
                if (followGroup) unit.levelRoom = target.id;
                if (retryable && (options.volume !== undefined || hasVolumeRule(target))) {
                    readTarget = target;
                    await this.withTarget(target, async control => {
                        await control.volumeRange();
                        await control.getVolume();
                    });
                }
                planned.set(keyFor(leader), unit);
            } catch (error) {
                if (retryable && readTarget === resolved && SpeakerPlayback.isConnectionError(error)) throw error;
                this.note(report, target, 'snapshot', error, error instanceof Changed);
            }
        }
        // Keep existing groups and bonds intact. Only unbonded standalone
        // rooms are safe to move; prefer a bonded coordinator over a joiner.
        if (options.group) {
            const leaders = [...planned.values()].filter(unit => unit.group && !input(unit.original.uri))
                .sort((a, b) => Number(b.group.members.some(member => member.hidden)) -
                    Number(a.group.members.some(member => member.hidden)));
            for (const leader of leaders) {
                if (!planned.has(keyFor(leader.target))) continue;
                const view = observers.get(idOf(leader.target));
                for (const follower of leaders) {
                    if (follower === leader || !planned.has(keyFor(follower.target)) || follower.joins.length ||
                        follower.group.members.length !== 1 || follower.target.stereo || follower.group.members[0].bond ||
                        !view.some(group => groupKey(group) === groupKey(follower.group))) continue;
                    leader.joins.push({...follower, phase: 'original'});
                    leader.rooms.push(follower.target);
                    planned.delete(keyFor(follower.target));
                }
            }
        }
        return [...planned.values()];
    }

    checkClaim(target) {
        const owner = ownedTargets.get(keyFor(target));
        if (owner !== undefined && owner !== this.owner) throw new Changed('Speaker is managed by another UMP playlist.');
    }

    async checkTopology(unit, includeFollowers = true) {
        for (const target of unit.rooms) this.checkClaim(target);
        if (!unit.group) return;
        const expected = expectedGroup(unit);
        const rooms = includeFollowers ? unit.rooms.filter(room => !unit.joins.some(follower =>
            idOf(follower.target) === idOf(room) && follower.phase !== 'joined')) : [unit.target];
        const keys = await Promise.all(rooms.map(async room => groupKey(roomGroup(await topology(room), room))));
        if (keys.some(key => key !== groupKey(expected))) {
            throw new Changed('Sonos group membership or bonds changed outside this session.');
        }
    }

    async joinRooms(unit, control) {
        if (!unit.joins.length) return;
        await this.checkTopology(unit);
        assertState(await control.read(), unit);
        if (unit.expected.state === PLAYING) await this.transport(unit, control, 'Pause');
        for (const room of unit.joins) {
            await this.checkTopology(unit);
            assertState(await control.read(), unit);
            await this.withTarget(room.target, async follower => {
                const own = roomGroup(await topology(room.target), room.target);
                if (groupKey(own) !== groupKey(room.group)) throw new Changed('Sonos joiner is no longer standalone.');
                assertState(await follower.read(), room);
                room.phase = 'joining';
                await this.save();
                let joinError;
                try { await follower.source(link(idOf(unit.target)), ''); }
                catch (error) { joinError = error; }
                await this.observeJoin(unit, room, follower).catch(error => { throw joinError ?? error; });
                await this.save();
                await waitFor(async () => {
                    const group = roomGroup(await topology(unit.target), unit.target);
                    return groupKey(group) === groupKey(expectedGroup(unit));
                }, 'Sonos coordinator did not confirm the join.');
            });
        }
    }

    async observeJoin(unit, room, follower, retry = true) {
        const read = async () => {
            const group = roomGroup(await topology(room.target), room.target);
            const state = await follower.read();
            const joined = expectedGroup(unit);
            joined.members.push(...room.group.members);
            if (groupKey(group) !== groupKey(joined) || state.uri.toUpperCase() !== link(idOf(unit.target)).toUpperCase()) return;
            room.phase = 'joined';
            return true;
        };
        return retry ? waitFor(read, 'Sonos join was not confirmed by the joining room.') : read();
    }

    async adjust(kind, value, report, selection) {
        const idle = this.journal.units.length === 0;
        const units = idle && selection
            ? await this.prepare(await this.selectForControl(selection), {group: false}, report)
            : this.journal.units.filter(unit => unit.loaded && !unit.releasing);
        if (!units.length || (!idle && selection && selection.id !== this.journal.selection)) {
            if (!report.failures.length) this.note(report, null, `set${kind}`, new Error('No safe speaker targets were available.'));
            return;
        }
        for (const unit of units) {
            try {
                if (unit.pending) throw new Error('The speaker needs cleanup before further controls.');
                await this.withTarget(unit.target, control => this.applyLevel(unit, control, kind, value, report, true, !idle));
            } catch (error) {
                if (error.journal) throw error;
                this.note(report, unit.target, `set${kind}`, error);
            }
        }
    }

    async applyLevel(unit, control, kind, base, report, explicit, persist = true) {
        const volume = kind === 'Volume';
        const fromCurrent = volume && base === undefined;
        for (const room of unit.rooms) {
            if (unit.levelRoom && room.id !== unit.levelRoom) continue;
            if (fromCurrent && !hasVolumeRule(room)) continue;
            try {
                const previous = unit.volumes.find(item => item.target.id === room.id && item.kind === kind);
                // A fallback adjustment is one-time, including after a
                // successful explicit volume command or a restart.
                if (previous?.verified && !explicit && (fromCurrent || previous.requested === base)) continue;
                const apply = async renderer => {
                    await this.checkTopology(unit);
                    assertState(await control.read(), unit, true);
                    const {min, max, step} = volume ? await renderer.volumeRange() : {min: 0, max: 1, step: 1};
                    const current = await renderer[`get${kind}`]();
                    const epsilon = step / 2;
                    const stillOwned = previous && Math.abs(current - previous.applied) <= previous.epsilon;
                    if (previous && !explicit && !stillOwned) {
                        if (fromCurrent) throw new Changed('Could not verify the previous member volume adjustment.');
                        return;
                    }
                    const original = stillOwned ? previous.original : current;
                    const cap = volume ? Math.max(0, Math.min(100, room.maxVolume ?? 100)) : 100;
                    const requested = fromCurrent ? (original - min) * 100 / (max - min) : volume ? base : base * 100;
                    const offset = volume ? (room.volumeOffset ?? 0) : 0;
                    const adjusted = requested === 0 ? 0 : Math.max(0, Math.min(cap, requested + offset));
                    const steps = Math.min(Math.round((max - min) * adjusted / (100 * step)),
                        Math.floor((max - min) * cap / (100 * step) + 1e-8));
                    const applied = Math.min(max, min + steps * step);
                    if (fromCurrent && Math.abs(current - applied) > epsilon &&
                        Math.abs((await renderer.getVolume()) - current) > epsilon) {
                        throw new Changed('Speaker volume changed before applying its member rule.');
                    }
                    const entry = {kind, target: room, original, applied, epsilon, requested: base, verified: false};
                    if (previous) Object.assign(previous, entry);
                    else unit.volumes.push(entry);
                    if (persist) await this.save();
                    if (Math.abs(current - applied) > epsilon) {
                        await this.checkTopology(unit);
                        assertState(await control.read(), unit, true);
                        await renderer[`set${kind}`](applied);
                        if (Math.abs((await renderer[`get${kind}`]()) - applied) > epsilon) {
                            throw new Error(`Speaker did not confirm the requested ${kind.toLowerCase()}.`);
                        }
                    }
                    (previous ?? entry).verified = true;
                    if (persist) await this.save();
                };
                if (room.id === unit.target.id) await apply(control);
                else await this.withTarget(room, apply);
            } catch (error) {
                if (error.journal) throw error;
                this.note(report, room, `set${kind}`, error, !explicit && error instanceof Unsupported);
            }
        }
    }

    async transport(unit, control, command) {
        const state = {Pause: PAUSED, Play: PLAYING, Stop: 'STOPPED'}[command];
        unit.pending = {kind: 'transport', state};
        await this.save();
        let commandError;
        try { await control.command(command); }
        catch (error) { commandError = error; }
        if (commandError instanceof Unsupported) {
            unit.pending = null;
            await this.save();
            throw commandError;
        }
        const actual = await waitFor(async () => {
            const current = await control.read();
            if (command === 'Stop' && unit.target.protocol === 'cast' && !current.uri && stopped(current.state) &&
                current.app === unit.expected.app) return current;
            let stoppedQueueOwned = false;
            if (command === 'Stop' && unit.target.protocol === 'sonos' && unit.handoff &&
                stopped(current.state) && sameUri(current.uri, unit.handoff.uri)) {
                const version = await control.queueVersion();
                const index = Number(current.position?.Track) - 1;
                stoppedQueueOwned = version.revision === unit.handoff.revision && version.count === unit.handoff.items.length &&
                    (sameUri(current.track, unit.handoff.items[index]?.url) ||
                        (Number(current.position?.Track) === 0 && !current.track));
            }
            if (!stoppedQueueOwned && !sourceMatches(current, unit.expected, unit.target)) {
                throw new Changed('Speaker source changed during transport command.');
            }
            const windowsStopped = command === 'Stop' && !commandError && unit.target.windowsRenderer &&
                current.state === PAUSED && seconds(current.position?.RelTime) === 0;
            return (current.state === state || (command === 'Stop' && stopped(current.state)) || windowsStopped) && current;
        }, `Speaker did not confirm ${command}.`).catch(error => { throw commandError ?? error; });
        setExpected(unit, actual);
        unit.pending = null;
        await this.save();
    }

    async control(command, report) {
        for (const unit of this.journal.units) {
            try {
                if (!unit.loaded || unit.releasing || unit.pending) throw new Error('The speaker needs cleanup before further controls.');
                await this.withTarget(unit.target, async control => {
                    await this.checkTopology(unit);
                    const current = await this.observe(unit, control);
                    assertState(current, unit);
                    if (current.state === (command === 'Pause' ? PAUSED : PLAYING)) return;
                    await this.transport(unit, control, command);
                    if (command === 'Pause') {
                        unit.remaining = unit.endAt ? Math.max(0, unit.endAt - Date.now()) : 0;
                        unit.endAt = 0;
                    } else {
                        unit.endAt = unit.remaining ? Date.now() + unit.remaining : 0;
                    }
                    await this.save();
                });
            } catch (error) {
                if (error.journal) throw error;
                this.note(report, unit.target, command.toLowerCase(), error);
            }
        }
    }

        async recoverPending(unit, control) {
            const pending = unit.pending;
            if (!pending) return;
            const current = await control.read();
            const previous = sourceMatches(current, unit.expected, unit.target);
            if (pending.kind === 'queue') {
                if (!previous || current.state !== unit.expected.state) throw new Changed('Cannot prove ownership of the interrupted queue load.');
            } else if (pending.kind === 'load') {
                if (unit.target.protocol !== 'cast' && sameUri(current.uri, pending.uri) &&
                    (!current.track || sameUri(current.track, pending.uri)) && supportedState(current.state)) {
                    unit.loaded = true;
                    setExpected(unit, current);
                } else if (!previous || current.state !== unit.expected.state) {
                    throw new Changed('Cannot prove ownership of the interrupted load.');
                }
            } else if (pending.kind === 'transport') {
                const castStopped = pending.state === 'STOPPED' && unit.target.protocol === 'cast' &&
                    !current.uri && current.app === unit.expected.app && stopped(current.state);
                if ((previous && (current.state === pending.state ||
                    (pending.state === 'STOPPED' && stopped(current.state)))) || castStopped) {
                    setExpected(unit, current);
                } else if (!previous || current.state !== unit.expected.state) {
                    throw new Changed('Cannot prove ownership of the interrupted transport command.');
                }
            }
            unit.pending = null;
            await this.save();
        }

        async recoverJoin(unit, room, follower) {
            if (await this.observeJoin(unit, room, follower, false)) {
                await this.save();
                return;
            }
            const group = roomGroup(await topology(room.target), room.target);
            const state = await follower.read();
            if (groupKey(group) === groupKey(room.group) &&
                sourceMatches(state, room.original, room.target) && state.state === room.original.state) {
                room.phase = 'original';
                await this.save();
                return;
            }
            throw new Changed('Cannot prove ownership of the interrupted Sonos join.');
        }

        async detach(unit, room, follower) {
            const readStandalone = async () => {
                const group = roomGroup(await topology(room.target), room.target);
                if (groupKey(group) !== groupKey(room.group)) return;
                const state = await follower.read();
                // TV/line-in autoplay may have already restored this room.
                if (input(room.original.uri) && sameUri(state.uri, room.original.uri)) {
                    room.phase = 'original';
                    return true;
                }
                if (stopped(state.state) && (!state.uri || sameUri(state.uri, unit.expected.uri))) {
                    setExpected(room, state);
                    room.phase = 'detached';
                    return true;
                }
            };
            if (room.phase === 'joined') {
                if (await readStandalone()) { await this.save(); return; }
                await this.checkTopology(unit);
                const current = await follower.read();
                if (current.uri.toUpperCase() !== link(idOf(unit.target)).toUpperCase()) {
                    throw new Changed('Sonos follower changed source before leaving the temporary group.');
                }
                room.phase = 'detaching';
                await this.save();
                let detachError;
                try { await soap(room.target, 'BecomeCoordinatorOfStandaloneGroup'); }
                catch (error) { detachError = error; }
                await waitFor(readStandalone, 'Sonos follower did not confirm stand-alone, stopped playback.')
                    .catch(error => { throw detachError ?? error; });
            } else if (room.phase === 'detaching') {
                const group = roomGroup(await topology(room.target), room.target);
                const withRoom = expectedGroup(unit);
                withRoom.members.push(...room.group.members);
                if (groupKey(group) === groupKey(withRoom)) {
                    room.phase = 'joined';
                    return this.detach(unit, room, follower);
                }
                await waitFor(readStandalone, 'Could not verify an interrupted Sonos detach.');
            }
            await this.save();
            await waitFor(async () => {
                const group = roomGroup(await topology(unit.target), unit.target);
                return groupKey(group) === groupKey(expectedGroup(unit));
            }, 'Former Sonos coordinator still reports the follower.');
        }

        async restoreVolume(unit, control, report) {
            for (const volume of unit.volumes) {
                if (volume.restored || Math.abs(volume.original - volume.applied) <= volume.epsilon) continue;
                try {
                    const restore = async renderer => {
                        const {kind} = volume;
                        if (Math.abs((await renderer[`get${kind}`]()) - volume.applied) <= volume.epsilon) {
                            await this.checkTopology(unit);
                            assertState(await control.read(), unit, true);
                            await renderer[`set${kind}`](volume.original);
                            if (Math.abs((await renderer[`get${kind}`]()) - volume.original) > volume.epsilon) {
                                throw new Error(`Speaker did not confirm restoration of ${kind.toLowerCase()}.`);
                            }
                        }
                        volume.restored = true;
                        await this.save();
                    };
                    if (volume.target.id === unit.target.id) await restore(control);
                    else await this.withTarget(volume.target, restore);
                } catch (error) {
                    if (error.journal || error instanceof Changed) throw error;
                    this.note(report, volume.target, `restore ${volume.kind.toLowerCase()}`, error);
                }
            }
        }

        async restoreSource(unit, control, report, topologyGuard) {
            const saved = unit.original;
            // Google Services hosts temporary announcement clips on its TTS
            // endpoint. Topology cleanup is independent of restoring media.
            if (isAnnouncementUri(saved.uri) || isAnnouncementUri(saved.track)) return;
            if (this.journal.options?.restoreQueue === false &&
                (/^x-rincon-queue:/i.test(saved.uri) || (/^https?:/i.test(normalized(saved.uri)) && !live(saved)) ||
                    seconds(saved.position?.TrackDuration) > 0 ||
                    Number(saved.media?.duration) > 0)) return;
            const finished = state => sameUri(state.uri, saved.uri) &&
                ((saved.state === state.state) || (stopped(saved.state) && stopped(state.state)));
            const cast = unit.target.protocol === 'cast';
            if (cast && !(saved.media && [PLAYING, PAUSED].includes(saved.state))) return;
            if (unit.sourceRestored) return;
            // Some Sonos receivers are exposed only as DLNA renderers. The
            // saved live scheme, not the discovery label or renderer ID,
            // establishes that there is no position to verify.
            const liveRadio = !cast && saved.state === PLAYING && live(saved);
            const guard = async () => {
                await topologyGuard();
                const state = await control.read();
                if (liveRadio ? state.uri !== saved.uri : !sameUri(state.uri, saved.uri)) {
                    throw new Changed('Speaker source changed during restoration.');
                }
                return state;
            };
            await topologyGuard();
            const current = await control.read();
            let positionRestored;
            const observingReconnect = unit.restoringSource && liveRadio && current.uri === saved.uri;
            if (observingReconnect) {
                // Radio has no position to restore. Observe a reconnect on
                // retry, without reloading the URI or sending another Play.
                if (![PLAYING, 'TRANSITIONING'].includes(current.state)) {
                    throw new Changed('Radio playback state changed during restoration.');
                }
            } else {
                if (unit.restoringSource && finished(current)) {
                    // The old URI cannot confirm a queue seek or Cast session.
                    throw new Changed('Source returned during interrupted restoration; its previous position could not be verified.');
                }
                assertState(current, unit, true);
                unit.restoringSource = true;
                await this.save();
                positionRestored = await control.restore(saved, guard,
                    error => this.note(report, unit.target, 'restore position', error, true));
            }
            await waitFor(async () => {
                const state = await guard();
                if (observingReconnect && ![PLAYING, 'TRANSITIONING'].includes(state.state)) {
                    throw new Changed('Radio playback state changed during restoration.');
                }
                return finished(state) && (!positionRestored || positionRestored(state));
            }, liveRadio ? 'Speaker did not confirm that the original radio source resumed playing.' :
                'Speaker did not confirm restoration of the previous playback state and position.');
            unit.sourceRestored = true;
            await this.save();
        }

        async releaseUnit(unit, restore, report) {
            let discard = false;
            try {
                if (!unit.releasing) {
                    unit.releasing = true;
                    unit.restoreOnRelease = restore;
                    await this.save();
                }
                restore = unit.restoreOnRelease;
                await this.withTarget(unit.target, async control => {
                    for (const room of unit.joins.filter(room => room.phase === 'joining')) {
                        await this.withTarget(room.target, follower => this.recoverJoin(unit, room, follower));
                    }
                    for (const room of unit.joins.filter(room => room.phase === 'detaching')) {
                        await this.withTarget(room.target, follower => this.detach(unit, room, follower));
                    }
                    // A joined TV can return to its original standalone input
                    // without UMP issuing any command. Validate its own view.
                    for (const room of unit.joins.filter(room => room.phase === 'joined' && input(room.original.uri))) {
                        await this.withTarget(room.target, async follower => {
                            const group = roomGroup(await topology(room.target), room.target);
                            if (groupKey(group) === groupKey(room.group) && sameUri((await follower.read()).uri, room.original.uri)) {
                                room.phase = 'original';
                                await this.save();
                            }
                        });
                    }
                    await this.checkTopology(unit);
                    await this.recoverPending(unit, control);
                    if (!unit.restoringSource) {
                        const state = await this.observe(unit, control);
                        const inputReturned = input(unit.original.uri) && sameUri(state.uri, unit.original.uri) &&
                            state.state === unit.original.state;
                        if (inputReturned) setExpected(unit, state);
                        assertState(state, unit, true);
                        await this.clearNext(unit, control, state);
                        await this.restoreVolume(unit, control, report);
                        const joined = unit.joins.some(room => room.phase === 'joined');
                        if ((unit.loaded || joined) && !inputReturned && !stopped(state.state)) {
                            await this.checkTopology(unit);
                            assertState(await this.observe(unit, control), unit, true);
                            await this.transport(unit, control, 'Stop');
                        } else if (stopped(state.state)) {
                            setExpected(unit, state);
                        }
                        delete unit.handoff;
                        if (inputReturned) unit.sourceRestored = true;
                        await this.save();
                        for (const room of unit.joins.filter(room => room.phase === 'joined')) {
                            await this.withTarget(room.target, follower => this.detach(unit, room, follower));
                        }
                    }
                    for (const room of unit.joins.filter(room => room.phase === 'detached')) {
                        if (restore || !unit.loaded) {
                            await this.withTarget(room.target, follower => this.restoreSource(room, follower, report, async () => {
                                const group = roomGroup(await topology(room.target), room.target);
                                if (groupKey(group) !== groupKey(room.group)) throw new Changed('Sonos follower is no longer standalone.');
                            }));
                        }
                    }
                    if (restore && unit.loaded) {
                        await this.restoreSource(unit, control, report, () => this.checkTopology(unit));
                    } else if (!unit.loaded && unit.original.state !== unit.expected.state) {
                        // Roll back a pause made before joining, even if the
                        // requested session never reached its first track.
                        await this.restoreSource(unit, control, report, () => this.checkTopology(unit));
                    }
                });
                // Failed volume writes are reported above. Do not retry after
                // restoring playback as we no longer own the session's source.
                discard = true;
            } catch (error) {
                if (error.journal) throw error;
                this.note(report, unit.target, 'stop/restore', error);
                // Never reclaim externally changed state. An I/O failure instead
                // retains the journal for a subsequent explicit stop/recovery.
                discard = error instanceof Changed || error instanceof Unsupported;
            }
            if (discard) {
                this.journal.units = this.journal.units.filter(entry => entry !== unit);
                await this.save();
                for (const room of unit.rooms) {
                    if (ownedTargets.get(keyFor(room)) === this.owner) ownedTargets.delete(keyFor(room));
                }
            }
        }

        async release(restore, report) {
            for (const unit of [...this.journal.units]) await this.releaseUnit(unit, restore, report);
        }
}

module.exports = DirectSpeakerSession;
module.exports.DirectSpeakerSession = DirectSpeakerSession;
module.exports.controller = {
    adapter, soap, topology, roomGroup, groupKey, idOf, seconds, waitFor, castCall, sonosInput,
    isOwned: target => ownedTargets.has(keyFor(target)),
    getOwner: target => ownedTargets.get(keyFor(target)),
    abandonOwnership(owner) {
        for (const [key, value] of ownedTargets) if (value === owner) ownedTargets.delete(key);
    },
    runExclusive(work) {
        const run = serial.then(work);
        serial = run.catch(() => {});
        return run;
    }
};
