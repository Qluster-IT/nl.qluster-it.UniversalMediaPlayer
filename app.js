'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('athom-api');
const _ = require('lodash-core');

const { Defer} = require('./lib/proto');

const UPnPServerDriver = require('./drivers/upnpserver/driver');

class UPnPServerApp extends Homey.App {
	
	onInit() {
		this.log('DeviceSetter is running...');

		let upnpserver_get_fileAction = this.homey.flow.getActionCard('upnpserver_get_file');
        upnpserver_get_fileAction
        .on('update', () => {
            
        })
        .registerRunListener((( args, state ) => {
            this.log('upnpserver_get_file.registerRunListener(args, state)');
            this.log(args);
            if(true) {
                try {
                    
                    //Global.homeyOAuthClient.updateVariable({id:args.variable.id, value: args.file.url});  
                } catch (error) {
                    console.log('Error: ' + error);
                }
                //
            }
            
            return Promise.resolve( args.id && args.id.id && state.id && state.id.id && args.id.id === state.id.id );        
        }).bind(this))
        .getArgument('file')
        .registerAutocompleteListener((( query, args) => {
            var defer = new Defer();
            try {
                this.log('upnpserver_get_file.file.registerAutocompleteListener(query, state)');
                // l(a);
                
                //Master.homeyAPI.logic.updateVariable({id:"52c81742-d42a-405e-8d2e-1f9606b03fc8", variable: {"value":6}})
                args.device.server.browse(query, args.file? args.file.location : '').then(list=>{
                    //l(list);
                    defer.resolve(list);
                });    
            } catch (error) {
                this.log('upnpserver_get_file.file.registerAutocompleteListener error: ' + error);
                defer.resolve([]);
            }
            

          return defer.promise;
        }).bind(this)) ;


        //#endregion

        UPnPServerDriver.init();


	}


	

    async refreshHomeyAPI(id) {
		if(!id) {
        	this.homeyAPI =  HomeyAPI.forCurrentHomey(this.homey); // Refresh
        	return this.homeyAPI;                
		}
		if(!this.apis) this.apis = {};
		if(!this.apis[id]) this.apis[id] = HomeyAPI.forCurrentHomey(this.homey);
		return this.apis[id];
    }
	async clearHomeyAPI(id) {
		if(id && this.apis) delete this.apis[id];
    }


	
}

module.exports = UPnPServerApp;