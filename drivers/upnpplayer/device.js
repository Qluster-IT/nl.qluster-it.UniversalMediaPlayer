'use strict';

const Homey = require('homey');

const UPnPServer = require('./../../lib/upnpserver');
const PlaylistManager = require('./../../lib/playlistmanager');
const {requestVolume, stepVolume} = require('../../lib/speaker-volume');
const {notifyWidget} = require('../../lib/widget-updates');
const widgetPlayback = require('../../lib/widget-playback');

class UPnPPlayerDevice extends Homey.Device
{
    /**
     * onInit is called when the device is initialized.
     */
    async onInit()
    {
        this.log('UPnPPlayerDevice has been initialized');
        const capabilities = this.getCapabilities();

        const caps = [ 'speaker_repeat', 'speaker_position', 'speaker_stop', 'volume_set', 'volume_up', 'volume_down', 'volume_mute' ];
        for (const cap of caps) {
            if (!capabilities.includes(cap)) await this.addCapability(cap);
        }

        // register a capability listener
        //this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
        this.IP = this.getSetting('ip');
        this.server = new UPnPServer({ homey: this.homey, ip: this.IP });        
        this.playlistManager = new PlaylistManager({homey:this.homey, uPnPPlayer:this});
        
        this.registerCapabilityListener('speaker_playing', ( value, opts ) => {            
            return Promise.resolve(this.playlistManager.TogglePlay(value));
        });
        this.registerCapabilityListener('speaker_stop', () => this.playlistManager.Stop());
        for (const cap of ['volume_set', 'volume_mute']) {
            this.registerCapabilityListener(cap, value => requestVolume(this, cap, value));
        }
        this.registerCapabilityListener('volume_up', () => stepVolume(this, 1));
        this.registerCapabilityListener('volume_down', () => stepVolume(this, -1));
        this.registerCapabilityListener('speaker_prev', ( value, opts ) => {
            return Promise.resolve(this.playlistManager.PlayPrevious());
        });
        
        this.registerCapabilityListener('speaker_next', ( value, opts ) => {            
            return Promise.resolve(this.playlistManager.PlayNext());
        });
        
        this.registerCapabilityListener('speaker_shuffle', ( value, opts ) => {            
            return Promise.resolve(this.playlistManager.SetShuffle(value));
        });
        this.registerCapabilityListener('speaker_repeat', ( value, opts ) => {            
            return Promise.resolve(this.playlistManager.SetRepeat(value));
        });
        this.registerCapabilityListener('speaker_position', async () => {
            throw new Error(this.homey.__('playback.seekUnsupported'));
        });
        this.playlistManager.RestorePlayback();
        await this.playlistManager.RecoverDirect();
        await widgetPlayback.restore(this);
    }

    /**
     * onAdded is called when the user adds the device, called just after pairing.
     */
    async onAdded()
    {
        this.log('MyDevice has been added');
    }

    /**
     * onSettings is called when the user updates the device's settings.
     * @param {object} event the onSettings event data
     * @param {object} event.oldSettings The old settings object
     * @param {object} event.newSettings The new settings object
     * @param {string[]} event.changedKeys An array of keys changed since the previous version
     * @returns {Promise<string|void>} return a custom message that will be displayed
     */
    async onSettings({ newSettings, changedKeys })
    {
        if (changedKeys.includes('recentFolderLimit') && (!Number.isInteger(newSettings.recentFolderLimit)
            || newSettings.recentFolderLimit < 0 || newSettings.recentFolderLimit > 100)) {
            throw new Error(this.homey.__('widget.invalidRecentLimit'));
        }
        if (changedKeys.includes('recentFolderLimit') && this.playlistManager) {
            this.playlistManager.recentFolders = (this.playlistManager.recentFolders || []).slice(0, newSettings.recentFolderLimit);
            await this.playlistManager.SavePlayback();
        }
        if (changedKeys.includes('ip')) {
            this.IP = newSettings.ip;
            this.server = new UPnPServer({ homey: this.homey, ip: this.IP });
        }
    }

    /**
     * onRenamed is called when the user updates the device's name.
     * This method can be used this to synchronise the name to the device.
     * @param {string} name The new name
     */
    async onRenamed(name)
    {
        this.log('UPnPPlayerDevice was renamed');
        notifyWidget(this, true);
    }

    /**
     * onDeleted is called when the user deleted the device.
     */
    async onDeleted()
    {
        this.log('UPnPPlayerDevice has been deleted');
        await this.playlistManager?.Dispose();
        await widgetPlayback.dispose(this);
    }

    async onUninit()
    {
        await this.playlistManager?.Dispose();
        await widgetPlayback.dispose(this);
    }

}

module.exports = UPnPPlayerDevice;