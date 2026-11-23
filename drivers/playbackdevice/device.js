'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const {pipeline} = require('node:stream/promises');
const {Transform} = require('node:stream');
const {ORDER, features, capabilities, values} = require('../../lib/speaker-device');
const widgetPlayback = require('../../lib/widget-playback');
const samsung = require('../../lib/samsung-tv');
const speakerInputs = require('../../lib/speaker-inputs');
const {controller} = require('../../lib/direct-speaker-session');

const PLAYING_POLL = 10000;
// Below the 35-second speaker event watch lifetime, so UPnP subscriptions stay active.
const IDLE_POLL = 25000;
const MAX_ERROR_POLL = 60000;

class SpeakerDevice extends Homey.Device {
    async onInit() {
        this.speakerId = this.getData().id;
        this.failures = 0;
        this.lastRefresh = 0;
        if (this.getStoreValue('kind') === 'tv' && this.getClass() !== 'tv') {
            await this.setClass('tv').catch(error => this.error('Unable to set the TV device class:', error));
        }
        await this.syncCapabilities(features(this.getStoreValue('protocol'), null, this.getStoreValue('features') || {}));
        this.registerListeners();
        this.onSpeakerUpdate = id => { if (id === this.speakerId) this.scheduleRefresh(200); };
        this.onPlayerUpdate = () => {
            if (this.state?.managed || widgetPlayback.owned(this.homey, this.speakerId)) this.scheduleRefresh(500);
        };
        this.homey.app.speakerUpdates?.on('speaker', this.onSpeakerUpdate);
        this.homey.app.speakerUpdates?.on('player', this.onPlayerUpdate);
        this.scheduleRefresh(1000 + Math.floor(Math.random() * 2000));
    }

    registerListeners() {
        const actions = {
            speaker_playing: value => this.command(value ? 'play' :
                this.state?.actions?.pause === false && this.state?.actions?.stop ? 'stop' : 'pause'),
            speaker_stop: () => this.command('stop'),
            speaker_next: () => this.command('next'),
            speaker_prev: () => this.command('previous'),
            speaker_shuffle: value => this.command('shuffle', value),
            speaker_repeat: value => this.command('repeat', value),
            speaker_position: value => this.command('seek', Math.max(0, Number(value) || 0) * 1000),
            volume_set: value => this.command('volume', value),
            volume_mute: value => this.command('mute', value),
            volume_up: () => this.command('volumeUp'),
            volume_down: () => this.command('volumeDown'),
            onoff: value => this.settle(this.setPower(value)),
            media_input: value => this.selectInput(value)
        };
        this.listening ??= new Set();
        for (const [capability, action] of Object.entries(actions)) {
            if (this.listening.has(capability) || !this.hasCapability(capability)) continue;
            this.registerCapabilityListener(capability, action);
            this.listening.add(capability);
        }
    }

    async syncCapabilities(found) {
        if (JSON.stringify(found) !== JSON.stringify(this.getStoreValue('features') || {})) {
            await this.setStoreValue('features', found);
        }
        for (const capability of capabilities(found)) {
            if (!this.hasCapability(capability)) await this.addCapability(capability);
        }
        if (this.listening) this.registerListeners();
    }

    // media_input uses Homey's own Flow cards; its values are replaced by the inputs this device really has.
    async syncInputs(available) {
        const ids = available.map(item => item.id);
        if (!ids.length) return;
        if (!this.hasCapability('media_input')) await this.addCapability('media_input');
        if (JSON.stringify(ids) !== JSON.stringify(this.getStoreValue('inputs'))) {
            await this.setCapabilityOptions('media_input', {values: available});
            await this.setStoreValue('inputs', ids);
        }
        if (this.listening) this.registerListeners();
    }

    inputs() {
        const ids = this.getStoreValue('inputs') || [];
        return this.hasCapability('media_input') ? speakerInputs.titles(this.homey, ids, Boolean(this.getStoreValue('samsung'))) : [];
    }

