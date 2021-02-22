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
        this.uPnPPlayer.setCapabilityValue('speaker_playing', v);
        this._playing = v;
    }
    get playing() { 
        return this._playing;
        return this.uPnPPlayer.getCapabilityValue('speaker_playing');        
    }

    set albumUrl(v) {
        //console.log('albumUrl:' + v);
        if(this.image) {
            //console.log('setStream');
            if(v) this.image.setStream(async (stream) => {
                const res = await fetch(v);
                //console.log('setStream fetching: ' + res.ok);
                if (!res.ok) {
                  throw new Error('Invalid Response');
                }
              
                return res.body.pipe(stream);
              });
            else this.image.setUrl(null);
            //this.image.setUrl(v);
            this.image.update().catch((err)=>{
                console.log('catch err');
                console.log(err);
            });
        }
        //return this.uPnPPlayer.setCapabilityValue('speaker_album', v);        
    }
    set album(v) {         
        this.uPnPPlayer.setCapabilityValue('speaker_album', v || '');        
    }
    set artist(v) { 
        return this.uPnPPlayer.setCapabilityValue('speaker_artist', v || '');        
    }
    set track(v) { 
        return this.uPnPPlayer.setCapabilityValue('speaker_track', v || '');        
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
        if(!this.image) {
            this.homey.images.createImage().then(image=> {
                this.image = image;
                image.setUrl(null);
                uPnPPlayer.setAlbumArtImage(this.image);
            });
        }
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
        if(this.files && this.files.length>0) this.filesIndex[this.files[0].id] = { index : 0, played : false, file:this.files[0] };
        return this.PlayNext({mode:'single', message:message});
    }

    async PlayFolder({folder, mode}={}) {
        this.folder = folder ? await this.uPnPPlayer.server.getFromLocation({item:folder, search:'folders'}) : null;
        this.files = folder ? await this.uPnPPlayer.server.browseById({id:folder.id, search:'files'}) : null;
        this.filesIndex = {};
        this.playingIndex = -1;
        if(this.files) this.files.forEach((f, index)=>this.filesIndex[f.id] = { index : index, played : false, file:f } );
        this.mode = mode;
        return this.PlayNext();
    }
    PlayNext({mode, message}={}) {        
        this.ClearTimer();
        this.ClearFinishedTimer();
        this.finishedMessage = message;
        if(!this.files || this.files.length==0 || !this.files[0]) return this.Stop();
        mode = mode || this.mode;
        switch (mode) {
            case 'single':
                this.playingIndex=0;
                this.currentFile = this.files[0];
                break;
            case 'randomsingle':
                this.currentFile = this.files.random();
                this.playingIndex=this.files.indexOf(this.currentFile);                
                break;
            case 'normal':
                this.playingIndex++;
                if(this.files.length>this.playingIndex) this.currentFile = this.files[this.playingIndex];
                else return this.Stop();
                break;
            case 'randomnormal':
                var files = _.filter(this.files, f=> !this.filesIndex[f.id].played);
                this.currentFile = files.random();
                this.playingIndex=this.files.indexOf(this.currentFile);
                break;
                case 'repeat':
                this.playingIndex++;
                if(!(this.files.length>this.playingIndex)) this.playingIndex=0;
                this.currentFile = this.files[this.playingIndex];
                break;
            case 'randomrepeat':
                var files = _.filter(this.files, f=> !this.filesIndex[f.id].played);
                if(files.length==0) {
                    this.files.forEach(f=>f.played=false);
                    files = this.files;
                }
                this.currentFile = files.random();
                this.playingIndex=this.files.indexOf(this.currentFile);
                break;
            default:
                break;
        }
        console.log('PlayNext mode('+mode+'): ' + this.currentFile);
        return this.Play(mode);
    }
    Play(mode) {
        mode = mode || this.mode;
        this.mode = mode;
        this.filesIndex[this.currentFile.id].played = true;
        this.playing = !!( this.uPnPPlayer.driver.Triggers.url_trigger.Card.trigger(this.uPnPPlayer, {url:this.currentFile.url, duration:this.currentFile.duration} ));
        this.album = this.currentFile.album;
        this.artist = this.currentFile.artist;
        this.albumUrl = this.currentFile.albumUrl;
        this.track = this.currentFile.name;
        if(['single', 'randomsingle'].indexOf(mode)>-1) this.SetFinishedTimer();
        if(['normal', 'repeat','randomnormal', 'randomrepeat'].indexOf(mode)>-1) this.SetTimer();
        switch (mode) {
            case 'single':                
            case 'randomsingle':
                this.uPnPPlayer.setCapabilityValue('speaker_repeat', 'none');
                break;
            case 'normal':                
            case 'randomnormal':                
                this.uPnPPlayer.setCapabilityValue('speaker_repeat', 'none');
            break;
            case 'repeat':                
            case 'randomrepeat':  
            this.uPnPPlayer.setCapabilityValue('speaker_repeat', 'playlist');
                break;
        }
        this.uPnPPlayer.setCapabilityValue('speaker_shuffle', mode.indexOf('random')>-1);
        return this.playing;
    }

    Stop() {
        this.ClearTimer();
        this.ClearFinishedTimer();
        this.uPnPPlayer.driver.Triggers.stopped_trigger.Card.trigger(this.uPnPPlayer);
        this.playing = false;
        return true;
    }
    
    TogglePlay(val) {
        if(val) return this.Play();
        else return this.Stop();
    }

    SetShuffle(val) {
        switch (this.mode) {
            case 'single':
            case 'randomsingle':
                this.mode = val ? 'randomsingle' : 'single';
                break;
            case 'normal':
            case 'randomnormal':
                this.mode = val ? 'randomnormal' : 'normal';
                break;
            case 'repeat':
            case 'randomrepeat':   
                this.mode = val ? 'randomrepeat' : 'repeat';
                break;
        }
    }
    
    SetRepeat(val) {
        switch (val) {
            case 'none':
                this.mode = (this.mode.indexOf('random')>-1 ? 'random' : '') +  (this.mode.indexOf('single')>-1 ? 'single' : 'normal');
                break;
            case 'track':
                this.mode = (this.mode.indexOf('random')>-1 ? 'random' : '') + 'single';//(this.mode.indexOf('single')>-1 ? 'single' : '');                
                break;
            case 'playlist':
                this.mode = (this.mode.indexOf('random')>-1 ? 'random' : '') + (this.mode.indexOf('normal')>-1 ? 'normal' : '');                
                break;
        }
        //console.log('SetRepeat(' + val + ')');
    }


    SetTimer() {
        this.ClearTimer();
        if(!this.currentFile) return;   
        var delay = this.uPnPPlayer.getSetting('delay');
        console.log('this.currentFile.duration');
        console.log(this.currentFile.duration);
        this.timer = setTimeout((()=> {
            this.PlayNext();
        }).bind(this), this.currentFile.duration + (delay || 1000));
    }
    ClearTimer() {
        if(this.timer) clearTimeout(this.timer);
    }

    SetFinishedTimer() {
        var defer = new Defer();
        this.ClearFinishedTimer();
        if(!this.currentFile) return Promise.reject();   
        var delay = this.uPnPPlayer.getSetting('delay');
        this.finishedTimer = setTimeout((()=> {            
            this.playing = false;
            defer.resolve(!!this.uPnPPlayer.driver.Triggers.finished_trigger.Card.trigger(this.uPnPPlayer, {hasMessage :!!this.finishedMessage, message:this.finishedMessage || 'No message'}));
        }).bind(this), this.currentFile.duration + (delay || 1000));
        return defer.promise;
    }
    
  ClearFinishedTimer() {    
    if(this.finishedTimer) clearTimeout(this.finishedTimer);
  }
}

module.exports = PlaylistManager;