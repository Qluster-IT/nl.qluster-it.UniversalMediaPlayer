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
        ids.forEach(((id, i)=> {
            this._browse(idParents[i]).then(list=>{
                if(!list) return;
                var data = _.find(list, x=>x.id==id);
                if(data)locations[i] = data.realName;
            });
        }).bind(this));
        
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
        
        var params = {
        'url': `http://${this._ip}/ContentDirectory/control`,
        'soap': soap
        };

        //MediaServer/ContentDirectory/Control

        upnp.invokeAction(params, (err, obj, xml, res) => {
            if(err) {
                console.log('[ERROR]');
                console.log(err);
                console.log(obj);
                //console.dir(params);
                return defer.resolve();
            } else {
                if(res['statusCode'] === 200) {
                    console.log('[SUCCESS]');
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
                                //console.log(obj.container);
                                if(ids) {
                                    var backIds = ids.substr(0, ids.lastIndexOf(';')); 
                                    if(backIds=='')backIds = 0;
                                    returnList.push({id:'Back', name:'Up/back:[' + backIds + ']'});
                                }
                                if(obj["container"] && obj["container"].length>0) obj["container"].forEach(o=> {
                                    returnList.push({id:o.$.id, name:o["dc:title"] + ':[' + (ids && ids!='0' ? ids+';':'') + `${o.$.id}]` , realName:o["dc:title"]});
                                });
                                if(obj["item"] && obj["item"].length>0) obj["item"].forEach(o=> {
                                    returnList.push({id:o.$.id, name: o["dc:title"], description:locations.join('/') + o["dc:title"] + `:${o.$.id}`, url : o["res"]._ , location:locations.join('[/]') +'[/]'+o["dc:title"] });
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

}

module.exports = UPnPServer;