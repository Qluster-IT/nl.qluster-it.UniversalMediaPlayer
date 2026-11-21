'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runtime = process.argv[process.argv.indexOf('--playwright-path') + 1];
assert(process.argv.includes('--playwright-path') && runtime, 'Provide the existing playwright-core installation');
const {chromium} = require(runtime);
const root = path.resolve(__dirname, '..');
const locale = require(path.join(root, 'locales', 'en.json'));
const bridge = `
window.addEventListener('load', () => {
    const a = 'dlna:uuid:ui-a', b = 'dlna:uuid:ui-b';
    let destination = a;
    const contexts = {[a]:{name:'Room A', folder:'album-a', track:'Alpha'},[b]:{name:'Room B',folder:'album-b',track:'Beta'}};
    window.commands = [];
    window.listeners = {};
    const state = speaker => {
        const id = speaker || destination, c = contexts[id];
        return {players:[{id:'mock',name:'Test UMP'}],player:{
            id:speaker || 'mock',name:c.name,contextId:'context-' + c.folder,libraryPlayer:'mock',
            canBrowse:true,managed:Boolean(speaker),locked:false,protocol:'dlna',
            currentTarget:{id:destination,name:contexts[destination].name},defaultTarget:null,
            playing:c.paused !== true,paused:c.paused === true,canPlay:true,canNavigate:true,
            track:c.track,duration:180000,position:3000,volume:.1,muted:false,shuffle:false,repeat:'none',
            selection:{path:[{id:c.folder,name:c.folder}],folder:true,file:{id:c.track,name:c.track}},
            actions:{play:true,pause:true,stop:true,next:true,previous:true,shuffle:true,repeat:true,volume:true,mute:true,seek:false}
        }};
    };
    onHomeyReady({
        getSettings:()=>({layout:window.layout,player:{id:'mock'},library:'toggle',pageSize:50}),
        getWidgetInstanceId:()=> 'ui-widget-one',
        __:key=>key.split('.').reduce((value,part)=>value?.[part],window.locale) || key,
        ready(){},setHeight:async()=>{},on:(event,fn)=>listeners[event]=fn,
        api:async(method,url,body)=>{
            if(url.startsWith('/state')) return state(new URLSearchParams(url.split('?')[1]).get('speaker'));
            if(url==='/browse'){
                const track=body.folder === 'album-a' ? 'Alpha' : 'Beta';
                return {items:track.toLowerCase().includes((body.filter || '').toLowerCase())?
                    Array.from({length:20},(_,i)=>({id:track+i,name:track+i,playable:true,folder:false,offset:0,size:50})):[],next:null};
            }
            if(url==='/playlist'){
                const track=contexts[body.speaker || destination].track;
                return {items:Array.from({length:8},(_,i)=>({id:track+i,name:track+i,number:i+1,current:i===0})),
                    offset:0,total:8,next:null,currentNumber:1,shuffle:false};
            }
            if(url==='/control'){
                commands.push(body);
                if(body.action==='getSourcePreference') return {source:null};
                if(body.action==='saveSourcePreference') return {source:body.source};
                if(body.action==='listSources') return {sources:Object.entries(contexts).map(([id,c])=>({id,name:c.name}))};
                if(body.action==='listTargets') return {targets:Object.entries(contexts).map(([id,c])=>({id,name:c.name}))};
                if(body.action==='listRooms') return {supported:false,rooms:[]};
                if(body.action==='setTarget') destination=body.value;
                if(body.action==='pause') contexts[body.speaker || destination].paused=true;
                if(body.action==='play') contexts[body.speaker || destination].paused=false;
                return state(body.speaker);
            }
            throw new Error('Unexpected widget request '+url);
        }
    });
});`;

