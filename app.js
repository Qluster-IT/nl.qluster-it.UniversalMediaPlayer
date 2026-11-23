'use strict';

const Homey = require('homey');
const {EventEmitter} = require('node:events');
const SpeakerPlayback = require('./lib/speaker-playback');
const {SpeakerGroups} = require('./lib/speaker-groups');
const SpeakerEvents = require('./lib/speaker-events');
const SpeakerArtwork = require('./lib/speaker-artwork');

class UPnPPlayerApp extends Homey.App {
    async onInit() {
        this.apiReady = false;
        this.speakerGroups = new SpeakerGroups(this.homey.settings, () => this.speakerPlayback.listSpeakers(true));
        this.speakerPlayback = new SpeakerPlayback(
            (...args) => this.log(...args),
            key => this.homey.__(`speakers.${key}`),
            error => this.error('Restoring speaker state failed:', error),
            () => this.speakerGroups.list(),
            this.homey.settings
        );
        this.widgetHomeyId = await this.homey.cloud.getHomeyId();
        this.speakerUpdates = new EventEmitter();
        this.speakerUpdates.setMaxListeners(0);
        this.speakerPlayback.paired = () => this.homey.drivers.getDriver('playbackdevice').getDevices().map(device => ({
            id: device.getData().id, name: device.getName(), protocol: device.getStoreValue('protocol')
        }));
        this.speakerEvents = new SpeakerEvents(this.homey);
        this.speakerArtwork = new SpeakerArtwork(this.homey);
        this.homey.dashboards.getWidget('media').registerSettingAutocompleteListener('player', async query => {
            const { getPlayers } = require('./lib/media-widget');
            return getPlayers(this.homey)
                .map(player => ({id: player.getData().id, name: player.getName()}))
                .filter(player => player.name.toLowerCase().includes(query.toLowerCase()));
        });
        this.apiReady = true;
        this.speakerPlayback.refreshInBackground();
        await this.homey.api.realtime('api-ready', {ready: true}).catch(error => {
            this.error('Unable to signal API readiness:', error);
        });
        await this._notifyReleaseFeatures();
        this.log('UPnPPlayerApp is running...');
    }

    async _notifyReleaseFeatures() {
        const key = 'umpSpeakerPlaybackReleaseNoticeAttempted';
        try {
            if (this.homey.settings.get(key)) return;
            await this.homey.settings.set(key, true);
            await this.homey.notifications.createNotification({excerpt: this.homey.__('release.speaker_playback_notice')});
        } catch (error) {
            this.error('Unable to deliver release notification:', error);
        }
    }

    async onUninit() {
        await Promise.all([this.speakerEvents?.close(), this.speakerArtwork?.close()]);
    }
}

module.exports = UPnPPlayerApp;