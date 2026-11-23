/**
 * Controller contract tests run the actual panel script against a narrow DOM/Orca
 * boundary. They do not claim browser layout, accessibility, or CSS verification.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { createPreviewModel } from '../tools/preview.mjs';

// The panel loads as an ES module; vm scripts cannot import, so inline each relative
// module as a scope that returns its exports (each module is inlined where it is imported).
async function bundle(file) {
  let out=await fs.readFile(new URL('../panel/'+file,import.meta.url),'utf8');
  for(const [statement,names,dependency] of [...out.matchAll(/^import \{([^}]+)\} from '\.\/([\w-]+\.mjs)';$/gm)]) {
    out=out.replace(statement,'const {'+names+'}=(()=>{'+await bundle(dependency)+'})();');
  }
  const exported=[...out.matchAll(/^export (?:const|function|async function) (\w+)/gm)].map(([,name])=>name);
  return out.replace(/^export /gm,'')+(exported.length?'\nreturn {'+exported.join(',')+'};':'');
}
const source = await bundle('studio.mjs');
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
        if (name==='play.submissionAccounts') return [];
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
    change:async target=>listeners.get('change')({target}),
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

const registeredPlay = {id:'play-dev',developerId:'1000000000000000000',name:'Test Play'};
const selectedPlay = registeredPlay.id+':'+registeredPlay.developerId;

test('explicit submission sends the chosen developer, package, track, version and approval note',async()=>{
  const state=baseState();
  const run=workflow();
  run.nodes=[{...run.nodes[1],id:'internal',deps:[],status:'awaiting-approval'}];
  state.runs=[run];
  const otherPlay={id:'other-play',developerId:'2000000000000000000',name:'Other Play'};
  const h=await harness({state,responses:{'play.submissionAccounts':()=>[otherPlay,registeredPlay]}});
  await h.click({action:'tab',tab:'studio'});
  assert.match(h.app.innerHTML,/Other Play · 2000000000000000000/);
  assert.match(h.app.innerHTML,/Test Play · 1000000000000000000/);
  await h.submit(h.form('approval',{
    note:'검증한 버전 42를 내부 테스트로 제출합니다.',actualSubmission:true,
    playAccount:selectedPlay,packageName:' com.example.app ',track:' internal ',versionCode:'42',
  },{run:'run-1',node:'internal'}));
  assert.deepEqual(h.requests('runs.approve')[0].input,{
    runId:'run-1',nodeId:'internal',note:'검증한 버전 42를 내부 테스트로 제출합니다.',
    submission:{accountId:registeredPlay.id,developerId:registeredPlay.developerId,packageName:'com.example.app',track:'internal',versionCode:42},
  });
});

test('an incomplete submission approval is rejected before the worker is called',async()=>{
  const h=await harness({responses:{'play.submissionAccounts':()=>[registeredPlay]}});
  await h.click({action:'tab',tab:'studio'});
  await h.submit(h.form('approval',{
    note:'내부 테스트 제출 요청',actualSubmission:true,playAccount:selectedPlay,packageName:'',track:'internal',versionCode:'0',
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

const playRows = html => [...html.matchAll(/data-disclosure="play-app:[^:]+:([^"]+)"/g)].map(match=>match[1]);
const catalogApp = (packageName,name,status,tracks=[]) => ({packageName,name,status,tracks,storeUrl:'https://play.google.com/store/apps/details?id='+packageName});
const catalogAccount = (id,apps) => ({id,name:id,tracks:['production'],apps});
const playTrack = extra => ({track:'production',observedAt:NOW,releases:[],...extra});

test('Play app rows put action and lookup issues above routine states and keep track details expandable',async()=>{
  const accounts=[catalogAccount('first',[
    catalogApp('com.example.published','Published','published'),
    catalogApp('com.example.review','Review','in_review'),
    catalogApp('com.example.stale','Stale','published',[playTrack({stale:true})]),
    catalogApp('com.example.draft','Draft','draft'),
    catalogApp('com.example.error','Error','published',[playTrack({stale:true,error:{message:'Permission problem'}})]),
    catalogApp('com.example.approved','Approved','in_review',[playTrack({releases:[{name:'Ready to publish',versionCodes:[42],state:'approved_not_published'}]})]),
    catalogApp('com.example.pending','Pending','draft',[playTrack({releases:[{name:'Needs review',versionCodes:[41],state:'not_sent_for_review'}]})]),
    catalogApp('com.example.rejected','Rejected','rejected'),
  ])];
  const h=await harness({responses:{'play.list':()=>({accounts})}});
  await h.click({action:'tab',tab:'play'});
  assert.deepEqual(playRows(h.app.innerHTML),['rejected','pending','approved','error','draft','stale','review','published'].map(id=>'com.example.'+id));
  assert.match(h.app.innerHTML,/<details class="play-app"[^>]*>[\s\S]*?<summary class="play-app-row">/);
  assert.match(h.app.innerHTML,/Ready to publish[\s\S]*?v42/);
  assert.match(h.app.innerHTML,/Permission problem/);
});

test('Play search and status filter intersect in the selected account without requesting data',async()=>{
  const accounts=[catalogAccount('first',[
    catalogApp('com.example.moon','달빛 습관','rejected'),
    catalogApp('com.example.sun','햇빛 습관','in_review'),
    catalogApp('com.example.night','달빛 일기','published'),
  ]),catalogAccount('second',[catalogApp('com.example.other','달빛 게임','rejected')])];
  const h=await harness({responses:{'play.list':()=>({accounts})}});
  await h.click({action:'tab',tab:'play'});
  const search={id:'play-search',value:'달빛 EXAMPLE',focus(){}},filter={id:'play-status-filter',value:'action'};
  const count={textContent:''},results={innerHTML:'',querySelectorAll:()=>[]};
  h.app.querySelector=selector=>({'#play-search':search,'#play-status-filter':filter,'#play-result-count':count,'#play-results':results})[selector]??null;
  const before=h.calls.length;
  const renders=h.renders();
  await h.input(search);
  assert.deepEqual(playRows(results.innerHTML),['com.example.moon','com.example.night']);
  await h.change(filter);
  assert.deepEqual(playRows(results.innerHTML),['com.example.moon']);
  assert.equal(count.textContent,'3개 중 1개');
  assert.equal(h.renders(),renders,'updating results leaves the search control in place');
  await h.click({action:'select-account',account:'second'});
  assert.deepEqual(playRows(h.app.innerHTML),['com.example.other']);
  await h.input({...search,value:'없는 앱'});
  assert.match(results.innerHTML,/검색 결과가 없습니다/);
  await h.click({action:'reset-play-filters'});
  assert.deepEqual(playRows(results.innerHTML),['com.example.other']);
  assert.equal(search.value,'');
  assert.equal(filter.value,'all');
  assert.equal(h.calls.length,before);
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
    {name:'play.submissionAccounts',input:{}},
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
    // A session id is no evidence of a prompt (an idle, ready Claude has one); a started turn is.
    ['known session',run=>{run.jobs[0].sessionId='session-1';},true],
    ['started turn',run=>{run.jobs[0].promptSeen=true;},false],
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
  assert.ok(h.app.innerHTML.includes('팀별 에이전트'));
  assert.ok(!h.app.innerHTML.includes('stale Play navigation failure'));
});

test('a stale Today hydration failure during refresh cannot contaminate a later navigation',async()=>{
  const gate=deferred();let count=0;
  const h=await harness({responses:{'today.snapshot':()=>++count===1?copy(emptyToday):gate.promise}});
  const prior=h.click({action:'refresh'});
  await h.settle();
  await h.click({action:'tab',tab:'agents'});
  gate.reject(new Error('stale Today hydration failure'));await prior;await h.flushFrames();
  assert.ok(h.app.innerHTML.includes('팀별 에이전트'));
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

function liveRun() {
  const run=workflow();
  run.status='running';run.workspaceId='w1';
  run.nodes[1]={...run.nodes[1],agent:'claude',reviewer:'codex',status:'running',attempts:1,
    active:{phase:'work',nonce:'job-1',terminalId:'term-1',startedAt:NOW,attempt:1}};
  run.jobs=[{nonce:'job-1',nodeId:'build',terminalId:'term-1',state:'running',promptSeen:true}];
  return run;
}

test('Auto App shows teams, the live stage with its agents and ECC subagent, and who works now',async()=>{
  const state=baseState();state.runs=[liveRun()];state.eccAgents=['ecc:tdd-guide','ecc:planner'];
  state.runs[0].nodes[1].eccShortlist={phase:'work',stack:{label:'Godot/GDScript',stacks:['godot']},situation:{summary:'구현 작업 1회차'},
    agents:[{name:'ecc:tdd-guide',why:'테스트 우선 구현'}],skills:[{name:'ecc:godot-patterns',why:'Godot 구현 패턴'}]};
  const h=await harness({state});
  await h.click({action:'open-run',run:'run-1'});await h.flushFrames();
  const html=h.app.innerHTML;
  assert.match(html,/class="lane team-plan/);
  assert.match(html,/class="lane team-build is-busy/);
  assert.match(html,/class="stage is-working[^"]*" data-action="select-node" data-node="build"/);
  assert.match(html,/ecc:tdd-guide/);
  assert.match(html,/ecc:godot-patterns/);
  assert.match(html,/Godot\/GDScript/);
  assert.match(html,/<option value="" selected>자동\(상황에 맞게\)<\/option>/);
  assert.match(html,/crew-end is-holder[^>]*><span class="crew-role">작업<\/span><strong>claude<\/strong>/);
  assert.match(html,/data-action="focus-terminal" data-terminal="term-1"/);
  assert.match(html,/<time data-since="2026-11-19T01:00:00.000Z"/);
});

test('a pushed state moves the stage to review without a refresh request',async()=>{
  const state=baseState();state.runs=[liveRun()];
  const h=await harness({state});
  await h.click({action:'open-run',run:'run-1'});await h.flushFrames();
  const before=h.requests('state.get').length;
  state.revision=2; // runs.get serves the same state, as the worker does
  state.runs[0].nodes[1].active={phase:'review',nonce:'job-2',terminalId:'term-2',startedAt:NOW,attempt:1};
  state.runs[0].nodes[1].status='review';
  h.events.get('state.changed')(copy(state));await h.flushFrames();
  assert.equal(h.requests('state.get').length,before);
  assert.match(h.app.innerHTML,/class="stage is-reviewing[^"]*pulse-handoff/);
  assert.match(h.app.innerHTML,/conduit is-forward[^>]*><span class="conduit-label">검토 인계/);
  assert.match(h.app.innerHTML,/crew-end is-holder[^>]*><span class="crew-role">검토<\/span><strong>codex<\/strong>/);
});

test('the agents tab groups the same stages by team and both tabs jump to each other keeping the stage',async()=>{
  const state=baseState();state.runs=[liveRun()];
  const h=await harness({state});
  await h.click({action:'open-run',run:'run-1'});
  await h.click({action:'show-agent',node:'build'});
  let html=h.app.innerHTML;
  assert.match(html,/팀별 에이전트/);
  assert.match(html,/class="pair is-selected" id="pair-build"/);
  assert.match(html,/live-tag is-working">작업 중/);
  await h.click({action:'open-stage',node:'build'});
  html=h.app.innerHTML;
  assert.match(html,/class="stage is-working is-selected/);
});

test('an ECC change from either tab submits only that field of the shared assignment',async()=>{
  const state=baseState();state.runs=[workflow()];
  const h=await harness({state});
  await h.click({action:'open-run',run:'run-1'});
  const form=h.form('assignments',{'build.agent':'codex','build.reviewer':'codex','build.eccAgent':'ecc:planner'},{run:'run-1'});
  await h.submit(form);
  assert.deepEqual(h.requests('runs.updateAssignments')[0].input.assignments,{build:{eccAgent:'ecc:planner'}});
});

test('the attach card offers only the reserved workspace, never the project checkout',async()=>{
  const state=baseState();
  state.projects[0].path='/repo';
  const run=workflow();run.status='blocked';run.projectId='project-1';run.workspaceCreation={state:'uncertain',name:'neon-abc'};
  state.runs=[run];
  state.workspaces=[
    {id:'primary',name:'neon-abc',projectId:'project-1',hostId:'local',path:'/repo'},
    {id:'other',name:'main',projectId:'project-1',hostId:'local',path:'/repo/main'},
    {id:'reserved',name:'neon-abc',projectId:'project-1',hostId:'local',path:'/repo/neon-abc'},
  ];
  const h=await harness({state});
  await h.click({action:'open-run',run:'run-1'});
  const html=h.app.innerHTML;
  assert.match(html,/value="reserved"/);
  assert.doesNotMatch(html,/value="primary"/);
  assert.doesNotMatch(html,/value="other"/);
  assert.doesNotMatch(html,/data-action="start-run"/);
});

test('a definitely failed workspace creation keeps the same start button',async()=>{
  const state=baseState();
  const run=workflow();run.status='blocked';run.workspaceCreation={state:'failed',name:'neon-abc'};
  run.runtimeMessage='이 저장소에는 아직 커밋이 없어 작업 공간을 만들 기준 브랜치가 없습니다.';
  state.runs=[run];
  const h=await harness({state});
  await h.click({action:'open-run',run:'run-1'});
  const html=h.app.innerHTML;
  assert.match(html,/data-action="start-run"/);
  assert.doesNotMatch(html,/attach-workspace/);
  assert.match(html,/커밋이 없어/);
});

test('a very long /goal run shows a short title on Today, in the select and on the run card with the full goal on demand',async()=>{
  const state=baseState();
  const run=workflow();
  run.goal='/goal\n# 달빛 판타지 수집형 RPG\n\n'+'아주 긴 요구사항 '.repeat(600);
  state.runs=[run];
  const h=await harness({state});
  await h.flushFrames();
  let html=h.app.innerHTML;
  assert.match(html,/<div class="card-title goal-title" title="달빛 판타지 수집형 RPG">달빛 판타지 수집형 RPG<\/div>/);
  assert.doesNotMatch(html,/아주 긴 요구사항/);
  await h.click({action:'open-run',run:'run-1'});
  html=h.app.innerHTML;
  assert.match(html,/<option value="run-1" selected>\[[^\]]+\] 달빛 판타지 수집형 RPG<\/option>/);
  assert.match(html,/<details class="goal-detail"[^>]*><summary>전체 목표 보기/);
  assert.equal(html.split('아주 긴 요구사항').length-1,600,'the full goal appears once, inside the disclosure');
});

test('selecting an agent identifies the opposite role and linked stages without host actions',async()=>{
  const state=baseState();state.runs=[liveRun()];
  const h=await harness({state});
  await h.click({action:'tab',tab:'agents'});
  await h.click({action:'select-agent',node:'build',role:'review'});
  const html=h.app.innerHTML;
  assert.match(html,/id="member-build-review"[^>]+aria-pressed="true"/);
  assert.match(html,/class="member is-working is-holder is-partner" id="member-build-work"/);
  assert.match(html,/협업 상대/);
  assert.match(html,/class="pair is-related is-upstream" id="pair-research"/);
  assert.match(html,/다른 팀으로 인계[^]+?인계 완료[^]+?data-node="build"/);
  assert.equal(h.requests('runs.updateAssignments').length,0);
  assert.equal(h.requests('agent.launch').length,0);
});

test('returned review and QA use the right source and a finished run shows no current holder',async()=>{
  const model=createPreviewModel();
  for(const scenario of ['return','qa','idle']) {
    const result=scenario==='idle'
      ? await model.rpc('runs.cancel',{runId:'preview-demo'})
      : await model.rpc('preview.scenario',{scenario});
    const state=baseState();state.runs=[result];
    const h=await harness({state});
    await h.click({action:'open-run',run:result.id});
    const html=h.app.innerHTML;
    const strip=html.match(/<section class="collab"[^]+?<\/section>/)[0];
    assert.doesNotMatch(strip,/pulse-/,'a loaded snapshot should stay still');
    if(scenario==='return') {
      assert.match(strip,/conduit is-back[^]+?수정 요청[^]+?←/);
      assert.match(strip,/crew-end is-holder[^]+?작업/);
      assert.doesNotMatch(strip,/repair-route/,'a build review did not come from QA');
    } else if(scenario==='qa') {
      assert.match(strip,/repair-route[^]+?재작업 · 구현팀[^]+?수정 요청 1 \/ 3[^]+?←[^]+?검토 · 검증팀/);
      assert.match(html,/stage is-waiting is-related is-repair-source[^"]*" data-action="select-node" data-node="test"/);
    } else {
      assert.match(strip,/이 흐름은 끝났습니다/);
      assert.doesNotMatch(strip,/conduit|holder-label|repair-route/);
      assert.doesNotMatch(html,/is-repair-(source|target)/);
    }
  }
});

function visualRun() {
  const run=workflow();
  run.nodes[1]={...run.nodes[1],id:'design',title:'Design',agent:'codex',reviewer:'claude',status:'pending',
    visualShortlist:{stage:'design',art:{pixel:true,source:'goal'},skills:[{name:'pixel-art-studio',why:'HUD·메뉴 UI 킷 시안'},{name:'codex image_gen',why:'화면 시안 이미지',builtin:true}]},
    launchSettings:{model:'gpt-6.2-sol',effort:'high',source:'default',applied:false,reason:'Orca의 agent.launch.before hook이 실행되지 않아 모델을 지정하지 못했습니다.'}};
  return run;
}
const launchOptions={efforts:['low','medium','high','xhigh','max','ultra'],visualStages:['design','assets'],visualDefault:{model:'gpt-6.2-sol',effort:'high'}};

test('the assignment row shows the stage model and effort, editable on codex, with the visual default as placeholder',async()=>{
  const state=baseState();state.runs=[visualRun()];state.launchOptions=launchOptions;
  const h=await harness({state});
  await h.click({action:'open-run',run:'run-1'});
  const html=h.app.innerHTML;
  assert.match(html,/<input class="field" name="design\.model"[^>]*placeholder="gpt-6\.2-sol"/);
  assert.match(html,/<select class="field" name="design\.effort"/);
  assert.doesNotMatch(html,/name="design\.model"[^>]*disabled/);
  await h.click({action:'tab',tab:'agents'}); // the full assignment table
  assert.match(h.app.innerHTML,/name="research\.model"[^>]*disabled/,'a finished stage is not editable');
});

test('the inspector lists the visual skills and says whether the model was applied',async()=>{
  const state=baseState();state.runs=[visualRun()];state.launchOptions=launchOptions;
  const h=await harness({state});
  await h.click({action:'open-run',run:'run-1'});
  await h.click({action:'select-node',node:'design'});
  const html=h.app.innerHTML;
  assert.match(html,/시각 스킬/);
  assert.match(html,/pixel-art-studio/);
  assert.match(html,/픽셀 아트/);
  assert.match(html,/gpt-6\.2-sol · high/);
  assert.match(html,/적용하지 못했/);
});

test('a model or effort change submits only that field',async()=>{
  const state=baseState();state.runs=[visualRun()];state.launchOptions=launchOptions;
  const h=await harness({state});
  await h.click({action:'open-run',run:'run-1'});
  await h.submit(h.form('assignments',{'design.agent':'codex','design.reviewer':'claude','design.model':'gpt-6.1-terra','design.effort':''},{run:'run-1'}));
  assert.deepEqual(h.requests('runs.updateAssignments')[0].input.assignments,{design:{model:'gpt-6.1-terra'}});
});

test('the run card shows autonomous progress with its limits and switches it through the worker',async()=>{
  const state=baseState();const run=workflow();
  run.autonomous=true;run.autonomy={total:4,retries:{build:2},stopped:{reason:'build 단계를 자동으로 3번 다시 시도했지만 통과하지 못해 멈췄습니다.'}};
  state.runs=[run];state.autonomyLimits={retriesPerStage:3,retriesPerRun:12,switchAgentAfter:2,decisionNudgesPerJob:2,extraRepairLoopsPerRun:3};
  const h=await harness({state});
  await h.click({action:'open-run',run:'run-1'});
  const html=h.app.innerHTML;
  assert.match(html,/자율 진행/);
  assert.match(html,/자동 재시도 4\/12/);
  assert.match(html,/3번 다시 시도했지만/);
  const toggle=renderedAction(html,'toggle-autonomy');
  assert.equal(toggle.enabled,'false');
  await h.click(toggle);
  assert.deepEqual(h.requests('runs.setAutonomous')[0].input,{runId:'run-1',enabled:false});
});

test('a run whose state cannot be saved says so on its card, with the attempts and the reason',async()=>{
  const state=baseState();const run=workflow();
  run.storageWarning={since:'2026-11-22T06:03:40.000Z',attempts:3,message:'toris-neon.run.run-1 저장 실패: value exceeds 262144 bytes'};
  state.runs=[run];
  const h=await harness({state});
  await h.click({action:'open-run',run:'run-1'});
  const html=h.app.innerHTML;
  assert.match(html,/실행 상태를 저장하지 못하고 있습니다/);
  assert.match(html,/3회/);
  assert.match(html,/value exceeds 262144 bytes/);
});

test('a live stage shows its time budget next to the elapsed time, and passed reviews show their follow-ups',async()=>{
  const state=baseState();const run=liveRun();run.jobs[0].budgetMinutes=120;
  run.nodes[0]={...run.nodes[0],status:'passed',review:{outcome:'passed',summary:'검토 통과',followUps:['B8 연속 경로는 구현 테스트로 확인']}};
  state.runs=[run];
  const h=await harness({state});
  await h.click({action:'open-run',run:'run-1'});await h.flushFrames();
  assert.match(h.app.innerHTML,/예산 120분/);
  await h.click({action:'select-node',node:run.nodes[0].id});
  assert.match(h.app.innerHTML,/후속 과제/);
  assert.match(h.app.innerHTML,/B8 연속 경로는 구현 테스트로 확인/);
});

test('the run card switches closing finished terminals through the worker, on by default for autonomous runs',async()=>{
  const state=baseState();const run=workflow();run.autonomous=true;state.runs=[run];
  const h=await harness({state});
  await h.click({action:'open-run',run:'run-1'});
  assert.match(h.app.innerHTML,/끝난 터미널 자동 닫기 켜짐/);
  const toggle=renderedAction(h.app.innerHTML,'toggle-terminal-cleanup');
  assert.equal(toggle.enabled,'false');
  await h.click(toggle);
  assert.deepEqual(h.requests('runs.setTerminalCleanup')[0].input,{runId:'run-1',enabled:false});
});

test('the Auto App tab opens on a live run, not on a cancelled one listed first, and labels each run with its status',async()=>{
  const state=baseState();
  const old=workflow();old.id='run-old';old.status='cancelled';old.goal='예전 실행';old.updatedAt='2026-11-23T00:00:00.000Z';
  const live=workflow();live.id='run-live';live.status='running';live.goal='진행 중 실행';live.updatedAt='2026-11-01T00:00:00.000Z';
  state.runs=[old,live];
  const h=await harness({state});
  await h.flushFrames();
  await h.click({action:'tab',tab:'studio'});
  const html=h.app.innerHTML;
  assert.match(html,/<option value="run-live" selected>\[진행 중\] 진행 중 실행<\/option>/);
  assert.ok(html.indexOf('value="run-live"')<html.indexOf('value="run-old"'),'live runs are listed before cancelled ones');
  assert.match(html,/<option value="run-old" >\[취소\] 예전 실행<\/option>/);
});
