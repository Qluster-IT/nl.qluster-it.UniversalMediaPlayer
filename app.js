'use strict';

const Homey = require('homey');
const _ = require('lodash-core');

const { Defer} = require('./lib/proto');

const UPnPPlayerDriver = require('./drivers/upnpplayer/driver');
const PlaylistManager = require('./lib/playlistmanager');

class UPnPPlayerApp extends Homey.App {
	Triggers ={
        playlistTrigger:{List:[], Card:null},
    };

    async getFile({file, server}){
        var locations = file.location.split('[/]');
        var location = {id:0};
        for (let i = 0; i < locations.length; i++) {
            const locationName = locations[i];
            var loc = await server.find(locationName, location.id);
            if(!loc) return false;
            location = loc;
        }
    }

	onInit() {
		this.log('UPnPPlayerApp is running...');
        
        this.playlistManager = new PlaylistManager({homey:this.homey});

        UPnPPlayerDriver.init();

		const upnpplayer_get_fileAction = this.homey.flow.getActionCard('upnpplayer_get_file');
        upnpplayer_get_fileAction.registerRunListener(( async( args, state ) => {
            this.log('upnpplayer_get_file.registerRunListener(args, state)');
            this.log(args);
            try {
                if(!args.file || !args.device || !args.file.location) return false;
                var file = getFile(args.file, args.device.server);                
                this.Triggers.playlistTrigger.Card.trigger(args.device, {url:location.url} );
                return true;
            } catch (error) { console.log('Error: ' + error); }
            return false;
        }).bind(this))
        .getArgument('file').registerAutocompleteListener((( query, args) => {
            var defer = new Defer();
            try { this.log('upnpplayer_get_file.file.registerAutocompleteListener(query, state)');
                if((!query||query=='') && args && args.file) query=args.file.name || '';
                args.device.server.browse({query:query, search:'folders,files'}).then(list=>defer.resolve(list) );    
            } catch (error) { this.log('upnpplayer_get_file.file.registerAutocompleteListener error: ' + error);
                defer.resolve([]);
            }
          return defer.promise;
        }).bind(this)) ;         
        

        const upnpplayer_get_folderAction = this.homey.flow.getActionCard('upnpplayer_get_folder');
        upnpplayer_get_folderAction.registerRunListener(( async( args, state ) => {
            this.log('upnpplayer_get_folder.registerRunListener(args, state)');
            this.log(args);
            try {
                if(!args.folder || !args.device || !args.folder.location) return false;
                var folder = getFile(args.folder, args.device.server);                
                this.Triggers.playlistTrigger.Card.trigger(args.device, {url:location.url} );
                return true;
            } catch (error) { console.log('Error: ' + error); }
            return false;
        }).bind(this))
        .getArgument('folder').registerAutocompleteListener((( query, args) => {
            var defer = new Defer();
            try { this.log('upnpplayer_get_folder.folder.registerAutocompleteListener(query, state)');
                if((!query||query=='') && args && args.folder) query=args.folder.name || '';
                args.device.server.browse({query:query, search:'folders'}).then(list=>defer.resolve(list) );    
            } catch (error) { this.log('upnpplayer_get_folder.folder.registerAutocompleteListener error: ' + error);
                defer.resolve([]);
            }
          return defer.promise;
        }).bind(this)) ;         
        



        const playlistTrigger = this.homey.flow.getDeviceTriggerCard('playlist_trigger');
        this.Triggers.playlistTrigger.Card = playlistTrigger;
        playlistTrigger
        .on('update', () => {
            //refreshFlowTriggers();
        })
        .registerRunListener(( args, state ) => {  
            console.log('playlistTrigger.registerRunListener (args, state)');         
            console.log(args);
            console.log(state);
            return Promise.resolve( args.id && args.id.id && state.id && state.id.id && args.id.id === state.id.id );        
        })
        


        async function returnPlaylistsForAutoComplete(query, args) {
            console.log('this.playlistManager.playlists');
            console.log(this.playlistManager.playlists);
            return _.map(this.playlistManager.playlists, pl=>{ return { id:pl.name, name:pl.name}; });
        }
        
        //#endregion

	}

}

module.exports = UPnPPlayerApp;