const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const root=__dirname+'/';
const read=(name)=>fs.readFileSync(root+name,'utf8');
const window={SONGLIST_CONFIG:{},location:{hash:'',search:''},matchMedia:()=>({matches:false}),confirm:()=>true,localStorage:{length:0,getItem:()=>null,setItem(){},removeItem(){},key:()=>null}};
const nodes={
  '#delete-account-error':{textContent:'',classList:{add(){},remove(){}}},
  '#delete-account-button':{disabled:false,textContent:'アカウントを削除'},
  '#account-settings-dialog':{closed:false,close(){this.closed=true;}}
};
const context=vm.createContext({window,document:{querySelector:(selector)=>nodes[selector]||null},crypto:webcrypto,structuredClone,URLSearchParams,console,setTimeout,clearTimeout});
vm.runInContext(read('songlist-core.js'),context);vm.runInContext(read('songlist-practice.js'),context);
const source=read('app.js').replace('  start();\n})();',`  window.debugApi={deleteAccount, setup:(client,store)=>{user={id:'account-a'};supabase=client;drafts=store;songs=[{id:'song-a'}];baseSongs=[{id:'song-a'}];loadState='ready';saving=false;dirty=false;pendingDrafts=[];conflictState=null;shareRecord=null;updateAccessUi=()=>{};announce=(message)=>window.messages.push(message);}, switchAccount:()=>{user={id:'account-b'};songs=[{id:'song-b'}];}, state:()=>({user,songs,baseSongs})};\n})();`);
assert.notEqual(source,read('app.js'));vm.runInContext(source,context);
const api=window.debugApi, checks=[];
async function check(name,run){try{await run();checks.push([name,true]);}catch(error){checks.push([name,false,error.message]);}}
function reset(){window.messages=[];nodes['#delete-account-error'].textContent='';nodes['#delete-account-button'].disabled=false;nodes['#delete-account-button'].textContent='アカウントを削除';nodes['#account-settings-dialog'].closed=false;}
(async()=>{
  await check('Network failure leaves account intact and allows retry',async()=>{
    reset();let signouts=0;
    api.setup({functions:{invoke:async()=>{throw new Error('network failure');}},auth:{signOut:async()=>{signouts++;}}},{list:()=>[],remove(){}});
    await api.deleteAccount();
    assert.equal(nodes['#delete-account-button'].disabled,false);assert.match(nodes['#delete-account-error'].textContent,/削除を確認できません/);
    assert.equal(api.state().user.id,'account-a');assert.equal(signouts,0);
  });
  await check('Successful deletion completes even if local draft storage fails',async()=>{
    reset();let signouts=0;
    api.setup({functions:{invoke:async()=>({error:null})},auth:{signOut:async()=>{signouts++;}}},{list:()=>{throw new Error('storage blocked');},remove(){}});
    await api.deleteAccount();
    assert.equal(api.state().user,null);assert.equal(api.state().songs.length,0);assert.equal(api.state().baseSongs.length,0);
    assert.equal(signouts,1);assert.equal(nodes['#account-settings-dialog'].closed,true);assert.ok(window.messages.length);
  });
  await check('Deleting an old account does not sign out a newly switched account',async()=>{
    reset();let finish;let signouts=0;
    api.setup({functions:{invoke:()=>new Promise(resolve=>{finish=resolve;})},auth:{signOut:async()=>{signouts++;}}},{list:()=>[],remove(){}});
    const deleting=api.deleteAccount();api.switchAccount();finish({error:null});await deleting;
    assert.equal(api.state().user.id,'account-b');assert.equal(api.state().songs[0].id,'song-b');assert.equal(signouts,0);
  });
  for(const [name,passed,error] of checks) console.log(`${passed?'PASS':'FAIL'} ${name}${error?': '+error:''}`);
  if(checks.some(([,passed])=>!passed))process.exitCode=1;
})().catch((error)=>{console.error(error);process.exitCode=1;});
