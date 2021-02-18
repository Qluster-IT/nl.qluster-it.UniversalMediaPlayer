'use strict';

const Homey = require('homey');

const UPnPServer = require('./../../lib/upnpserver');
const PlaylistManager = require('./../../lib/playlistmanager');

class UPnPPlayerDevice extends Homey.Device
{
    /**
     * onInit is called when the device is initialized.
     */
    async onInit()
    {
        this.log('UPnPPlayerDevice has been initialized');

        // register a capability listener
        //this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
        this.IP = this.getSetting('ip');
        this.server = new UPnPServer({ homey: this.homey, ip: this.IP });        
        this.playlistManager = new PlaylistManager({homey:this.homey, uPnPPlayer:this});
        this.registerCapabilityListener('speaker_playing', ( value, opts ) => {
            this.playlistManager.TogglePlay(value);
            return Promise.resolve();
        });
        
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
    async onSettings({ oldSettings, newSettings, changedKeys })
    {
        this.log('UPnPPlayerDevice settings where changed');
    }

    /**
     * onRenamed is called when the user updates the device's name.
     * This method can be used this to synchronise the name to the device.
     * @param {string} name The new name
     */
    async onRenamed(name)
    {
        this.log('UPnPPlayerDevice was renamed');
    }

    /**
     * onDeleted is called when the user deleted the device.
     */
    async onDeleted()
    {
        this.log('UPnPPlayerDevice has been deleted');
        //clearTimeout(this.onOffTimer);
    }

}

module.exports = UPnPPlayerDevice;