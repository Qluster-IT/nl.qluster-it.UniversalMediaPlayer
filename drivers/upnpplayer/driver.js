'use strict';

const Homey = require('homey');
var upnp = require('node-upnp-utils');
const PlaylistManager = require('../../lib/playlistmanager');
const { Defer } = require('../../lib/proto');

upnp.on('added', (device) =>
{
});

upnp.on('error', (err) => {
    console.log(err);
});

class UPnPPlayerDriver extends Homey.Driver
{
    Triggers ={
        urlTrigger:{List:[], Card:null},
        stoppedTrigger:{List:[], Card:null}
    };
    
    devices = [];
    /**
     * onInit is called when the driver is initialized.
     */
    async onInit()
    {
        
        const urlTrigger = this.homey.flow.getDeviceTriggerCard('url_trigger');
        this.Triggers.urlTrigger.Card = urlTrigger;
        urlTrigger
        .on('update', () => {
            //refreshFlowTriggers();
        })
        .registerRunListener(( args, state ) => {  
            console.log('urlTrigger.registerRunListener (args, state)');         
            console.log(args);
            console.log(state);
            return Promise.resolve( args.id && args.id.id && state.id && state.id.id && args.id.id === state.id.id );        
        });


        const stoppedTrigger = this.homey.flow.getDeviceTriggerCard('stopped_trigger');
        this.Triggers.stoppedTrigger.Card = stoppedTrigger;
        stoppedTrigger
        .on('update', () => {
            //refreshFlowTriggers();
        })
        .registerRunListener(( args, state ) => {
            console.log('stoppedTrigger.registerRunListener (args, state)');         
            console.log(args);
            console.log(state);
            return Promise.resolve( args.id && args.id.id && state.id && state.id.id && args.id.id === state.id.id );        
        })
        
        
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
                                "id": ip
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
        }, 10000);

        return defer.promise;
    }

}

module.exports = UPnPPlayerDriver;