    async selectInput(value) {
        if (!this.getStoreValue('samsung')) return this.command('setInput', value);
        const key = speakerInputs.SAMSUNG_KEYS[value];
        if (!key || !(this.getStoreValue('inputs') || []).includes(value)) throw new Error(this.homey.__('speakerDevice.unsupported'));
        const {tv, on} = await this.readPower();
        if (!tv || tv.power !== 'on' || on === false) throw new Error(this.homey.__('speakerDevice.tvOff'));
        try {
            const token = await samsung.sendKey(tv.host, this.getStoreValue('samsungToken'), key);
            if (token && token !== this.getStoreValue('samsungToken')) await this.setStoreValue('samsungToken', token);
        } catch (error) {
            if (error instanceof samsung.PermissionError) throw new Error(this.homey.__('speakerDevice.tvPermission'));
            throw error;
        }
    }

    widget() {
        return require('../../lib/media-widget');
    }

    async command(action, value) {
        const body = {speaker: this.speakerId, action, ...(value === undefined ? {} : {value})};
        let result;
        try {
            result = await this.widget().control({homey: this.homey, body});
        } catch (error) {
            if (error?.message === this.homey.__('widget.invalidAction')) {
                this.scheduleRefresh(200);
                throw new Error(this.homey.__('speakerDevice.unsupported'));
            }
            throw error;
        }
        if (result?.player?.controlRejected) throw new Error(this.homey.__('speakerDevice.unsupported'));
        if (result?.player) await this.apply(result.player);
        this.scheduleRefresh(1500);
    }

    scheduleRefresh(delay) {
        if (this.deleted) return;
        const due = Date.now() + delay;
        if (this.refreshTimer && this.refreshDue <= due) return;
        this.homey.clearTimeout(this.refreshTimer);
        this.refreshDue = due;
        this.refreshTimer = this.homey.setTimeout(() => {
            this.refreshTimer = null;
            this.refresh().catch(error => this.error('Speaker refresh failed:', error));
        }, delay);
    }

    async refresh() {
        if (this.refreshing) {
            this.refreshAgain = true;
            return;
        }
        this.refreshing = true;
        this.lastRefresh = Date.now();
        try {
            const result = await this.widget().state({homey: this.homey, query: {speaker: this.speakerId}});
            if (!result.player) throw new Error(result.error || this.homey.__('speakerDevice.unreachable'));
            await this.apply(result.player);
            this.failures = 0;
            if (!this.getAvailable()) await this.setAvailable();
        } catch (error) {
            this.failures++;
            this.log('Unable to read speaker state:', error.message);
            // A switched-off TV must stay available, otherwise it can't be switched on again from Homey.
            if (this.failures >= 3 && this.getAvailable() && !this.getStoreValue('samsung')) {
                await this.setUnavailable(this.homey.__('speakerDevice.unreachable'))
                    .catch(failure => this.error('Unable to mark the speaker unavailable:', failure));
            }
        } finally {
            await this.refreshPower().catch(error => this.error('Unable to read the TV power state:', error));
            this.refreshing = false;
            const again = this.refreshAgain;
            this.refreshAgain = false;
            this.scheduleRefresh(again ? Math.max(200, 1000 - (Date.now() - this.lastRefresh))
                : this.failures ? Math.min(MAX_ERROR_POLL, IDLE_POLL * this.failures)
                    : this.state?.playing ? PLAYING_POLL : IDLE_POLL);
        }
    }

    async apply(state) {
        if (this.deleted) return;
        this.state = state;
        await this.syncCapabilities(features(this.getStoreValue('protocol'), state, this.getStoreValue('features') || {}));
        if (state.inputs) {
            const known = this.getStoreValue('inputs') || [];
            // Line-in support observed once stays available while the speaker plays something else.
            const order = ['tv', 'line_in', 'queue'];
            const merged = [...state.inputs, ...speakerInputs.titles(this.homey, known.filter(id =>
                !state.inputs.some(item => item.id === id)))].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
            await this.syncInputs(merged);
            if (this.hasCapability('media_input') && this.getCapabilityValue('media_input') !== state.input) {
                await this.setCapabilityValue('media_input', state.input).catch(error =>
                    this.error('Unable to update media_input:', error));
            }
        }
        const next = values(state);
        for (const capability of ORDER) {
            if (!this.hasCapability(capability) || next[capability] == null) continue;
            if (this.getCapabilityValue(capability) !== next[capability]) {
                await this.setCapabilityValue(capability, next[capability]).catch(error =>
                    this.error(`Unable to update ${capability}:`, error));
            }
        }
        await this.updateArtwork(state.artworkFallback || state.artwork || null);
    }

