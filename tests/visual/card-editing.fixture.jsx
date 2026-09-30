import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {BoardPresence,LabelPicker,AssigneePicker,CardTitleEditor,CardNotesEditor} from './ui/Board.jsx'
import {CSS} from './theme.js'
// Synthetic raster avatar: no account photos or live profile reads.
const photo='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
window.fetch=async()=>new Response('',{status:503})
window.mobius={storage:{get:async()=>null,set:async()=>{throw Error('Live writes blocked')},durableWrite:async()=>{throw Error('Live writes blocked')},subscribe:()=>()=>{}},signal:()=>{}}
const people=[{host:'me.example',handle:'memberone',name:'Member One',host_owner:true,active:true,avatar:photo},{host:'peer.example',handle:'membertwo',active:true,avatar:''}]
window.__cardEditing={commits:[],links:[],cancelled:0}
window.open=(...args)=>{window.__cardEditing.links.push(args)}
function Fixture(){
 const [card,setCard]=useState({id:'fixture',title:'Polish Kanban controls and editing',notes:'First line of card notes.\nSecond line with https://example.com/docs.',label:'blue',assignee:'@memberone',assigneeHost:'me.example'})
 const [readonly,setReadonly]=useState(false)
 const update=patch=>{window.__cardEditing.commits.push(patch);setCard(c=>({...c,...patch}));return true}
 window.__cardEditing.current=card
 window.__cardEditing.remote=patch=>setCard(c=>({...c,...patch}))
 return <div className="kb-root"><style>{CSS}</style>
 <header className="kb-toolbar"><strong>Kanban interaction check</strong><BoardPresence members={people} onOpen={()=>{}} /></header>
 <div className="kb-card-sheet kb-sheet" role="dialog" aria-label="Card details">
 <div className="kb-card-toolbar"><span className="kb-card-toolbar-title">New card</span><LabelPicker label={card.label} canWrite={!readonly} onChange={label=>update({label})}/><AssigneePicker card={card} canWrite={!readonly} members={people} share={{}} iconOnly onUpdate={update}/><button className="kb-btn kb-btn-primary kb-card-toolbar-done" onClick={()=>{}}>Done</button></div>
 <div className="kb-card-detail"><CardTitleEditor card={card} canWrite={!readonly} onCommit={title=>update({title})} onCancel={()=>{window.__cardEditing.cancelled++}}/><CardNotesEditor card={card} canWrite={!readonly} onCommit={notes=>update({notes})}/>
 <button onClick={()=>setReadonly(v=>!v)}>Toggle read-only</button><button onClick={()=>setCard({id:'draft',title:'',notes:'',label:'none',assignee:''})}>Test blank draft</button></div></div></div>
}
document.body.replaceChildren()
const root=document.createElement('div');document.body.append(root);createRoot(root).render(<Fixture/>);
export default Fixture
