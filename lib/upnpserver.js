// Original Code from https://github.com/dalhundal/sky-q


const xml2js = require('xml2js');
const { Defer } = require('./proto');

const fetch = require('node-fetch');
//const  http  = require('http.min');

const contentDirectory = 'urn:schemas-upnp-org:service:ContentDirectory:1';

class UPnPServer {

    constructor({homey, ip}) {
        this.homey = homey;
        this._ip = ip;
        // if (useUrl==='localssl') url = `https://${this.homey.app.ip.replaceAll('.', '-')}.homey.homeylocal.com/` + url;
        // else if  (useUrl==='cloudssl') url = `https://${this.homey.app.cloudId}.connect.athom.com/` + url;
        this.cloudUrlPromise = this.homey.cloud.getHomeyId().then(x => {
            this.cloudUrl = `https://${x}.connect.athom.com/api/image/`;
        }).catch(error => {
            this.cloudUrlError = error;
            this.homey.app.error('Unable to resolve the Homey cloud image URL:', error);
        });

        //this.getImage();
    }
    async getUrl(file) {
        
    }

    
    async getImage(url) {
        let myImage;
        try {            
            myImage = await this.homey.images.createImage();

            myImage.setStream(async stream => {
                const res = await fetch(url, { timeout: 10000 });
                if (!res.ok) {
                    throw new Error(`Image request failed with status ${res.status}`);
                }
                return res.body.pipe(stream);
            });
            await myImage.update();
            setTimeout(() => {
                Promise.resolve().then(() => myImage.unregister()).catch(error => {
                    this.homey.app.error('Unable to unregister UPnP album art:', error);
                });
            }, 15000);
            return myImage;
            
        } catch (error) {
            if (myImage) {
                try {
                    await myImage.unregister();
                } catch (unregisterError) {
                    this.homey.app.error('Unable to unregister UPnP album art:', unregisterError);
                }
            }
            this.homey.app.error('Unable to load UPnP album art:', error);
            return undefined;
        }
    }