    tvHost() {
        const known = this.getStoreValue('samsung');
        return this.homey.app.speakerPlayback?.speakerInfo?.(this.speakerId)?.host || known?.host || null;
    }

    async describeTv() {
        const known = this.getStoreValue('samsung');
        const live = this.homey.app.speakerPlayback?.speakerInfo?.(this.speakerId);
        let tv = null;
        if (known?.id) {
            for (const host of new Set([live?.host, known.host].filter(Boolean))) {
                tv = await samsung.describe(host, {id: known.id});
                if (tv) { tv.host = host; break; }
            }
        } else if (live?.samsung && live.model) {
            tv = await samsung.describe(live.host, {model: live.model});
            if (tv) tv.host = live.host;
        } else {
            this.homey.app.speakerPlayback?.refreshInBackground?.();
        }
        if (!tv) return null;
        const record = {id: tv.id, host: tv.host, mac: tv.mac || known?.mac || null, frame: tv.frame};
        if (JSON.stringify(record) !== JSON.stringify(known)) await this.setStoreValue('samsung', record);
        if (!this.hasCapability('onoff')) {
            await this.addCapability('onoff');
            this.registerListeners();
        }
        if (tv.power === 'on') {
            await this.syncInputs(speakerInputs.titles(this.homey, speakerInputs.samsungInputs({kind: 'tv', samsung: true}), true));
        }
        return {...tv, ...record};
    }

    // Samsung TVs: off is the screen being off or showing art (Frame), matching the remote's power button.
    // A Frame whose art status can't be read is unknown (null), never assumed on: pressing power could wake it.
    async readPower() {
        const tv = await this.describeTv();
        if (!tv || tv.power !== 'on') return {tv, on: false};
        if (!tv.frame) return {tv, on: true};
        const token = this.getStoreValue('samsungToken');
        const art = token ? await samsung.artMode(tv.host, token).catch(() => null) : null;
        return {tv, on: art === null ? null : !art, art};
    }

    async refreshPower() {
        if (this.getStoreValue('kind') !== 'tv' || this.getStoreValue('protocol') !== 'dlna' || this.powerBusy) return;
        if (Date.now() - (this.powerCheckedAt || 0) < 20000) return;
        this.powerCheckedAt = Date.now();
        const known = this.getStoreValue('samsung');
        const {tv, on} = await this.readPower();
        if (!tv && !known) return;
        if (on !== null && this.hasCapability('onoff') && this.getCapabilityValue('onoff') !== on) {
            await this.setCapabilityValue('onoff', on);
        }
        if (known && !this.getAvailable()) await this.setAvailable();
    }

    async pressPower(host) {
        try {
            const token = await samsung.sendKey(host, this.getStoreValue('samsungToken'), 'KEY_POWER');
            if (token && token !== this.getStoreValue('samsungToken')) await this.setStoreValue('samsungToken', token);
        } catch (error) {
            if (error instanceof samsung.PermissionError) throw new Error(this.homey.__('speakerDevice.tvPermission'));
            throw error;
        }
    }

    // Waking a TV or waiting for the TV's permission prompt can outlast Homey's request timeout;
    // after a while the command continues in the background and the next refresh shows the result.
    async settle(task, wait = 8000) {
        let timer;
        const outcome = task.then(() => ({}), error => ({error}));
        const slow = new Promise(resolve => { timer = this.homey.setTimeout(() => resolve(null), wait); });
        try {
            const result = await Promise.race([outcome, slow]);
            if (!result) outcome.then(({error}) => error && this.error('TV power command failed:', error.message));
            else if (result.error) throw result.error;
        } finally {
            this.homey.clearTimeout(timer);
        }
    }

