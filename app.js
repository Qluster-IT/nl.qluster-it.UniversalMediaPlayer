'use strict';

const Homey = require('homey');
const _ = require('lodash-core');

const { Defer} = require('./lib/proto');

const UPnPPlayerDriver = require('./drivers/upnpplayer/driver');

class UPnPPlayerApp extends Homey.App {
	

    

	onInit() {
		this.log('UPnPPlayerApp is running...');        

        //UPnPPlayerDriver.init();

		const upnpplayer_get_fileAction = this.homey.flow.getActionCard('upnpplayer_get_file');
        upnpplayer_get_fileAction.registerRunListener(( async( args, state ) => {
            this.log('upnpplayer_get_file.registerRunListener(args, state)');
            this.log(args);
            try {
                if(!args.file || !args.device || !args.file.location) return false;
                return await args.device.playlistManager.PlayFile(args.file);
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
                return await args.device.playlistManager.PlayFolder(args.folder, args.mode);
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
        





        //#endregion

	}

}

module.exports = UPnPPlayerApp;