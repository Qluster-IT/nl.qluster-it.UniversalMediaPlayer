'use strict';

const Homey = require('homey');
const registerPlayerSetup = require('./player-setup');
var upnp = require('node-upnp-utils');
const PlaylistManager = require('../../lib/playlistmanager');
const { Defer } = require('../../lib/proto');
const {reportVolume} = require('../../lib/speaker-volume');
const {syncPlayback} = require('../../lib/sonos-playback');

const { randomUUID } = require('node:crypto');

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
        paused_trigger:{List:[], Card:null},
        finished_trigger:{List:[], Card:null},
        mute_requested:{Card:null}
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
            {id:'paused_trigger'},
            {id:'finished_trigger'},
            {id:'mute_requested'}
        ];
        for (let i = 0; i < starts.length; i++) {
            const start = starts[i];
            const trigger = this.homey.flow.getDeviceTriggerCard(start.id);
            this.Triggers[start.id].Card = trigger;
            trigger.registerRunListener(() => true);
        }

        this.homey.flow.getActionCard('report_speaker_volume')
            .registerRunListener(args => reportVolume(args.device, args));
        this.homey.flow.getActionCard('sync_sonos_playback')
            .registerRunListener(args => syncPlayback(args.device, args.address));
        const notification = this.homey.flow.getActionCard('upnpplayer_play_notification')
            .registerRunListener(args => args.device.playlistManager.PlayNotification(args.file, args));
        notification.getArgument('file').registerAutocompleteListener((query, args) =>
                args?.device?.server.browse({query: query || args.file?.name || '', search: 'files'}) ?? []);
        notification.getArgument('speaker').registerAutocompleteListener(query =>
            this.homey.app.speakerPlayback.autocomplete(query, false, true));

        starts = [
            {id:'upnpplayer_get_file'},
            {id:'upnpplayer_get_file_message'},
            {id:'upnpplayer_get_file_af', af:true}
        ];
        for (let i = 0; i < starts.length; i++) {
            const start = starts[i];
            const upnpplayer_get_fileAction = this.homey.flow.getActionCard(start.id);
            upnpplayer_get_fileAction.registerRunListener((async args => {
                this.log('upnpplayer_get_file.registerRunListener(args, state)');
                //this.log(args);
                try {
                    if(!args.file || !args.device || !args.file.location) return false;
                    var ret = await args.device.playlistManager.PlayFile({file:args.file, message: args.message, finish: args.finish || false, af:start.af});
                    return ret;
                    //if(start.af) return {url:this.currentFile.url, duration:this.currentFile.duration, name:this.currentFile.name};

                } catch (error) {
                    this.error('Unable to play UPnP file:', error);
                    throw error;
                }
            }).bind(this))
            .getArgument('file').registerAutocompleteListener((async (query, args) => {
                try {
                    this.log('upnpplayer_get_file.file.registerAutocompleteListener(query, state)');
                    if((!query||query=='') && args && args.file) query=args.file.name || '';
                    if (!args || !args.device) return [];
                    return await args.device.server.browse({query:query, search:'folders,files'});
                } catch (error) {
                    this.error('Unable to browse UPnP files:', error);
                    throw error;
                }
            }).bind(this));
        }

        var conditionStarts = [
            {id:'condition_upnpplayer_play_file', triggerAndWait:true}
        ];
        for (let i = 0; i < conditionStarts.length; i++) {
            const condition = conditionStarts[i];
            const conditionCard = this.homey.flow.getConditionCard(condition.id);
            conditionCard.registerRunListener(( async ( args ) => {
                this.log(condition.id + '.registerRunListener(args, state)');
                if (!args.file || !args.device || !args.file.location) return false;
                if (!condition.triggerAndWait) return true;

                try {
                    return Boolean(await args.device.playlistManager.PlayFile({
                        file: args.file,
                        message: args.message,
                        finish: true
                    }));
                } catch (error) {
                    this.error('Unable to play UPnP file:', error);
                    throw error;
                }
            }).bind(this))
            .getArgument('file').registerAutocompleteListener((async (query, args) => {
                try {
                    this.log(condition.id + '.file.registerAutocompleteListener(query, state)');
                    if((!query||query=='') && args && args.file) query=args.file.name || '';
                    if (!args || !args.device) return [];
                    return await args.device.server.browse({query:query, search:'folders,files'});
                } catch (error) {
                    this.error('Unable to browse UPnP files:', error);
                    throw error;
                }
            }).bind(this));
        }




        const upnpplayer_get_folderAction = this.homey.flow.getActionCard('upnpplayer_get_folder');
        upnpplayer_get_folderAction.registerRunListener(( async args => {
            this.log('upnpplayer_get_folder.registerRunListener(args, state)');
            //this.log(args);
            try {
                if(!args.folder || !args.device || !args.folder.location) return false;
                return await args.device.playlistManager.PlayFolder({folder:args.folder,mode: args.mode});
            } catch (error) {
                this.error('Unable to play UPnP folder:', error);
                throw error;
            }
        }).bind(this))
        .getArgument('folder').registerAutocompleteListener((async (query, args) => {
            try {
                this.log('upnpplayer_get_folder.folder.registerAutocompleteListener(query, state)');
                if((!query||query=='') && args && args.folder) query=args.folder.name || '';
                if (!args || !args.device) return [];
                return await args.device.server.browse({query:query, search:'folders'});
            } catch (error) {
                this.error('Unable to browse UPnP folders:', error);
                throw error;
            }
        }).bind(this));




        this.log('UPnPPlayerDriver has been initialized');

        //this.onPairListDevices();



    }

    onPair(session) {
        const decorate = registerPlayerSetup(this, session);
        session.setHandler('list_devices', async () => decorate(await this.onPairListDevices()));
    }

    onRepair(session, device) {
        registerPlayerSetup(this, session, device);
    }

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
                const devices = [];

                for (const device of deviceList) {
                    const ip = device.headers.LOCATION.slice(7).split('/')[0];
                    if (!devices.some(entry => entry.settings.ip === ip)) {
                        const name = device.description.device.friendlyName;
                        devices.push(
                        {
                            "name": 'UPnP ' + name + " (" + ip + ")",
                            data:
                            {
                                "id": randomUUID()
                            },
                            settings:
                            {
                                "ip": ip,
                                "delay" : 1000
                            }
                        });
                    }
                }
                defer.resolve(devices);
            });
        }, 9000);

        return defer.promise;
    }

}

module.exports = UPnPPlayerDriver;