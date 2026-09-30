// Run only AFTER loading card-editing.fixture.jsx in a disposable app frame.
// This refuses a live board and never installs or injects a fixture itself.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const appId = process.argv[2]
assert.match(appId || '', /^\d+$/, 'Usage: node tests/visual/card-editing.check.mjs <app-id>')
const appPath = `/api/apps/${appId}/`
const ws = new WebSocket(execFileSync('agent-browser',['get','cdp-url'],{encoding:'utf8'}).trim());
await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let seq=0;const pending=new Map();const contexts=[];
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}else if(m.method==='Runtime.executionContextCreated')contexts.push(m.params.context)});
const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))});
const {targetInfos}=await call('Target.getTargets');const target=targetInfos.find(t=>t.type==='iframe'&&t.url.includes(appPath));
assert.ok(target, 'Kanban app frame not found')
const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
await call('Runtime.enable',{},sessionId);const tree=await call('Page.getFrameTree',{},sessionId);
const frames=[];function walk(t){frames.push(t.frame);for(const c of t.childFrames||[])walk(c)}walk(tree.frameTree);
const frame=frames.find(f=>f.url.includes(appPath))||frames.find(f=>f.parentId)||frames[0];
const context=contexts.find(c=>c.auxData?.frameId===frame.id&&c.auxData?.isDefault);
const evaluate=async(expression)=>{const r=await call('Runtime.evaluate',{expression,contextId:context.id,awaitPromise:true,returnByValue:true},sessionId);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
let pageSession
for (const page of targetInfos.filter(target => target.type === 'page')) {
  const attached = await call('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  const parentTree = await call('Page.getFrameTree', {}, attached.sessionId)
  if (parentTree.frameTree.frame.id === frame.parentId) {
    pageSession = attached.sessionId
    await call('Target.activateTarget', { targetId: page.targetId })
    break
  }
  await call('Target.detachFromTarget', { sessionId: attached.sessionId })
}
assert.ok(pageSession, 'Owning Kanban page not found')
try {
assert.equal(await evaluate(`typeof window.__cardEditing?.remote`),'function','Refusing to test/edit a live board: load the isolated card fixture first');
await evaluate(`window.__cardEditing.cancelled=0;window.__cardEditing.commits=[];window.__cardEditing.links=[];window.__cardEditing.remote({id:'fixture-reset',title:'Polish Kanban controls and editing',notes:'First line of card notes.\\nSecond line with https://example.com/docs.',label:'blue',assignee:'@memberone',assigneeHost:'me.example'})`);
await new Promise(r=>setTimeout(r,40));
await checkControls({evaluate,call,pageSession});
await checkEditing({evaluate,call,pageSession});
} finally { ws.close() }
async function checkControls({evaluate,call,pageSession}) {
 const pause=()=>new Promise(r=>setTimeout(r,35));
 const parent = await call('Runtime.evaluate',{expression:`(()=>{const r=document.querySelector('iframe[title="Kanban"]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width}})()`,returnByValue:true},pageSession);
 const origin=parent.result.value;
 const scale=origin.width/(await evaluate(`innerWidth`));
 const clickAt=async p=>{for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,x:origin.x+p.x*scale,y:origin.y+p.y*scale,button:'left',clickCount:1},pageSession);await pause()};
 const click=async selector=>{const p=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await clickAt(p)};
 const at=async(label,offset)=>{const p=await evaluate(`(()=>{const n=document.querySelector('[aria-label="${label}"]').firstChild;const r=document.createRange();r.setStart(n,${offset});r.setEnd(n,${offset+1});const b=r.getBoundingClientRect();return {x:b.x+1,y:b.y+b.height/2}})()`);await clickAt(p);return evaluate(`({text:window.getSelection().anchorNode.textContent,offset:window.getSelection().anchorOffset,active:document.activeElement.getAttribute('aria-label')})`)};
 const state=()=>evaluate(`window.__cardEditing`);
 let selection=await at('Card title',7);assert.equal(selection.active,'Card title');assert.ok(Math.abs(selection.offset-7)<=1,JSON.stringify(selection));
 const before=await evaluate(`document.querySelector('[aria-label="Card title"]').innerText`);
 await call('Input.insertText',{text:'X'},pageSession);await pause();
 assert.equal(await evaluate(`document.querySelector('[aria-label="Card title"]').innerText`),before.slice(0,selection.offset)+'X'+before.slice(selection.offset));
 await click('.kb-card-toolbar-done');assert.ok((await state()).current.title.includes('X'));
 console.log('PASS title native click offset + insert + blur save');
 selection=await at('Card notes',6);assert.ok(Math.abs(selection.offset-6)<=1);await call('Input.insertText',{text:'ZZ'},pageSession);await pause();
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},pageSession);await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},pageSession);await pause();await click('.kb-card-toolbar-done');
 assert.equal((await state()).current.notes,'First line of card notes.\nSecond line with https://example.com/docs.');
 console.log('PASS notes click offset + Escape cancellation does not save');
 await at('Card notes',4);const draft=await evaluate(`document.querySelector('[aria-label="Card notes"]').innerText`);await evaluate(`window.__cardEditing.remote({notes:'Remote text received'})`);await pause();assert.equal(await evaluate(`document.querySelector('[aria-label="Card notes"]').innerText`),draft);await click('.kb-card-toolbar-done');assert.equal(await evaluate(`document.querySelector('[aria-label="Card notes"]').innerText`),'Remote text received');
 console.log('PASS focused caret/draft survives remote updates; untouched blur adopts latest');
 await evaluate(`window.__cardEditing.remote({notes:'First line of card notes.\\nSecond line with https://example.com/docs.'})`);await pause();await click('[aria-label="Card notes"] a');assert.equal((await state()).links[0][0],'https://example.com/docs');
 console.log('PASS notes links still open');
 await click('.kb-label-trigger');await click('[aria-label="No label"]');assert.equal((await state()).current.label,'none');const empty=await evaluate(`({slash:getComputedStyle(document.querySelector('.kb-label-trigger'),'::after').content,bg:getComputedStyle(document.querySelector('.kb-label-trigger')).backgroundColor})`);assert.ok(!empty.slash||empty.slash==='none');
 await click('.kb-label-trigger');await click('[aria-label="Label blue"]');await click('.kb-assignee-trigger');await click('[aria-label="Assign card"] .kb-assignee-option[aria-pressed="true"]');
 assert.equal((await state()).current.assignee,'@memberone');console.log('PASS label/assignee interactions and slash-free empty state');
 const rendered=await evaluate(`({photos:[...document.querySelectorAll('.kb-avatar-photo')].every(i=>i.complete&&i.naturalWidth>0),fill:document.querySelector('.kb-assignee-trigger').clientWidth===document.querySelector('.kb-assignee-trigger .kb-assignee-avatar').clientWidth,overflow:document.documentElement.scrollWidth>innerWidth})`);assert.equal(rendered.photos,true);assert.equal(rendered.fill,true);assert.equal(rendered.overflow,false);console.log('PASS loaded person photos, full-circle assignee, no horizontal overflow');
}

