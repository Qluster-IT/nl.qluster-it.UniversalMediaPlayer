'use strict';

const Homey = require('homey');
var upnp = require('node-upnp-utils');
const PlaylistManager = require('../../lib/playlistmanager');
const { Defer } = require('../../lib/proto');

const { v4: uuidv4 } = require('uuid');

upnp.on('added', (device) =>
{
});

upnp.on('error', (err) => {
    console.log(err);
});

class UPnPPlayerDriver extends Homey.Driver
{
    Triggers ={
        url_trigger:{List:[], Card:null},
        stopped_trigger:{List:[], Card:null},
        finished_trigger:{List:[], Card:null}
    };
    
    devices = [];
    /**
     * onInit is called when the driver is initialized.
     */
    async onInit()
    {
		
        var starts = [
            {id:'url_trigger'},
            {id:'stopped_trigger'},
            {id:'finished_trigger'}
        ];
        for (let i = 0; i < starts.length; i++) {
            const start = starts[i];        
            const trigger = this.homey.flow.getDeviceTriggerCard(start.id);
            this.Triggers[start.id].Card = trigger;
            trigger
            //.on('update', () => {})
            .registerRunListener(( args, state ) => {  
                console.log( start.id + '.registerRunListener (args, state)');         
                //console.log(args);
                //console.log(state);
                return Promise.resolve( args.id && args.id.id && state.id && state.id.id && args.id.id === state.id.id );        
            });
        }

        starts = [
            {id:'upnpplayer_get_file'},
            {id:'upnpplayer_get_file_message'}
        ];
        for (let i = 0; i < starts.length; i++) {
            const start = starts[i];            
            const upnpplayer_get_fileAction = this.homey.flow.getActionCard(start.id);
            upnpplayer_get_fileAction.registerRunListener(( async( args, state ) => {
                this.log('upnpplayer_get_file.registerRunListener(args, state)');
                //this.log(args);
                try {
                    if(!args.file || !args.device || !args.file.location) return false;
                    return await args.device.playlistManager.PlayFile({file:args.file, message: args.message});
                } catch (error) { console.log('Error file: ' + error); }
                return false;
            }).bind(this))
            .getArgument('file').registerAutocompleteListener((( query, args) => {
                var defer = new Defer();
                try { 
                    this.log('upnpplayer_get_file.file.registerAutocompleteListener(query, state)');
                    if((!query||query=='') && args && args.file) query=args.file.name || '';
                    args.device.server.browse({query:query, search:'folders,files'}).then(list=>defer.resolve(list) ).catch(err=> {
                        this.log('upnpplayer_get_file.file.registerAutocompleteListener err: ' + err);
                        defer.resolve([]);
                    });    
                    
                } catch (error) { 
                    this.log('upnpplayer_get_file.file.registerAutocompleteListener error: ' + error);
                    defer.resolve([]);
                }
            return defer.promise;
            }).bind(this)) ;      
        }

        var conditionStarts = [
            {id:'condition_upnpplayer_play_file', triggerAndWait:true}
        ];
        for (let i = 0; i < conditionStarts.length; i++) {
            const condition = conditionStarts[i];            
            const conditionCard = this.homey.flow.getConditionCard(condition.id);
            conditionCard.registerRunListener(( ( args, state ) => {
                this.log(condition.id + '.registerRunListener(args, state)');
                //this.log(args);
                try {
                    var defer = new Defer();
                    if(!args.file || !args.device || !args.file.location) return Promise.resolve(false);
                    var deferInternal = new Defer();
                    var promises = [deferInternal.promise];
                    
                    if(condition.triggerAndWait) {
                        args.device.playlistManager.PlayFile({file:args.file, message: args.message}).then((triggered)=> {
                            console.log('PlayFile.then triggered: ' + triggered);
                            if(triggered) {
                                args.device.playlistManager.SetFinishedTimer().then(()=> {
                                    deferInternal.resolve();
                                }).catch(()=> {
                                    deferInternal.reject();
                                });
                            }
                            else {
                                args.device.playlistManager.ClearFinishedTimer();
                                deferInternal.reject();
                            }
                            
                        });
                    } else deferInternal.resolve();
                    
                    var all = Promise.all(promises);                   
                    all.then(()=> {
                      defer.resolve(true);
                    }).catch((err)=> {
                      defer.reject(err);
                    });
                } catch (error) { defer.reject(error); console.log('Error file: ' + error); }
                return defer.promise;
            }).bind(this))
            .getArgument('file').registerAutocompleteListener((( query, args) => {
                var defer = new Defer();
                try { this.log(condition.id + '.file.registerAutocompleteListener(query, state)');
                    if((!query||query=='') && args && args.file) query=args.file.name || '';
                    args.device.server.browse({query:query, search:'folders,files'}).then(list=>defer.resolve(list) );    
                } catch (error) { this.log('upnpplayer_get_file.file.registerAutocompleteListener error: ' + error);
                    defer.resolve([]);
                }
            return defer.promise;
            }).bind(this)) ;      
        }

           
        

        const upnpplayer_get_folderAction = this.homey.flow.getActionCard('upnpplayer_get_folder');
        upnpplayer_get_folderAction.registerRunListener(( async( args, state ) => {
            this.log('upnpplayer_get_folder.registerRunListener(args, state)');
            //this.log(args);
            try {
                if(!args.folder || !args.device || !args.folder.location) return false;
                return await args.device.playlistManager.PlayFolder({folder:args.folder,mode: args.mode});
            } catch (error) { console.log('Error folder: ' + error); }
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
        
        
        
        
        this.log('UPnPPlayerDriver has been initialized');        

        //this.onPairListDevices();

        

    }

    /**
     * onPairListDevices is called when a user is adding a device and the 'list_devices' view is called.
     * This should return an array with the data of devices that are available for pairing.
     */
    async onPairListDevices()
    {
        var defer = new Defer();
        // Start the discovery process
        upnp.startDiscovery(
        //     {
        //     mx:3,
        //     st:'upnp:urn:schemas-upnp-org:service:ContentDirectory:1'
        //   }
          );

        setTimeout(() =>
        {
            upnp.stopDiscovery(() =>
            {
                console.log('Stopped the discovery process.');
                var deviceList = upnp.getActiveDeviceList();
                
                //console.log(deviceList);
                
                deviceList = deviceList.filter(entry => entry && entry.headers
                    && entry.headers['ST'] && entry.headers['ST'].toLowerCase()=='upnp:rootdevice'
                    && entry.description && entry.description.device && entry.description.device.deviceType=='urn:schemas-upnp-org:device:MediaServer:1'
                    && entry.headers['LOCATION'] && entry.headers['LOCATION'].startsWith(`http://${entry.address}:`)
                );
                // deviceList.forEach(d=> {
                //     if(d.address.startsWith('192.168.1.100')) console.log(d);
                // });
                console.log(deviceList.length);
                var devices = [];

                for (var id = 0; id < deviceList.length; id++)
                {
                    // Make sure we don't already have this IP
                    var i = devices.findIndex(element => element.settings.ip.startsWith(deviceList[id].address));
                    if (i < 0)
                    {
                        var ip = deviceList[id].headers['LOCATION'].substr(7).split('/')[0];
                        var name = deviceList[id].description.device.friendlyName;
                        devices.push(
                        {
                            "name": 'UPnP ' + name + " (" + ip + ")",
                            data:
                            {
                                "id": uuidv4()//ip
                            },
                            settings:
                            {
                                "ip": ip,
                                "delay" : 1000
                            }
                        });
                    }
                }
                console.log('defer.resolve(devices);');
                console.log(devices.length);
                defer.resolve(devices);
            });
        }, 13000);

        return defer.promise;
    }

}

module.exports = UPnPPlayerDriver;