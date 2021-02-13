'use strict';

const Homey = require('homey');
const _ = require('lodash-core');

const { Defer} = require('./lib/proto');

const UPnPServerDriver = require('./drivers/upnpserverdriver/driver');

class UPnPServerApp extends Homey.App {
	Triggers ={
        playlistTrigger:{List:[], Card:null},
    };
	onInit() {
		this.log('UPnPServerApp is running...');


		const upnpserver_get_fileAction = this.homey.flow.getActionCard('upnpserver_get_file');
        upnpserver_get_fileAction
        .on('update', ((a) => { 
            // upnpserver_get_fileAction.getArgumentValues()
            // .then(args => {
            //     console.log('upnpserver_get_fileAction.args');
            //         console.log(args);
            
            // });
         }))
        //.on('update', (() => { refreshUPnPServerActions.call(this); }))
        .registerRunListener(( async( args, state ) => {
            this.log('upnpserver_get_file.registerRunListener(args, state)');
            this.log(args);
            try {
                if(!args.file || !args.device || !args.file.location) return false;
                var locations = args.file.location.split('[/]');
                var location = {id:0};
                for (let i = 0; i < locations.length; i++) {
                    const locationName = locations[i];
                    var loc = await args.device.server.find(locationName, location.id);
                    if(!loc) return false;
                    location = loc;
                }
                return true;
            } catch (error) {
                console.log('Error: ' + error);
            }
            return false;
            return args.id && args.id.id && state.id && state.id.id && args.id.id === state.id.id;        
        }).bind(this))
        .getArgument('file')
        .registerAutocompleteListener((( query, args) => {
            var defer = new Defer();
            try {
                this.log('upnpserver_get_file.file.registerAutocompleteListener(query, state)');
                if((!query||query=='') && args && args.file) query=args.file.name || '';
                args.device.server.browse(query, args.file? args.file.location : '').then(list=>defer.resolve(list) );    
            } catch (error) {
                this.log('upnpserver_get_file.file.registerAutocompleteListener error: ' + error);
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
        .getArgument('playlist')
        .registerAutocompleteListener(async ( query, args, a, b, c,  ) => {            
            //     var array = _.map(Homeyman.Current.Triggers.triggerflow.List, flow=> { return Number.parseInt(flow.trigger.args.id.id) });
            //     var max = _.max(array);
            //     if(!max) max=1; else max++;
            //   return Promise.resolve([{id:max.toString(), name:max.toString()}]);
            
        }) ;
        ;
        //refreshFlowTriggers();


        //#endregion

        UPnPServerDriver.init();
	}
    
	

    // async refreshHomeyAPI(id) {
	// 	if(!id) {
    //     	this.homeyAPI =  HomeyAPI.forCurrentHomey(this.homey); // Refresh
    //     	return this.homeyAPI;                
	// 	}
	// 	if(!this.apis) this.apis = {};
	// 	if(!this.apis[id]) this.apis[id] = HomeyAPI.forCurrentHomey(this.homey);
	// 	return this.apis[id];
    // }
	// async clearHomeyAPI(id) {
	// 	if(id && this.apis) delete this.apis[id];
    // }


	
}

module.exports = UPnPServerApp;