async function checkEditing({evaluate,call,pageSession}) {
 const wait=()=>new Promise(r=>setTimeout(r,40));
 await evaluate(`document.querySelector('[aria-label="Card notes"]').focus(); window.getSelection().selectAllChildren(document.activeElement)`);
 await call('Input.insertText',{text:'A multiline note\nSecond line\nThird line'},pageSession);await wait();
 assert.equal(await evaluate(`document.querySelector('[aria-label="Card notes"]').innerText`),'A multiline note\nSecond line\nThird line');
 await evaluate(`document.querySelector('.kb-card-toolbar-done').focus()`);await wait();assert.equal(await evaluate(`window.__cardEditing.current.notes`),'A multiline note\nSecond line\nThird line');
 console.log('PASS multiline notes grow naturally and save line breaks');
 await evaluate(`document.querySelector('[aria-label="Card notes"]').focus();window.getSelection().selectAllChildren(document.activeElement)`);
 await call('Input.insertText',{text:'Temporary replacement'},pageSession);await wait();
 for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',modifiers:2,windowsVirtualKeyCode:90},pageSession);await wait();
 assert.equal(await evaluate(`document.querySelector('[aria-label="Card notes"]').innerText`),'A multiline note\nSecond line\nThird line');console.log('PASS native Undo restores notes while editing');
 await evaluate(`document.querySelector('.kb-card-toolbar-done').focus();document.querySelectorAll('.kb-card-detail button')[0].click()`);await wait();assert.equal(await evaluate(`document.querySelectorAll('[contenteditable]').length`),0);console.log('PASS read-only card has no editable surfaces');
 await evaluate(`document.querySelectorAll('.kb-card-detail button')[0].click();document.querySelectorAll('.kb-card-detail button')[1].click()`);await wait();assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`),'Card title');
 const count=await evaluate(`window.__cardEditing.commits.length`);await evaluate(`document.querySelector('.kb-card-toolbar-done').focus()`);await wait();assert.equal(await evaluate(`window.__cardEditing.commits.length`),count);
 await evaluate(`document.querySelector('[aria-label="Card title"]').focus()`);for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27},pageSession);await wait();assert.equal(await evaluate(`window.__cardEditing.cancelled`),1);console.log('PASS blank draft autofocus, no empty blur save, Escape discard');
 await evaluate(`window.__cardEditing.remote({id:'final',title:'Polish Kanban controls and editing',notes:'First line of card notes.\\nSecond line with https://example.com/docs.',label:'blue',assignee:'@memberone',assigneeHost:'me.example'})`);await wait();await evaluate(`document.querySelector('.kb-card-toolbar-done').focus()`);
}
