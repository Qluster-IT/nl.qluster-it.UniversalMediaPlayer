// Original Code from https://github.com/dalhundal/sky-q


const upnp = require('node-upnp-utils');
const xml2js = require('xml2js');
const { Defer } = require('./proto');
const _ = require('lodash-core');

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const UPnPServer = require('./upnpserver');

// const UPnPPlayerApp = require('./../app');
// const UPnPPlayerDevice = require('./../drivers/upnpplayer/device');
//const  http  = require('http.min');

class PlaylistManager {
    
    //get playing() { return true; }
    set playing(v) { 
        return this.uPnPPlayer.setCapabilityValue('speaker_playing', v);        
    }
    
    currentFile = undefined;
    

    //_playlists = [];
    // get playlists() { return this._playlists; }
    // set playlists(v) { this._playlists = v; }
    playlists = [];
    /**
     * 
     * @param {object} param 
     * @param {object} param.homey 
     * @param {import('../drivers/upnpplayer/device')} param.uPnPPlayer 
     */
    constructor({homey, uPnPPlayer}) {
        this.homey = homey;
        this.uPnPPlayer = uPnPPlayer;
        //this.device=device;

        // setPlaylistFromSettings.call(this);

        // homey.settings.on('set', ((settingName) => {
        //     if(settingName=='playlists') setPlaylistFromSettings.call(this);
        // }).bind(this));


        // async function setPlaylistFromSettings() {            
        //     return this.playlists = await getPlaylistFromSettings();
        // }
        // async function getPlaylistFromSettings() {
        //     var playlists = await homey.settings.get('playlists');
        //     //console.log('getPlaylistFromSettings.playlists: ');
        //     //console.log(playlists);
        //     if(!playlists) playlists=[];
        //     return playlists;
        // }
    }

    async PlayFile({file, message}) {
        this.files = [await this.uPnPPlayer.server.getFromLocation({item:file, search:'file'})];
        this.filesIndex = {};
        if(this.files && this.files.length>0) this.filesIndex[this.files[0].id] = { index : 0, played : false, file:this.files[0] } 
        //this.played = [];
        this.PlayNext({mode:'single'});
    }

    async PlayFolder({folder, mode}) {
        //this.folder = folder;
        this.folder = folder ? await this.uPnPPlayer.server.getFromLocation({item:folder, search:'folders'}) : null;
        this.files = folder ? await this.uPnPPlayer.server.browseById({id:folder.id, search:'files'}) : null;
        this.filesIndex = {};
        this.playingIndex = -1;
        if(this.files) this.files.forEach((f, index)=>this.filesIndex[f.id] = { index : index, played : false, file:f } );
        this.mode = mode;
        this.PlayNext();
    }
    PlayNext({mode, message}) {
        this.finishedMessage = message;
        //if(!this.files && this.playing) return this.Stop();
        if(!this.files && this.files.length==0 && !this.files[0]) return this.Stop();
        mode = mode || this.mode;
        switch (mode) {
            case 'single':
                this.currentFile = this.files[0];
                break;
            case 'randomsingle':
                this.currentFile = this.files.random();
                break;
            case 'normal':
                this.playingIndex++;
                if(this.files.length>this.playingIndex) this.currentFile = this.files[this.playingIndex];
                else return this.Stop();
                break;
            case 'repeat':
                this.playingIndex++;
                if(!(this.files.length>this.playingIndex)) this.playingIndex=0;
                this.currentFile = this.files[this.playingIndex];
                break;
            case 'random':
                var files = _.filter(this.files, f=> !this.filesIndex[f.id].played);
                this.currentFile = files.random();                
                break;
            case 'randomrepeat':
                var files = _.filter(this.files, f=> !this.filesIndex[f.id].played);
                if(files.length==0) {
                    this.files.forEach(f=>f.played=false);
                    files = this.files;
                }
                this.currentFile = files.random();                
                break;
            default:
                break;
        }

        console.log('PlayNext mode('+mode+'): ' + this.currentFile);
        this.Play(mode);
    }
    Play(mode) {
        mode = mode || this.mode;
        this.filesIndex[this.currentFile.id].played = true;
        this.playing = !!this.uPnPPlayer.driver.Triggers.url_trigger.Card.trigger(this.uPnPPlayer, {url:this.currentFile.url, duration:this.currentFile.duration} );
        this.SetFinishedTimer();
        if(['normal', 'repeat','random', 'randomrepeat'].indexOf(mode)>-1) this.SetTimer();
        return true;
    }

    Stop() {
        if(this.timer) clearTimeout(this.timer);
        this.uPnPPlayer.driver.Triggers.stopped_trigger.Card.trigger(this.uPnPPlayer);
        this.playing = false;
        return true;
    }
    
    TogglePlay(val) {
        console.log('TogglePlay');
        console.log(val);
        if(val) return this.Play();
        else return this.Stop();
    }

    SetTimer() {     
        if(this.timer) clearTimeout(this.timer);
        if(!this.currentFile) return;   
        var delay = this.uPnPPlayer.getSetting('delay');
        this.timer = setTimeout((()=> {
            this.PlayNext();
        }).bind(this), this.currentFile.duration + (delay || 1000));
    }

    SetFinishedTimer() {
        if(this.finishedTimer) clearTimeout(this.finishedTimer);
        var delay = this.uPnPPlayer.getSetting('delay');
        this.finishedTimer = setTimeout((()=> {            
            this.uPnPPlayer.driver.Triggers.finished_trigger.Card.trigger(this.uPnPPlayer, {hasMessage :!!this.finishedMessage, message:this.finishedMessage || 'No message'});
        }).bind(this), this.currentFile.duration + (delay || 1000));
    }
}

module.exports = PlaylistManager;