    async getFromLocation({item, search}){
        if (!item || typeof item.location !== 'string' || item.location.length === 0) return null;
        var locations = item.location.split('[/]');
        var location = {id:0};
        const folders = [];
        for (let i = 0; i < locations.length; i++) {
            var searchFile = (i === locations.length - 1 && search === 'file');
            const locationName = locations[i];
            // console.log('locationName');
            // console.log(locationName);
            // console.log(location);
            var loc = await this.find(locationName, location.id, searchFile ? 'files' : 'folders, files');
            //if(loc) location.parent = loc;
            if (!loc) return null;
            if (!searchFile) folders.push({id: String(loc.id), name: loc.realName || loc.name});
            location = loc;
        }
        return location.id!=0 ? {...location, libraryPath: folders} : null;
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
                var data = list.find(x => x.id == element);
                if(data)locations[i] = data.realName;
            }
        }
        //var a = this.browseById({id: id, ids: ids.join(';'), locations:locations, search:search});
        return this.browseById({id: id, ids: ids.join(';'), locations:locations, search:search});
    }

    async find(locationName, id, search) {
        
        console.log('find "' + locationName + '" in ' + id);
        //console.log(locationName);
        id=id || '0';        
        var list = await this.browseById({id:id, search:search});
        if(list){
            //console.log('list');
            //console.log(list);
            var data = list.find(x => (x.realName || x.name) == locationName);
            //console.log('data');
            //console.log(data);
           // if(data && search && search.indexOf('files')>-1) return await this.browseById({id:data.id, search:  );
            return data;
        }        
    }

    async requestBrowse({url, soap, action}) {
        const response = await fetch(url, {
            method: 'POST', redirect: 'error', timeout: 10000, size: 8 * 1024 * 1024,
            headers: {'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: action},
            body: soap
        });
        if (!response.ok) {
            response.body?.destroy();
            return {status: response.status};
        }
        const result = await xml2js.parseStringPromise(await response.text(), {
            explicitArray: false, tagNameProcessors: [xml2js.processors.stripPrefix]
        });
        return {status: response.status, browse: result?.Envelope?.Body?.BrowseResponse};
    }

    async browseById({id, ids, locations, search, socketHangUp, page}) {
        console.log('browsing: ' + id);
        console.log('search for ' + search);
        var soap = '';
            soap += '<?xml version="1.0" encoding="utf-8"?>';
            soap += '<s:Envelope';
            soap += '  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"';
            soap += '  xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">';
            soap += '  <s:Body>';
            soap += `    <u:Browse xmlns:u="${contentDirectory}">`;
            soap += `      <ObjectID>${escapeXml(id)}</ObjectID>`;
            soap += '      <BrowseFlag>BrowseDirectChildren</BrowseFlag>'; //BrowseMetadata, BrowseDirectChildren
            soap += '      <Filter>*</Filter>';
            soap += `      <StartingIndex>${page ? page.offset : 0}</StartingIndex>`;
            soap += `      <RequestedCount>${page ? page.size : 100000}</RequestedCount>`;
            soap += '      <SortCriteria></SortCriteria>';
            soap += '    </u:Browse>';
            soap += '  </s:Body>';
            soap += '</s:Envelope>';
        
        // Keep the action quoted for strict UPnP servers, including Synology.
        const action = `"${contentDirectory}#Browse"`;
        const browseError = this.homey.__('browse.browseError');
        const fail = cause => defer.reject(new Error(browseError, { cause }));
        var defer = new Defer(30000, browseError);

        var params = {
        'url': `http://${this._ip}/ContentDirectory/control`,
        'soap': soap,
        'action' : action
        };


        this.requestBrowse(params).then(({status, browse: response}) => {
                if(status === 200) {
                    console.log('[SUCCESS]');
                    //console.log(obj);
                } else {
                    return status
                        ? defer.reject(new Error(this.homey.__('browse.browseStatus', { status: String(status) })))
                        : fail(new Error('Missing UPnP HTTP status'));
                }
                if(typeof response?.Result === 'string' && response.Result) {
                    var list = response.Result;
                    if(xml2js) {
                        var opt = {explicitRoot: false, explicitArray:false};
                        xml2js.parseString(list, opt, (err, obj) => {
                            //console.log('obj');
                            //console.log(obj);
                            // console.log(err);
                            if(err) {
                                fail(err);
                            } else try {
                                obj = obj || {};
                                var returnList = [];
                                var imageTasks = [];
                                const artworkByUrl = new Map();
                                const pathPrefix = locations ? `${locations.join('/')}/` : '';
                                const locationPrefix = locations ? `${locations.join('[/]')}[/]` : '';
                                if(ids) {
                                    var backIds = ids.substr(0, ids.lastIndexOf(';')); 
                                    if(backIds=='')backIds = 0;
                                    returnList.push({
                                        id: 'Back',
                                        name: `${this.homey.__('browse.back')} :[${backIds}]`,
                                        description: this.homey.__('browse.parent')
                                    });
                                }
                                if(search && search.indexOf('folders')>-1) {
                                    
                                    if(search.indexOf('files')==-1 && locations && obj.item)  {                                        
                                        returnList.push({id:id, name: locations[locations.length-1], description:this.homey.__('browse.selectFolder'), location:locations.join('[/]')});
                                    }
                                    var container = obj.container;
                                    if(container && !container.length) container = [container];
                                    //console.log(container);
                                    if(container && container.length>0) container.forEach((o, i)=> {                                    
                                        //console.log(o);
                                        var descriptionText = pathPrefix + o["dc:title"];
                                        var locationText = locationPrefix + o["dc:title"];
                                        var r = {id:o.$.id, name:o["dc:title"] + '  :[' + (ids && ids!='0' ? ids+';':'') + `${o.$.id}]`, description:descriptionText, location:locationText, realName:o["dc:title"]};
                                        if (ids) addImage.call(this, resolveArtUrl(o["upnp:albumArtURI"], this._ip, this.homey.app), i, r);
                                        returnList.push(r);
                                    });
                                }
                                
                                if(search && search.indexOf('files')>-1) {                                    
                                    var item = obj.item;
                                    if(item && !item.length) item = [item];
                                    if(item && item.length>0) item.forEach((o, i)=> {
                                        const resources = Array.isArray(o.res) ? o.res : [o.res];
                                        const resource = resources.find(res => textValue(res));
                                        const protocolInfo = resource?.$?.protocolInfo;
                                        const contentType = typeof protocolInfo === 'string'
                                            ? protocolInfo.split(':')[2] : undefined;
                                        // if(o && o.res && o.res.$) {
                                        //     console.log('item');
                                        //     console.log(JSON.stringify(o));//.res.$);
                                        // }
                                        const durationText = resource && resource.$ && resource.$.duration;
                                        const durationParts = typeof durationText === 'string'
                                            ? /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(durationText)
                                            : null;
                                        const duration = durationParts
                                            ? (Number(durationParts[1]) * 3600 + Number(durationParts[2]) * 60 + Number(durationParts[3])) * 1000
                                            : 0;
                                        var descriptionText = pathPrefix + o["dc:title"];
                                        var locationText = locationPrefix + o["dc:title"];
                                        var r = {
                                            id:o.$.id, 
                                            name: o["dc:title"], 
                                            description:descriptionText, 
                                            url : textValue(resource),
                                            contentType: contentType && /^[\w.+-]+\/[\w.+-]+$/.test(contentType)
                                                ? contentType : undefined,
                                            protocolInfo: typeof protocolInfo === 'string' && protocolInfo.length <= 512
                                                && /^http-get:[^:\s]*:[\w.+-]+\/[\w.+-]+:[^\s]*$/.test(protocolInfo)
                                                ? protocolInfo : undefined,
                                            location:locationText, 
                                            duration:duration,
                                            album:o["upnp:album"],                                            
                                            artist:o["upnp:artist"],                                            
                                            albumUrl:resolveArtUrl(o["upnp:albumArtURI"], this._ip, this.homey.app)
                                        };
                                        if (ids) addImage.call(this, r.albumUrl, i, r);
                                        returnList.push(r);
                                    });
                                }
                                //console.log('returnList');
                                //console.log(returnList);
                                if (page) {
                                    const total = Number(response.TotalMatches);
                                    const next = page.offset + returnList.length;
                                    defer.resolve({
                                        items: returnList,
                                        next: returnList.length && (total > 0 ? next < total : returnList.length >= page.size)
                                            ? next : null
                                    });
                                } else {
                                    runImageTasks(imageTasks)
                                        .then(() => defer.resolve(returnList))
                                        .catch(fail);
                                }

                                function addImage(artUrl, i, r) {
                                    if (!artUrl) return;
                                    r.image = artUrl;
                                    if (page || i >= 100) return;
                                    const existing = artworkByUrl.get(artUrl);
                                    if (existing) {
                                        existing.push(r);
                                        return;
                                    }
                                    const entries = [r];
                                    artworkByUrl.set(artUrl, entries);
                                    imageTasks.push(async () => {
                                        await this.cloudUrlPromise;
                                        if (this.cloudUrlError) return;
                                        const image = await this.getImage(artUrl);
                                        if (image) for (const entry of entries) entry.image = this.cloudUrl + image.id;
                                    });
                                }

                                function runImageTasks(tasks) {
                                    const workerCount = Math.min(8, tasks.length);
                                    return Promise.all(Array.from({ length: workerCount }, async () => {
                                        while (tasks.length > 0) {
                                            await tasks.shift()();
                                        }
                                    }));
                                }
                            } catch (error) {
                                fail(error);
                            }
                        });
                    } else {
                        fail(new Error('UPnP response parser is unavailable'));
                    }

                } else
                return defer.reject(new Error(this.homey.__('browse.invalidBrowse')));
        }).catch(error => {
            if (error.code === 'ECONNRESET' && !socketHangUp) {
                this.browseById({id, ids, locations, search, page, socketHangUp: true})
                    .then(value => defer.resolve(value), error => defer.reject(error));
            } else fail(error);
        });
        return defer.promise;
    }

}

function textValue(value) {
    if (typeof value === 'string') return value;
    return value && typeof value._ === 'string' ? value._ : undefined;
}

function escapeXml(value) {
    const entities = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'};
    return String(value).replace(/[&<>"']/g, char => entities[char]);
}

function resolveArtUrl(value, ip, app) {
    const url = textValue(Array.isArray(value) ? value[0] : value);
    if (!url) return null;
    try {
        return new URL(url, `http://${ip}/`).href;
    } catch (error) {
        app.error('Invalid UPnP album art URL:', error);
        return null;
    }
}

module.exports = UPnPServer;