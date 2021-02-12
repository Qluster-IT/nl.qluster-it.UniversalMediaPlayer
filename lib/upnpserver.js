// Original Code from https://github.com/dalhundal/sky-q


const upnp = require('node-upnp-utils');
const xml2js = require('xml2js');
const { Defer } = require('./proto');
const _ = require('lodash-core');

//const  http  = require('http.min');

class UPnPServer {

    static box(ip) {
        return new this({ip})
    }

    constructor({ip}) {
        this._ip = ip
    }
    async getUrl(file) {
        
    }

    async browse(query) {
        var id='0';
        if(query){
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
            var list = await this._browse(idParents[i]);
            if(list){
                var data = _.find(list, x=>x.id==element);
                if(data)locations[i] = data.realName;
            }
        }        
        return this._browse(id, ids.join(';'), locations);
    }
    async _browse(id, ids, locations) {
        console.log('browsing: ' + id);
        var defer = new Defer(30000);
        

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
        
        var action  = "\""+(await this.getSoapActionFromSoapBody(soap)) + "\"";

        var params = {
        'url': `http://${this._ip}/ContentDirectory/control`,
        'soap': soap,
        'action' : action
        };

        //MediaServer/ContentDirectory/Control

        upnp.invokeAction(params, (err, obj, xml, res) => {
            if(err) {
                console.log('[ERROR]');
                //console.log(err);
                //console.log(obj);
                //console.dir(params);
                return defer.resolve();
            } else {
                if(res['statusCode'] === 200) {
                    console.log('[SUCCESS]');                    
                    //if(id=='22$12321')console.log(obj);
                } else {
                    console.log('[ERROR]');
                    console.log(obj);
                    return defer.resolve();
                }
                if(obj && obj["s:Body"] && obj["s:Body"]["u:BrowseResponse"] && obj["s:Body"]["u:BrowseResponse"]["Result"] ) {
                    var list = obj["s:Body"]["u:BrowseResponse"]["Result"];
                    if(xml2js) {
                        var opt = {explicitRoot: false, explicitArray:false};
                        xml2js.parseString(list, opt, (err, obj) => {
                            if(err) {
                                defer.resolve();
                            } else {
                                var returnList = [];
                                console.log(obj.item);
                                if(ids) {
                                    var backIds = ids.substr(0, ids.lastIndexOf(';')); 
                                    if(backIds=='')backIds = 0;
                                    returnList.push({id:'Back', name:'Up/back:[' + backIds + ']'});
                                }
                                var container = obj.container;
                                if(container && !container.length) container = [container];
                                if(container && container.length>0) container.forEach(o=> {                                    
                                    var descriptionText = (locations? locations.join('/') + '/' : '') + o["dc:title"];
                                    var r = {id:o.$.id, name:o["dc:title"] + ':[' + (ids && ids!='0' ? ids+';':'') + `${o.$.id}]`, description:descriptionText, realName:o["dc:title"]};
                                    if(o["upnp:albumArtURI"] && o["upnp:albumArtURI"]._) r.image = o["upnp:albumArtURI"]._;
                                    returnList.push(r);
                                });
                                if(obj["item"] && obj["item"].length>0) obj["item"].forEach(o=> {
                                    console.log('o');
                                    console.log(o);
                                    var descriptionText = (locations? locations.join('/') + '/' : '') + o["dc:title"];
                                    var locationText = (locations? locations.join('[/]') +'[/]' : '') + o["dc:title"] ;
                                    var r = {id:o.$.id, name: o["dc:title"], description:descriptionText, url : o["res"]._ , location:locationText};
                                    if(o["upnp:albumArtURI"] && o["upnp:albumArtURI"]._) r.image = o["upnp:albumArtURI"]._;
                                    returnList.push(r);
                                });
                                defer.resolve(returnList);
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