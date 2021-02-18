// Original Code from https://github.com/dalhundal/sky-q


const upnp = require('node-upnp-utils');
const xml2js = require('xml2js');
const { Defer } = require('./proto');
const _ = require('lodash-core');

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
//const  http  = require('http.min');

class UPnPServer {

    constructor({homey, ip}) {
        this.homey = homey;
        this._ip = ip
        //this.getImage();
    }
    async getUrl(file) {
        
    }

    
    async getImage(url) {
        try {            
            console.log('getImage: ' + url);
            const myImage = await this.homey.images.createImage();

            myImage.setStream((async (stream) => {
                const res = await fetch(url);
                if (!res.ok) return; 
                return res.body.pipe(stream);
            }).bind(this));
            //await myImage.update();
            setTimeout(()=>{
                try{
                    if(myImage!=null) {
                        myImage.unregister();
                        myImage = null;
                    }
                } catch(ex) { }

            }, 15000) ;
            return myImage;
            
        } catch (error) {
            console.log('getImage.error: ' + error);
        }
        
    }

    async getFromLocation({item, search}){
        var locations = item.location.split('[/]');
        var location = {id:0};
        for (let i = 0; i < locations.length; i++) {
            var searchFile = (i==location.length-2 && search=='file');
            const locationName = locations[i];
            var loc = await this.find(locationName, location.id, searchFile ? search : 'folders, files');
            if(!loc) {
                if (!searchFile) return null;
            } else location = loc;
        }
        return location.id!=0 ? location : null;
    }



    async browse({query, search}) {
        var id='0';
        if(query && query.indexOf(':[')>-1){
            id = query.split(':[');
            id=id[id.length-1].split('/')[0];
            id = id.substr(0, id.length-1);
        }
        var ids = id.split(';');
        id = ids[ids.length-1];
        var locations = [];
        var idParents = [0];
        ids.forEach(id=>{ idParents.push(id);locations.push('');  });
        var i = 0;
        for (let i = 0; i < ids.length; i++) {
            const element = ids[i];
            var list = await this.browseById({id:idParents[i], search:search});
            if(list){
                var data = _.find(list, x=>x.id==element);
                if(data)locations[i] = data.realName;
            }
        }        
        return this.browseById({id: id, ids: ids.join(';'), locations:locations, search:search});
    }

    async find(locationName, id, search) {
        
        console.log('find "' + locationName + '" in ' + id);
        console.log(locationName);
        id=id || '0';        
        var list = await this.browseById({id:id, search:search});
        if(list){
            console.log('list');
            console.log(list);
            var data = _.find(list, x=>(x.realName || x.name)==locationName);
            console.log('data');
            console.log(data);
           // if(data && search && search.indexOf('files')>-1) return await this.browseById({id:data.id, search:  );
            return data;
        }        
    }

