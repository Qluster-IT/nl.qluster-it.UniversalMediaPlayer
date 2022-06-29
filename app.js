'use strict';

const Homey = require('homey');
const _ = require('lodash-core');

const { Defer} = require('./lib/proto');

const UPnPPlayerDriver = require('./drivers/upnpplayer/driver');

class UPnPPlayerApp extends Homey.App {
	

    

	onInit() {
		this.log('UPnPPlayerApp is running...');        
		try {
			if (process.env.DEBUG === '1') require('inspector').open(9222, '0.0.0.0', false);
		  } catch (error) {
			
		  }
        //UPnPPlayerDriver.init();






        //#endregion

	}

}

module.exports = UPnPPlayerApp;