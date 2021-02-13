// Original Code from https://github.com/dalhundal/sky-q


const upnp = require('node-upnp-utils');
const xml2js = require('xml2js');
const { Defer } = require('./proto');
const _ = require('lodash-core');

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
//const  http  = require('http.min');

class PlaylistManager {

    //_playlists = [];
    // get playlists() { return this._playlists; }
    // set playlists(v) { this._playlists = v; }
    playlists = [];

    constructor({homey}) {
        this.homey = homey;
        setPlaylistFromSettings.call(this);

        homey.settings.on('set', ((settingName) => {
            if(settingName=='playlists') setPlaylistFromSettings.call(this);
        }).bind(this));


        async function setPlaylistFromSettings() {            
            return this.playlists = await getPlaylistFromSettings();
        }
        async function getPlaylistFromSettings() {
            var playlists = await homey.settings.get('playlists');
            //console.log('getPlaylistFromSettings.playlists: ');
            //console.log(playlists);
            if(!playlists) playlists=[];
            return playlists;
        }
    }
    


}

module.exports = PlaylistManager;