    async browseById({id, ids, locations, search}) {
        console.log('browsing: ' + id);
        console.log('search for ' + search);
        var defer = new Defer(30000);
        var homeyID;


        var soap = '';
            soap += '<?xml version="1.0" encoding="utf-8"?>';
            soap += '<s:Envelope';
            soap += '  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"';
            soap += '  xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">';
            soap += '  <s:Body>';
            soap += '    <u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">';
            soap += `      <ObjectID>${id}</ObjectID>`;
            soap += '      <BrowseFlag>BrowseDirectChildren</BrowseFlag>'; //BrowseMetadata, BrowseDirectChildren
            soap += '      <Filter>*</Filter>';
            soap += '      <StartingIndex>0</StartingIndex>';
            soap += '      <RequestedCount>100000</RequestedCount>';
            soap += '      <SortCriteria></SortCriteria>';
            soap += '    </u:Browse>';
            soap += '  </s:Body>';
            soap += '</s:Envelope>';
        
        var action  = "\""+(await this.getSoapActionFromSoapBody(soap)) + "\""; //fix for the node-upnp-utils that causes Synology's and other that are very specific to not function

        var params = {
        'url': `http://${this._ip}/ContentDirectory/control`,
        'soap': soap,
        'action' : action
        };


        upnp.invokeAction(params, (err, obj, xml, res) => {
            if(err) {
                console.log('[ERROR]');
                return defer.resolve();
            } else {
                if(res['statusCode'] === 200) {
                    console.log('[SUCCESS]');
                    // console.log(obj);
                } else {
                    console.log('[ERROR]');
                    //console.log(obj);
                    return defer.resolve();
                }
                if(obj && obj["s:Body"] && obj["s:Body"]["u:BrowseResponse"] && obj["s:Body"]["u:BrowseResponse"]["Result"] ) {
                    var list = obj["s:Body"]["u:BrowseResponse"]["Result"];
                    if(xml2js) {
                        var opt = {explicitRoot: false, explicitArray:false};
                        xml2js.parseString(list, opt, (err, obj) => {
                            // console.log('obj');
                            // console.log(obj);
                            // console.log(err);
                            if(err) {
                                defer.resolve();
                            } else {
                                var returnList = [];
                                var promises = [];
                                if(ids) {
                                    var backIds = ids.substr(0, ids.lastIndexOf(';')); 
                                    if(backIds=='')backIds = 0;
                                    returnList.push({id:'Back', name:'Up/back:[' + backIds + ']'});
                                }
                                if(search && search.indexOf('folders')>-1) {
                                    
                                    if(search.indexOf('files')==-1 && locations && obj.item)  {                                        
                                        returnList.push({id:id, name: locations[locations.length-1] , description:'Play this folder', location :locations.join('[/]') });
                                    }
                                    var container = obj.container;
                                    if(container && !container.length) container = [container];
                                    if(container && container.length>0) container.forEach((o, i)=> {                                    
                                        //console.log(o);
                                        var descriptionText = (locations? locations.join('/') + '/' : '') + o["dc:title"];
                                        var locationText = (locations? locations.join('[/]') +'[/]' : '') + o["dc:title"] ;
                                        var r = {id:o.$.id, name:o["dc:title"] + '  :[' + (ids && ids!='0' ? ids+';':'') + `${o.$.id}]`, description:descriptionText, location:locationText, realName:o["dc:title"]};
                                        addImage.call(this, o,i, r);
                                        returnList.push(r);
                                    });
                                }
                                
                                if(search && search.indexOf('files')>-1) {                                    
                                    var item = obj.item;
                                    if(item && !item.length) item = [item];
                                    if(item && item.length>0) item.forEach((o, i)=> {
                                        var duration = 0;
                                        try {
                                            var d = o.res['$'].duration.split(':');
                                            duration = Number.parseInt((Number.parseInt(d[0]) * 60 * 60) + (Number.parseInt(d[1]) * 60) + Number.parseFloat(d[2])*1000);
                                        } catch (error) {
                                            
                                        }
                                        var descriptionText = (locations? locations.join('/') + '/' : '') + o["dc:title"];
                                        var locationText = (locations? locations.join('[/]') +'[/]' : '') + o["dc:title"] ;
                                        var r = {id:o.$.id, name: o["dc:title"], description:descriptionText, url : o["res"]._ , location:locationText, duration:duration};
                                        addImage.call(this, o,i, r);
                                        returnList.push(r);
                                    });
                                }
                                // console.log('returnList');
                                // console.log(returnList);
                                Promise.all(promises).then(()=>{
                                    defer.resolve(returnList);
                                });

                                function addImage(o, i, r) {
                                    if(o["upnp:albumArtURI"] && o["upnp:albumArtURI"]._ && ids && i<100) {
                                        var promise = this.getImage(o["upnp:albumArtURI"]._).then(image=>{
                                            r.image = image.cloudUrl;
                                        });
                                        promises.push(promise);
                                    } else r.image = '_';
                                }
                            }
                        });
                    } else {
                        defer.resolve();
                    }

                } else 
                return defer.resolve();
            }
        });
        return defer.promise;
    }

    async getSoapActionFromSoapBody(soap) {
        var defer = new Defer();
        upnp._getSoapActionFromSoapBody(soap, (soap_action) => {
            defer.resolve(soap_action);
        });
        return defer.promise;
    }

}

module.exports = UPnPServer;