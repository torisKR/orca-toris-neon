/**
 * Controller contract tests run the actual panel script against a narrow DOM/Orca
 * boundary. They do not claim browser layout, accessibility, or CSS verification.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../panel/studio.mjs',import.meta.url),'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function renderedAction(html,action) {
  const tag=html.match(new RegExp('<button[^>]*data-action="'+action+'"[^>]*>'))?.[0];
  assert.ok(tag,'expected a rendered '+action+' button');
  return Object.fromEntries([...tag.matchAll(/data-([a-z-]+)="([^"]*)"/g)].map(([,key,value])=>[
    key.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value
  ]));
}
const NOW = '2026-11-19T01:00:00.000Z';
const emptyToday = {
  date:'2026-11-19',yesterdayDate:'2026-11-18',timeZone:'Asia/Seoul',
  notes:[],todayEvents:[],yesterdayEvents:[],lastActiveDay:null,worklogs:[],sessions:[],warnings:[],
};
const baseState = () => ({
  version:1,revision:1,runs:[],archivedRuns:[],projects:[{id:'project-1',kind:'git',hostId:'local',name:'App'}],
  workspaces:[],context:null,agents:[],providers:['codex','claude','cursor'],warnings:[],
});
function workflow() {
  return {
    id:'run-1',goal:'테스트 앱',status:'paused',maxConcurrency:2,maxAttempts:3,maxRepairLoops:3,repairLoops:0,
    createdAt:NOW,updatedAt:NOW,events:[],
    nodes:[
      {id:'research',title:'Research',deps:[],agent:'codex',reviewer:'codex',status:'passed',attempts:1,reviewAttempts:1,active:null},
      {id:'build',title:'Build',deps:['research'],agent:'codex',reviewer:'codex',status:'pending',attempts:0,reviewAttempts:0,active:null},
    ],
  };
}
async function harness({state=baseState(),responses={}}={}) {
  const listeners = new Map(),events = new Map(),calls = [],frames = new Map();
  let nextFrame=0,html='',renders=0;
  const toast = {textContent:'',className:'',timer:null};
  const app = {
    get innerHTML(){return html;},set innerHTML(value){html=value;renders++;},
    setAttribute(){},querySelector(){return null;},querySelectorAll(){return [];},
    addEventListener(name,handler){listeners.set(name,handler);},
  };
  const document = {
    activeElement:null,
    querySelector(selector){return selector==='#app'?app:selector==='#toast'?toast:null;},
  };
  class TestFormData {
    constructor(form) {
      this.entries = Object.entries(form.values)
        .filter(([name,value])=>!form.disabledNames.has(name)&&value!==false&&value!==undefined&&value!==null)
        .map(([name,value])=>[name,value===true?'on':String(value)]);
    }
    [Symbol.iterator](){return this.entries[Symbol.iterator]();}
  }
  const orca = {
    plugin:{
      async request(name,input) {
        calls.push({name,input:copy(input)});
        if (responses[name]) return responses[name](input);
        if (name==='state.get') return copy(state);
        if (name==='runs.get') {
          const run=[...(state.runs??[]),...(state.archivedRuns??[])].find(item=>item.id===input.runId);
          if(!run)throw new Error('Unknown test run: '+input.runId);
          return copy(run);
        }
        if (name==='today.snapshot') return copy(emptyToday);
        if (name==='play.list') return {accounts:[],protection:{status:'os-keyring'}};
        if (name==='runs.create') return {id:'created-run'};
        return {};
      },
      on(name,handler){events.set(name,handler);return {dispose(){events.delete(name);}};},
    },
    shell:{async openExternal(url){calls.push({name:'shell.openExternal',input:{url}});return {opened:true};}},
  };
  const context=vm.createContext({
    document,window:{orca,addEventListener(){}},FormData:TestFormData,URL,Intl,Date,
    requestAnimationFrame(callback){const id=++nextFrame;frames.set(id,callback);return id;},setTimeout(){return 0;},clearTimeout(){},
  });
  vm.runInContext(source,context,{filename:'panel/studio.mjs'});
  await new Promise(resolve=>setImmediate(resolve));
  const click=async(dataset)=>{
    const target={dataset,disabled:false,textContent:'',closest(){return target;}};
    await listeners.get('click')({target});
    return target;
  };
  const form=(id,values,dataset={},disabledNames=[])=>{
    const submit={disabled:false};
    const fields=Object.entries(values).map(([name,value])=>({name,value:String(value??''),disabled:disabledNames.includes(name)}));
    const result={
      id,values:{...values},dataset,disabledNames:new Set(disabledNames),elements:fields,
      querySelector(selector){
        if(selector==='[type="submit"]')return submit;
        const name=selector.match(/name=["']([^"']+)["']/)?.[1];
        return fields.find(field=>field.name===name)??null;
      },
      querySelectorAll(selector) {
        if(selector.includes('serviceAccountJson')||selector.includes('credentialPath')) return fields.filter(field=>['serviceAccountJson','credentialPath'].includes(field.name));
        return [];
      },
    };
    result.elements.namedItem=name=>fields.find(field=>field.name===name)??null;
    return result;
  };
  return {
    calls,toast,app,events,form,click,document,
    renders:()=>renders,pendingFrames:()=>frames.size,
    settle:()=>new Promise(resolve=>setImmediate(resolve)),
    flushFrames:async()=>{
      for(let round=0;frames.size;round++) {
        assert.ok(round<30,'animation frames should settle');
        const pending=[...frames.values()];frames.clear();
        for(const callback of pending)callback();
        await new Promise(resolve=>setImmediate(resolve));
      }
    },
    submit:async form=>listeners.get('submit')({target:form,preventDefault(){}}),
    input:async(target,form)=>listeners.get('input')({target:{...target,closest:()=>form}}),
    requests:name=>calls.filter(call=>call.name===name),
  };
}

test('initial hydration requests summary and a bounded Today page without loading run details',async()=>{
  const h=await harness();
  assert.deepEqual(h.requests('state.get').map(call=>call.input),[{view:'summary'}]);
  assert.deepEqual(h.requests('today.snapshot').map(call=>call.input),[{noteOffset:0,noteLimit:6}]);
  assert.equal(h.requests('runs.get').length,0);
});

test('creating an app graph sends assignments and numeric limits but never starts agents',async()=>{
  const h=await harness();
  await h.submit(h.form('new-run',{
    goal:'Flutter 앱의 첫 버전을 구현합니다.',projectId:'project-1',agent:'cursor',reviewer:'claude',
    maxConcurrency:'2',maxAttempts:'3',maxRepairLoops:'1',baseBranch:' main ',
  }));
  assert.equal(h.requests('runs.create').length,1);
  const input=h.requests('runs.create')[0].input;
  assert.equal(input.maxConcurrency,2);
  assert.equal(input.maxAttempts,3);
  assert.equal(input.maxRepairLoops,1);
  assert.equal(input.baseBranch,'main');
  assert.equal(Object.keys(input.assignments).length,11);
  assert.deepEqual(input.assignments.build,{agent:'cursor',reviewer:'claude'});
  assert.equal(h.requests('runs.start').length,0);
  assert.equal(h.requests('agent.launch').length,0);
});

test('preparation-only approval never carries an actual store submission scope',async()=>{
  const h=await harness();
  await h.submit(h.form('approval',{
    note:'업로드 전에 내부 테스트 자료만 준비합니다.',
    packageName:'com.example.ignored',track:'production',versionCode:'99',
  },{run:'run-1',node:'internal'}));
  assert.deepEqual(h.requests('runs.approve')[0].input,{
    runId:'run-1',nodeId:'internal',note:'업로드 전에 내부 테스트 자료만 준비합니다.',
  });
});

test('explicit submission sends exactly the chosen package, track, version and approval note',async()=>{
  const h=await harness();
  await h.submit(h.form('approval',{
    note:'검증한 버전 42를 내부 테스트로 제출합니다.',actualSubmission:true,
    packageName:' com.example.app ',track:' internal ',versionCode:'42',
  },{run:'run-1',node:'internal'}));
  assert.deepEqual(h.requests('runs.approve')[0].input,{
    runId:'run-1',nodeId:'internal',note:'검증한 버전 42를 내부 테스트로 제출합니다.',
    submission:{packageName:'com.example.app',track:'internal',versionCode:42},
  });
});

test('an incomplete submission approval is rejected before the worker is called',async()=>{
  const h=await harness();
  await h.submit(h.form('approval',{
    note:'내부 테스트 제출 요청',actualSubmission:true,packageName:'',track:'internal',versionCode:'0',
  },{run:'run-1',node:'internal'}));
  assert.equal(h.requests('runs.approve').length,0);
  assert.match(h.toast.textContent,/패키지|버전/);
});

test('mixed completed and pending team assignments submit only mutable changes',async()=>{
  const state=baseState();
  state.runs=[workflow()];
  const h=await harness({state});
  await h.click({action:'open-run',run:'run-1'});
  const form=h.form('assignments',{
    'research.agent':'codex','research.reviewer':'codex',
    'build.agent':'cursor','build.reviewer':'codex',
  },{run:'run-1'},['research.agent','research.reviewer']);
  await h.submit(form);
  assert.equal(h.requests('runs.updateAssignments').length,1);
  const input=h.requests('runs.updateAssignments')[0].input;
  assert.equal(input.runId,'run-1');
  assert.deepEqual(Object.keys(input.assignments),['build']);
  assert.equal(input.assignments.build.agent,'cursor');
  assert.ok(!input.assignments.research);
});

test('account save sends selected credentials once, then clears secret fields even on error',async()=>{
  const h=await harness({responses:{
    'play.account.save':async()=>{throw new Error('OS keyring locked');},
  }});
  const form=h.form('account',{
    name:'Toris',packages:'com.example.app\ncom.example.second',tracks:'production, internal',
    serviceAccountJson:'{"testOnlySecret":"not-a-real-key"}',credentialPath:'',
  });
  await h.input({name:'serviceAccountJson',type:'textarea',value:form.values.serviceAccountJson},form);
  await h.submit(form);
  assert.equal(h.requests('play.account.save').length,1);
  assert.deepEqual(h.requests('play.account.save')[0].input.packages,['com.example.app','com.example.second']);
  assert.deepEqual(h.requests('play.account.save')[0].input.tracks,['production','internal']);
  for(const field of form.querySelectorAll('[name="serviceAccountJson"],[name="credentialPath"]'))assert.equal(field.value,'');
  await h.click({action:'new-account'});
  assert.ok(!h.app.innerHTML.includes('not-a-real-key'));
  assert.equal(h.toast.textContent,'OS keyring locked');
});

test('read-only Play check is forced only by the explicit check button',async()=>{
  const h=await harness();
  await h.click({action:'tab',tab:'play'});
  assert.equal(h.requests('play.check').length,0);
  await h.click({action:'check-play',account:'account-1'});
  assert.deepEqual(h.requests('play.check')[0].input,{accountId:'account-1',force:true});
  assert.equal(h.requests('play.account.save').length,0);
});

function recoveryState() {
  const state=baseState(),run=workflow();
  const node=run.nodes.find(item=>item.id==='build');
  node.status='blocked';
  node.pendingReceipt={nonce:'receipt-1',terminalId:'terminal-1'};
  run.jobs=[{nonce:'receipt-1',terminalId:'terminal-1',nodeId:'build',state:'awaiting-report'}];
  state.runs=[run];
  return state;
}

test('prompt delivery without the empty-input acknowledgement makes no worker request',async()=>{
  const h=await harness({state:recoveryState()});
  await h.click({action:'open-run',run:'run-1'});
  h.app.querySelector=selector=>selector==='#delivery-ack'?{checked:false}:null;
  const before=h.calls.length;
  const button=await h.click({action:'deliver-prompt',run:'run-1',node:'build'});
  assert.equal(h.requests('nodes.deliverPrompt').length,0);
  assert.equal(h.calls.length,before);
  assert.match(h.toast.textContent,/빈 입력 화면.*체크/);
  assert.equal(button.disabled,false);
});

test('acknowledged prompt delivery targets only the existing task and refreshes its state',async()=>{
  const h=await harness({state:recoveryState()});
  await h.click({action:'open-run',run:'run-1'});
  h.app.querySelector=selector=>selector==='#delivery-ack'?{checked:true}:null;
  const before=h.calls.length;
  await h.click({action:'deliver-prompt',run:'run-1',node:'build',nonce:'receipt-1'});
  assert.deepEqual(h.calls.slice(before),[
    {name:'nodes.deliverPrompt',input:{runId:'run-1',nodeId:'build',acknowledgeUnsent:true,expectedNonce:'receipt-1'}},
    {name:'state.get',input:{view:'summary'}},
  ]);
  assert.equal(h.requests('runs.start').length,0);
  assert.equal(h.requests('agent.launch').length,0);
  assert.match(h.toast.textContent,/기존 터미널/);
});

test('first-prompt recovery is offered only for a blocked reportless terminal without a previous session or send',async()=>{
  const scenarios=[
    ['eligible',()=>{},true],
    ['working stage',run=>{run.nodes[1].status='running';},false],
    ['missing terminal',run=>{delete run.nodes[1].pendingReceipt.terminalId;},false],
    ['running job',run=>{run.jobs[0].state='running';},false],
    ['known session',run=>{run.jobs[0].sessionId='session-1';},false],
    ['previous recovery',run=>{run.jobs[0].promptRecovery={state:'sent'};},false],
    ['cancelled run',run=>{run.status='cancelled';},false],
    ['completed run',run=>{run.status='completed';},false],
  ];
  for(const [name,change,offered] of scenarios) {
    const state=recoveryState();change(state.runs[0]);
    const h=await harness({state});
    await h.click({action:'open-run',run:'run-1'});
    assert.equal(h.app.innerHTML.includes('data-action="deliver-prompt"'),offered,name);
    if(offered) {
      assert.equal(renderedAction(h.app.innerHTML,'deliver-prompt').nonce,'receipt-1');
      assert.equal(renderedAction(h.app.innerHTML,'retry-node').nonce,'receipt-1');
    }
  }
});

test('state event bursts render once per frame and ignore older revisions without losing the host catalog',async()=>{
  const state=baseState();state.runs=[workflow()];
  const h=await harness({state});await h.flushFrames();
  const before=h.renders(),requests=h.calls.length;
  const update=(revision,goal)=>({version:1,revision,runs:[{...workflow(),goal}],archivedRuns:[]});
  h.events.get('state.changed')(update(2,'중간 결과'));
  h.events.get('state.changed')(update(3,'최신 결과'));
  h.events.get('state.changed')(update(2,'오래된 결과'));
  assert.equal(h.renders(),before,'events should wait for an animation frame');
  await h.flushFrames();
  assert.equal(h.renders(),before+1);
  assert.ok(h.app.innerHTML.includes('최신 결과'));
  assert.ok(!h.app.innerHTML.includes('중간 결과'));
  assert.ok(!h.app.innerHTML.includes('오래된 결과'));
  assert.equal(h.calls.length,requests,'summary events on Today do not reload the host catalog');
  await h.click({action:'new-run'});
  assert.ok(h.app.innerHTML.includes('value="project-1"'),'partial summary must preserve the project catalog');
});

test('studio event bursts coalesce detail requests and render the latest revision',async()=>{
  const state=baseState();state.runs=[workflow()];
  const h=await harness({state});
  await h.click({action:'open-run',run:'run-1'});await h.flushFrames();
  assert.equal(h.requests('runs.get').length,1);
  const before=h.renders();
  for(let revision=2;revision<=5;revision++) {
    state.revision=revision;
    state.runs[0]={...workflow(),goal:'새 배정 '+revision};
    h.events.get('state.changed')({version:1,revision,runs:copy(state.runs),archivedRuns:[]});
  }
  await h.flushFrames();
  assert.equal(h.requests('runs.get').length,2,'one detail request should cover the entire event burst');
  assert.ok(h.renders()<=before+2,'summary and returned detail each need at most one paint');
  assert.ok(h.app.innerHTML.includes('새 배정 5'));
});

test('dirty handoff input survives background updates and saving reveals the latest state',async()=>{
  const state=baseState();state.runs=[{...workflow(),goal:'업데이트 전 목표'}];
  const h=await harness({state});await h.flushFrames();
  const form=h.form('handoff',{workspaceId:'workspace-1',state:'진행 내용',next:'작성하던 다음 행동'});
  await h.input({name:'next',type:'textarea',value:form.values.next},form);
  const notice={hidden:true};let restoredFocus=0;
  h.document.activeElement={id:'handoff-next',matches:()=>true};
  h.app.querySelector=selector=>selector==='[data-update-notice]'?notice:
    selector==='#handoff-next'?{focus(){restoredFocus++;}}:null;
  const before=h.app.innerHTML,renders=h.renders();
  h.events.get('state.changed')({version:1,revision:2,runs:[{...workflow(),goal:'업데이트 후 목표'}],archivedRuns:[]});
  await h.flushFrames();
  assert.equal(h.app.innerHTML,before);
  assert.equal(h.renders(),renders);
  assert.equal(form.elements.namedItem('next').value,'작성하던 다음 행동');
  assert.equal(notice.hidden,false);
  await h.submit(form);await h.flushFrames();
  assert.deepEqual(h.requests('today.save')[0].input,form.values);
  assert.ok(h.app.innerHTML.includes('업데이트 후 목표'));
  assert.ok(!h.app.innerHTML.includes('업데이트 전 목표'));
  assert.ok(restoredFocus>0,'a submitted input may keep focus without indefinitely suppressing refresh');
});

test('secret inputs keep the current form dirty but never return as drafts after navigation',async()=>{
  const h=await harness();await h.click({action:'new-account'});await h.flushFrames();
  const form=h.form('account',{
    name:'입력 중인 계정',credentialPath:'/private/never-persist-this-path.json',
    serviceAccountJson:'{"fixtureSecret":"never-persist-this-value"}',
  });
  for(const [name,value] of Object.entries(form.values))await h.input({name,type:'text',value},form);
  const before=h.app.innerHTML,renders=h.renders();
  h.events.get('state.changed')({version:1,revision:2,runs:[],archivedRuns:[]});
  await h.flushFrames();
  assert.equal(h.renders(),renders);
  assert.equal(h.app.innerHTML,before);
  await h.click({action:'tab',tab:'agents'});
  await h.click({action:'tab',tab:'play'});
  assert.ok(h.app.innerHTML.includes('입력 중인 계정'),'non-secret drafts survive returning to the form');
  assert.ok(!h.app.innerHTML.includes('never-persist-this-path'));
  assert.ok(!h.app.innerHTML.includes('never-persist-this-value'));
  assert.equal(h.requests('play.account.save').length,0);
});

test('archived evidence is fetched only when opened and reused within the same revision',async()=>{
  const state=baseState(),gate=deferred();
  const archived={...workflow(),id:'archive-1',goal:'보관된 앱',status:'completed',archivedAt:NOW};
  archived.events=[{id:'proof',at:NOW,summary:'보관된 독립 검토 근거'}];
  state.archivedRuns=[{id:archived.id,goal:archived.goal,status:'completed',archivedAt:NOW,createdAt:NOW,updatedAt:NOW,nodeCount:2,passedCount:2}];
  const h=await harness({state,responses:{'runs.get':input=>{
    assert.equal(input.runId,'archive-1');return gate.promise;
  }}});
  assert.equal(h.requests('runs.get').length,0);
  const opening=h.click({action:'open-archive',run:'archive-1'});
  await h.settle();
  assert.equal(h.requests('runs.get').length,1);
  assert.ok(h.app.innerHTML.includes('실행 기록을 불러오고'));
  gate.resolve(copy(archived));await opening;
  assert.ok(h.app.innerHTML.includes('보관된 독립 검토 근거'));
  await h.click({action:'open-archive',run:'archive-1'});
  await h.click({action:'open-archive',run:'archive-1'});
  assert.equal(h.requests('runs.get').length,1);
});

test('more notes requests the next bounded page once and merges overlapping workspace records',async()=>{
  const gate=deferred();
  const note=i=>({workspaceId:'workspace-'+i,projectName:'인계 프로젝트 '+i,state:'진행 '+i,next:'다음 '+i,at:NOW,verificationFreshness:'unknown'});
  const first={...copy(emptyToday),notes:Array.from({length:6},(_,i)=>note(i+1)),notesPage:{offset:0,limit:6,total:8,hasMore:true}};
  const second={...copy(emptyToday),notes:[{...note(6),projectName:'갱신된 프로젝트 6'},note(7),note(8)],notesPage:{offset:6,limit:6,total:8,hasMore:false}};
  const h=await harness({responses:{'today.snapshot':input=>input.noteOffset===0?copy(first):gate.promise}});
  const one=h.click({action:'more-notes'});
  const two=h.click({action:'more-notes'});
  await h.settle();
  assert.deepEqual(h.requests('today.snapshot').map(call=>call.input),[{noteOffset:0,noteLimit:6},{noteOffset:6,noteLimit:6}]);
  gate.resolve(second);await Promise.all([one,two]);
  assert.ok(h.app.innerHTML.includes('인계 프로젝트 1'));
  assert.ok(h.app.innerHTML.includes('인계 프로젝트 8'));
  assert.ok(h.app.innerHTML.includes('갱신된 프로젝트 6'));
  assert.ok(!h.app.innerHTML.includes('인계 프로젝트 6'));
  assert.equal((h.app.innerHTML.match(/data-note-agent="workspace-6"/g)??[]).length,1);
  assert.ok(!h.app.innerHTML.includes('data-action="more-notes"'));
});

test('an explicit refresh queued during an in-flight refresh performs a second forced host read',async()=>{
  const state=baseState(),gate=deferred();let count=0;
  const h=await harness({state,responses:{'state.get':()=>++count===2?gate.promise:copy({...state,revision:count})}});
  const first=h.click({action:'refresh-run',run:'run-1'});
  await h.settle();
  const second=h.click({action:'refresh'});
  gate.resolve(copy({...state,revision:2}));await Promise.all([first,second]);
  assert.deepEqual(h.requests('state.get').map(call=>call.input),[
    {view:'summary'},{view:'summary'},{view:'summary',forceHost:true},
  ]);
});

test('a queued refresh is not lost when the earlier in-flight read fails',async()=>{
  const state=baseState(),gate=deferred();let count=0;
  const h=await harness({state,responses:{'state.get':()=>++count===2?gate.promise:copy({...state,revision:count})}});
  const first=h.click({action:'refresh-run',run:'run-1'});
  await h.settle();
  const second=h.click({action:'refresh'});
  gate.reject(new Error('earlier transient read failed'));
  await Promise.all([first,second]);
  assert.equal(h.requests('state.get').length,3,'the queued retry still needs to run after a failed read');
  assert.deepEqual(h.requests('state.get')[2].input,{view:'summary',forceHost:true});
  assert.ok(!h.app.innerHTML.includes('earlier transient read failed'));
});

test('a failed request from an old tab cannot replace the current page with an error',async()=>{
  const gate=deferred();
  const h=await harness({responses:{'play.list':()=>gate.promise}});
  const prior=h.click({action:'tab',tab:'play'});
  await h.settle();
  await h.click({action:'tab',tab:'agents'});
  gate.reject(new Error('stale Play navigation failure'));await prior;await h.flushFrames();
  assert.ok(h.app.innerHTML.includes('각자의 역할, 하나의 앱.'));
  assert.ok(!h.app.innerHTML.includes('stale Play navigation failure'));
});

test('a stale Today hydration failure during refresh cannot contaminate a later navigation',async()=>{
  const gate=deferred();let count=0;
  const h=await harness({responses:{'today.snapshot':()=>++count===1?copy(emptyToday):gate.promise}});
  const prior=h.click({action:'refresh'});
  await h.settle();
  await h.click({action:'tab',tab:'agents'});
  gate.reject(new Error('stale Today hydration failure'));await prior;await h.flushFrames();
  assert.ok(h.app.innerHTML.includes('각자의 역할, 하나의 앱.'));
  assert.ok(!h.app.innerHTML.includes('stale Today hydration failure'));
});

test('rendered recovery buttons carry their original nonce into worker confirmations',async()=>{
  const h=await harness({state:recoveryState()});
  await h.click({action:'open-run',run:'run-1'});await h.flushFrames();
  const retry=renderedAction(h.app.innerHTML,'retry-node');
  assert.equal(retry.nonce,'receipt-1');
  h.app.querySelector=selector=>['#retry-ack','#retry-stop'].includes(selector)?{checked:true}:null;
  await h.click(retry);
  assert.deepEqual(h.requests('nodes.retry')[0].input,{
    runId:'run-1',nodeId:'build',acknowledgeUncertain:true,stopPrevious:true,expectedNonce:'receipt-1',
  });
});

test('a dirty recovery screen sends its captured nonce after a newer assignment arrives',async()=>{
  const state=recoveryState();
  const h=await harness({state,responses:{'nodes.deliverPrompt':async()=>{throw new Error('확인한 배정이 이미 변경됐습니다.');}}});
  await h.click({action:'open-run',run:'run-1'});await h.flushFrames();
  const button=renderedAction(h.app.innerHTML,'deliver-prompt');
  const form=h.form('assignments',{'build.agent':'claude'});
  await h.input({name:'build.agent',type:'select-one',value:'claude'},form);
  state.revision=2;
  state.runs[0].nodes[1].pendingReceipt={nonce:'receipt-2',terminalId:'terminal-2'};
  state.runs[0].jobs=[{nonce:'receipt-2',terminalId:'terminal-2',nodeId:'build',state:'awaiting-report'}];
  h.events.get('state.changed')(copy(state));await h.flushFrames();
  assert.equal(renderedAction(h.app.innerHTML,'deliver-prompt').nonce,'receipt-1');
  h.app.querySelector=selector=>selector==='#delivery-ack'?{checked:true}:null;
  await h.click(button);
  assert.equal(h.requests('nodes.deliverPrompt')[0].input.expectedNonce,'receipt-1');
  assert.match(h.toast.textContent,/배정이 이미 변경/);
  assert.equal(h.requests('agent.launch').length,0);
});