    // Resolves true when switching on started from a confirmed off state (reachable in standby or art mode,
    // or seen in standby while waking); a TV that was only unreachable and came back on is not confirmed.
    async setPower(value) {
        this.powerBusy = true;
        try {
            const {tv, on} = await this.readPower();
            if (on === null) {
                // A Frame whose art status can't be read: a manual command acts like the remote's power button.
                // The resulting state is unknown, so the stored On/Off value is put back once Homey has stored the request.
                const previous = this.getCapabilityValue('onoff');
                await this.pressPower(tv.host);
                this.homey.setTimeout(() => this.setCapabilityValue('onoff', previous).catch(() => {}), 1000);
                return false;
            }
            if (on === value) return false;
            if (!value) {
                if (tv) await this.pressPower(tv.host);
                return false;
            }
            if (tv?.power === 'on') {
                await this.pressPower(tv.host);
                return true;
            }
            let confirmed = Boolean(tv);
            const known = this.getStoreValue('samsung');
            if (!known?.mac) throw new Error(this.homey.__('speakerDevice.tvUnreachable'));
            // A fully-off TV first wakes its network ("standby"); repeating the packet usually turns the screen on.
            // A Frame can stay in standby: after two consecutive standby reads press Power once (never twice, it toggles).
            const until = Date.now() + 40000;
            let standby = 0, pressed = false;
            while (Date.now() < until) {
                if (!pressed) await samsung.wake(this.tvHost() || known.host, known.mac);
                await new Promise(resolve => this.homey.setTimeout(resolve, 4000));
                const state = await samsung.describe(this.tvHost() || known.host, {id: known.id});
                if (state?.power === 'on') return confirmed;
                if (state) confirmed = true;
                standby = state?.power === 'standby' ? standby + 1 : 0;
                if (standby >= 2 && !pressed) {
                    pressed = true;
                    await this.pressPower(this.tvHost() || known.host);
                }
            }
            throw new Error(this.homey.__('speakerDevice.tvUnreachable'));
        } finally {
            this.powerBusy = false;
            this.powerCheckedAt = 0;
            this.scheduleRefresh(3000);
        }
    }

    // Automatic power for announcements: only claim a TV that was switched on from a confirmed off state.
    async autoPowerOn() {
        if (this.powerBusy) return false;
        const {on} = await this.readPower();
        if (on !== false) return false;
        const confirmed = await this.setPower(true);
        await this.setCapabilityValue('onoff', true).catch(() => {});
        return confirmed;
    }

    // Leave the TV on when it was switched off meanwhile, its state is unknown, or UMP playback now uses it.
    async autoPowerOff() {
        if (this.powerBusy) return;
        const info = (this.homey.app.speakerPlayback?.speakers || []).find(speaker => speaker.id === this.speakerId);
        if (widgetPlayback.owned(this.homey, this.speakerId) || (info && controller.isOwned(info))) return;
        const {on} = await this.readPower();
        if (on !== true) return;
        await this.setPower(false);
        await this.setCapabilityValue('onoff', false).catch(() => {});
    }

    async updateArtwork(url) {
        if (url === this.artworkUrl) return;
        this.artworkUrl = url;
        try {
            if (!this.image) {
                this.image = await this.homey.images.createImage();
                await this.setAlbumArtImage(this.image);
            }
            if (url) this.image.setStream(stream => this.streamArtwork(url, stream));
            else this.image.setUrl(null);
            await this.image.update();
        } catch (error) {
            this.error('Unable to update speaker artwork:', error);
        }
    }

    async streamArtwork(url, stream) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 5000);
        try {
            const response = await fetch(url, {follow: 3, signal: abort.signal});
            if (!response.ok || !/^image\/(?:jpeg|png|gif|webp|bmp|avif)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
                response.body?.destroy();
                throw new Error('The speaker did not return a supported image.');
            }
            let bytes = 0;
            await pipeline(response.body, new Transform({
                transform(chunk, encoding, done) {
                    bytes += chunk.length;
                    if (bytes > 2 * 1024 * 1024) done(new Error('Speaker artwork exceeds 2 MiB.'));
                    else done(null, chunk);
                }
            }), stream);
        } finally { clearTimeout(timer); }
    }

    async stop() {
        this.deleted = true;
        this.homey.clearTimeout(this.refreshTimer);
        this.homey.app.speakerUpdates?.off('speaker', this.onSpeakerUpdate);
        this.homey.app.speakerUpdates?.off('player', this.onPlayerUpdate);
        await this.image?.unregister().catch(error => this.error('Unable to remove speaker artwork:', error));
        this.image = null;
    }

    async onDeleted() {
        await this.stop();
    }

    async onUninit() {
        await this.stop();
    }
}

module.exports = SpeakerDevice;
