'use strict';

const Homey = require('homey');
const _ = require('lodash-core');

const { Defer} = require('./lib/proto');

const UPnPPlayerDriver = require('./drivers/upnpplayer/driver');

class UPnPPlayerApp extends Homey.App {
	

    

	onInit() {
		this.log('UPnPPlayerApp is running...');        

        //UPnPPlayerDriver.init();






        //#endregion

	}

}

module.exports = UPnPPlayerApp;