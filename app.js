'use strict';

const Homey = require('homey');

class UPnPPlayerApp extends Homey.App {
    async onInit() {
        this.widgetHomeyId = await this.homey.cloud.getHomeyId();
        this.homey.dashboards.getWidget('media').registerSettingAutocompleteListener('player', async query => {
            const { getPlayers } = require('./lib/media-widget');
            return getPlayers(this.homey)
                .map(player => ({id: player.getData().id, name: player.getName()}))
                .filter(player => player.name.toLowerCase().includes(query.toLowerCase()));
        });
        this.log('UPnPPlayerApp is running...');
    }

}

module.exports = UPnPPlayerApp;