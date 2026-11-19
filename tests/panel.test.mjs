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
const NOW = '2026-11-19T01:00:00.000Z';
const emptyToday = {
  date:'2026-11-19',yesterdayDate:'2026-11-18',timeZone:'Asia/Seoul',
  notes:[],todayEvents:[],yesterdayEvents:[],lastActiveDay:null,worklogs:[],sessions:[],warnings:[],
};
const baseState = () => ({
  runs:[],projects:[{id:'project-1',kind:'git',hostId:'local',name:'App'}],
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
  const listeners = new Map(),events = new Map(),calls = [];
  const toast = {textContent:'',className:'',timer:null};
  const app = {
    innerHTML:'',setAttribute(){},querySelector(){return null;},querySelectorAll(){return [];},
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
    requestAnimationFrame(){return 0;},setTimeout(){return 0;},clearTimeout(){},
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
    calls,toast,app,events,form,click,
    submit:async form=>listeners.get('submit')({target:form,preventDefault(){}}),
    input:async(target,form)=>listeners.get('input')({target:{...target,closest:()=>form}}),
    requests:name=>calls.filter(call=>call.name===name),
  };
}

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