(async () => {
    const browser = await chromium.launch({channel: 'msedge', headless: true});
    try {
        for (const layout of ['compact', 'large']) {
            const page = await browser.newPage({viewport: {width: 400, height: 900}, colorScheme: 'light'});
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(({layout, locale}) => { window.layout = layout; window.locale = locale; }, {layout, locale});
            await page.route('http://ump-switching.invalid/**', route => {
                const url = new URL(route.request().url());
                if (url.pathname.startsWith('/assets/')) return route.fulfill({path: path.join(root, ...url.pathname.slice(1).split('/'))});
                return route.fulfill({contentType: 'text/html', body: fs.readFileSync(
                    path.join(root, 'widgets', 'media', 'public', 'index.html'), 'utf8'
                ).replace('</body>', '<script>' + bridge + '</script></body>')});
            });
            await page.goto('http://ump-switching.invalid/widgets/media/');
            await page.waitForFunction(() => angular.element(document.body).scope().vm.player && !angular.element(document.body).scope().vm.restoringSource);
            await page.getByRole('button', {name: 'Library', exact: true}).click();
            const filter = page.locator('#media-library input');
            await filter.fill('Alpha');
            await page.waitForFunction(() => angular.element(document.body).scope().vm.filter === 'Alpha' &&
                !angular.element(document.body).scope().vm.browsing);
            await page.locator('#media-library .library-list').evaluate(list => { list.scrollTop = 80; });
            await page.locator('#speaker-picker').click();
            await page.getByRole('menuitemradio', {name: 'Room B', exact: true}).click();
            await page.waitForFunction(() => angular.element(document.body).scope().vm.player.contextId === 'context-album-b');
            assert.equal(await filter.inputValue(), '');
            await page.locator('#speaker-picker').click();
            await page.getByRole('menuitemradio', {name: 'Room A', exact: true}).click();
            await page.waitForFunction(() => angular.element(document.body).scope().vm.filter === 'Alpha');
            await page.waitForFunction(() => document.querySelector('#media-library .library-list').scrollTop === 80);
            await page.getByRole('button', {name: 'Playlist', exact: true}).click();
            await page.waitForFunction(() => angular.element(document.body).scope().vm.queue.length === 8);
            await page.locator('#speaker-picker').click();
            await page.getByRole('menuitemradio', {name: 'Room B', exact: true}).click();
            await page.waitForFunction(() => angular.element(document.body).scope().vm.player.contextId === 'context-album-b');
            await page.getByRole('button', {name: 'Playlist', exact: true}).click();
            await page.waitForFunction(() => angular.element(document.body).scope().vm.queue.every(item => item.id.startsWith('Beta')) &&
                angular.element(document.body).scope().vm.queue.length === 8);
            await page.locator('#speaker-picker').click();
            await page.getByRole('menuitemradio', {name: 'Room A', exact: true}).click();
            await page.waitForFunction(() => angular.element(document.body).scope().vm.queue.length === 8 &&
                angular.element(document.body).scope().vm.queue.every(item => item.id.startsWith('Alpha')));
            await page.locator('#player').click();
            await page.getByRole('menuitemradio', {name: 'Room A', exact: true}).click();
            await page.waitForFunction(() => angular.element(document.body).scope().vm.speakerId === 'dlna:uuid:ui-a');
            assert(await page.locator('button[aria-controls="media-library"]').isVisible());
            assert(await page.locator('#media-playlist').isVisible());
            const mutations = await page.evaluate(() => commands.filter(c => ['play', 'pause', 'stop', 'seek', 'playFile'].includes(c.action)));
            assert.deepEqual(mutations, []);
            await page.getByRole('button', {name: 'Pause', exact: true}).click();
            await page.waitForFunction(() => commands.some(c => c.action === 'pause'));
            const pause = await page.evaluate(() => commands.find(c => c.action === 'pause'));
            assert.equal(pause.speaker, 'dlna:uuid:ui-a');
            assert.equal(pause.widget, 'ui-widget-one');
            await page.locator('#player').click();
            await page.getByRole('menuitemradio', {name: 'Test UMP', exact: true}).click();
            await page.waitForFunction(() => !angular.element(document.body).scope().vm.speakerId);
            await page.getByRole('button', {name: 'Library', exact: true}).click();
            await page.waitForFunction(() => !angular.element(document.body).scope().vm.browsing);
            assert.equal(await filter.inputValue(), 'Alpha');
            await filter.fill('Alpha1');
            await page.locator('#speaker-picker').click();
            await page.getByRole('menuitemradio', {name: 'Room B', exact: true}).click();
            await page.waitForFunction(() => angular.element(document.body).scope().vm.player.contextId === 'context-album-b');
            await page.locator('#speaker-picker').click();
            await page.getByRole('menuitemradio', {name: 'Room A', exact: true}).click();
            await page.waitForFunction(() => angular.element(document.body).scope().vm.filter === 'Alpha1');
            assert.equal(await filter.inputValue(), 'Alpha1');
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({layout, sourceOwnerControls: true, independentLibraryHistory: true,
                scrollRestored: true, independentQueues: true, selectionHasNoTransportWrites: true}));
            await page.close();
        }
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
