import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  dayKey, previousDay, fingerprint, verificationFreshness, readWorklogs, createTodayService,
} from '../src/today.mjs';

const exec = promisify(execFile);
const STORE = 'neon.today.v1';
const NOW = Date.parse('2026-11-18T15:10:00.000Z');
const row = { id:'workspace-1', name:'sample-app', project:'sample-app', path:'/virtual/sample-app', hostId:'local' };
const throwsCode = code => error => error.code === code;

async function temporary(t) {
  const folder = await fs.mkdtemp(path.join(tmpdir(),'toris-neon-test-'));
  t.after(() => fs.rm(folder,{recursive:true,force:true}));
  return folder;
}
async function git(folder,args) {
  return exec('git', [
    '-c','core.hooksPath=' + path.join(folder,'no-hooks'),
    '-c','commit.gpgsign=false',
    '-c','user.name=NEON Test',
    '-c','user.email=neon-test@example.invalid',
    '-C',folder,...args,
  ],{encoding:'utf8',timeout:15000,windowsHide:true});
}
async function repository(t) {
  const folder = await temporary(t);
  await git(folder,['init','--initial-branch=main']);
  await fs.writeFile(path.join(folder,'app.txt'),'alpha\n');
  await git(folder,['add','app.txt']);
  await git(folder,['commit','-m','fixture']);
  return folder;
}

function host(options={}) {
  const values = new Map();
  if (options.stored) values.set(STORE, structuredClone(options.stored));
  const calls = [];
  let current = options.current ?? {available:true,hash:'one',head:'head',branch:'main',dirty:false};
  let agents = options.agents ?? [];
  let terminals = options.terminals ?? [];
  let clock = options.now ?? NOW;
  const state = options.state ?? {runs:[]};
  let getStateCalls = 0;
  const getStateInputs = [];
  const orca = {
    storage: {
      async get(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
      async set(key,value) { values.set(key,structuredClone(value)); },
    },
    settings: { async get() { return '/virtual/worklogs'; } },
    host: {
      has(method) { return method === 'agent.listSessions'; },
      async call(method,input) {
        calls.push({method,input:structuredClone(input)});
        if (options.handlers?.[method]) return options.handlers[method](input);
        if (method === 'workspace.list') return {workspaces:options.workspaces??[row]};
        if (method === 'agent.listSessions') return {sessions:options.sessions??[]};
        if (method === 'agents.list') return {agents};
        if (method === 'terminal.list') return {terminals};
        if (method === 'agent.launch') {
          terminals = [{id:'terminal-1'}];
          return {terminalId:'terminal-1'};
        }
        if (method === 'agent.resume') return {terminalId:'terminal-resume',started:true};
        throw new Error('Unexpected host method: '+method);
      },
    },
  };
  const service = createTodayService({
    orca,
    getState:input=>{getStateCalls++;getStateInputs.push(input);return structuredClone(state);},
    now:()=>clock,
    inspect:options.inspect ?? (async()=>structuredClone(current)),
    readLogs:options.readLogs ?? (async()=>structuredClone(options.logs??[])),
  });
  return {
    service,calls,values,orca,getStateInputs,
    setClock:value=>{clock=value;},
    setCurrent:value=>{current=value;},
    setAgents:value=>{agents=value;},
    setTerminals:value=>{terminals=value;},
    getStateCalls:()=>getStateCalls,
    stored:()=>structuredClone(values.get(STORE)),
    called:method=>calls.filter(call=>call.method===method),
  };
}
const noteInput = {workspaceId:row.id,state:'로그인 오류를 수정했습니다.',next:'실기기에서 로그인을 확인합니다.',verified:'node --test: 5 passed'};
async function saveNote(h) { return h.service.save(noteInput); }

test('calendar helpers handle KST midnight, leap dates, and invalid input', () => {
  assert.equal(dayKey('2026-11-18T14:59:59.999Z'),'2026-11-18');
  assert.equal(dayKey('2026-11-18T15:00:00.000Z'),'2026-11-19');
  assert.equal(previousDay('2024-03-01'),'2024-02-29');
  assert.equal(previousDay('2026-01-01'),'2025-12-31');
  assert.throws(()=>previousDay('2026-02-30'),throwsCode('invalid_params'));
  assert.throws(()=>previousDay('../../private'),throwsCode('invalid_params'));
  assert.throws(()=>dayKey('invalid'),throwsCode('invalid_params'));
  assert.throws(()=>dayKey(NOW,'Unknown/Zone'),throwsCode('invalid_params'));
});

test('fingerprints detect same-size tracked edits, independent of unchanged status/diff size', async t => {
  const folder = await repository(t);
  const clean = await fingerprint(folder);
  assert.equal(clean.available,true);
  assert.equal(clean.dirty,false);
  await fs.writeFile(path.join(folder,'app.txt'),'bravo\n');
  const first = await fingerprint(folder);
  await fs.writeFile(path.join(folder,'app.txt'),'delta\n');
  const second = await fingerprint(folder);
  assert.equal(first.available,true);
  assert.equal(first.dirty,true);
  assert.notEqual(first.hash,second.hash);
  assert.notEqual(clean.hash,first.hash);
  assert.equal(verificationFreshness({verified:'test passed',fingerprint:first},second),'stale');
  await git(folder,['add','app.txt']);
  const staged = await fingerprint(folder);
  assert.notEqual(staged.hash,second.hash);
});

test('fingerprints hash untracked contents and report unknown for non-Git folders', async t => {
  const folder = await repository(t);
  await fs.writeFile(path.join(folder,'untracked.txt'),'1111');
  const first = await fingerprint(folder);
  await fs.writeFile(path.join(folder,'untracked.txt'),'2222');
  const second = await fingerprint(folder);
  assert.notEqual(first.hash,second.hash);
  const nonGit = await temporary(t);
  const unknown = await fingerprint(nonGit);
  assert.equal(unknown.available,false);
  assert.equal(verificationFreshness({verified:'test',fingerprint:first},unknown),'unknown');
  assert.equal(verificationFreshness({verified:'',fingerprint:first},first),'unknown');
  assert.equal(verificationFreshness({verified:'test',fingerprint:first},first),'fresh');
});

// Windows symlink creation requires Developer Mode or elevated privileges, neither is a CI assumption.
test('tracked and untracked symlink targets remain unverified and never leak external file contents', {skip:process.platform==='win32'}, async t => {
  const folder = await repository(t);
  const outside = await temporary(t);
  const target = path.join(outside,'private.txt');
  await fs.writeFile(target,'private-one');
  await fs.symlink(target,path.join(folder,'external-link'));
  const first = await fingerprint(folder);
  await fs.writeFile(target,'private-two');
  const second = await fingerprint(folder);
  assert.equal(first.available,false);
  assert.equal(second.available,false);
  assert.ok(!JSON.stringify(second).includes('private-two'));
  await git(folder,['add','external-link']);
  await git(folder,['commit','-m','track symlink fixture']);
  const tracked = await fingerprint(folder);
  assert.equal(tracked.available,false);
  assert.equal(verificationFreshness({verified:'tests passed',fingerprint:tracked},tracked),'unknown');
});

test('worklog reader excludes symlinked projects/files, aliases, oversized files and invalid dates', {skip:process.platform==='win32'}, async t => {
  const folder = await temporary(t);
  const outside = await temporary(t);
  await fs.mkdir(path.join(folder,'safe'));
  await fs.mkdir(path.join(folder,'alias'));
  await fs.mkdir(path.join(folder,'.hidden'));
  await fs.mkdir(path.join(folder,'huge'));
  const day = '2026-11-19';
  await fs.writeFile(path.join(folder,'safe',day+'.md'),'정상 작업 기록\nauthorization: bearer ABCSECRET');
  await fs.writeFile(path.join(outside,day+'.md'),'OUTSIDE_SECRET');
  await fs.symlink(outside,path.join(folder,'linked-project'),'dir');
  await fs.symlink(path.join(outside,day+'.md'),path.join(folder,'safe','2026-11-18.md'));
  await fs.symlink(path.join(folder,'safe',day+'.md'),path.join(folder,'alias',day+'.md'));
  await fs.writeFile(path.join(folder,'.hidden',day+'.md'),'hidden');
  await fs.writeFile(path.join(folder,'huge',day+'.md'),'x'.repeat(129*1024));
  const records = await readWorklogs(folder,[day,'2026-11-18',day]);
  assert.equal(records.length,1);
  assert.equal(records[0].project,'safe');
  assert.match(records[0].text,/정상/);
  assert.ok(!records[0].text.includes('ABCSECRET'));
  assert.ok(!JSON.stringify(records).includes('OUTSIDE_SECRET'));
  await assert.rejects(readWorklogs(folder,['../../secret']),throwsCode('invalid_params'));
  await assert.rejects(readWorklogs(folder,['2026-02-30']),throwsCode('invalid_params'));
});

test('saving handoffs and snapshots retain dated history and real verification freshness', async () => {
  const h = host({
    now:Date.parse('2026-11-18T14:50:00Z'),
    state:{runs:[{id:'run-1',goal:'샘플 앱',events:[{at:'2026-11-17T16:00:00Z',summary:'구현 검토 통과'}]}]},
  });
  const yesterday = await saveNote(h);
  assert.equal(yesterday.day,'2026-11-18');
  assert.equal(yesterday.verificationFreshness,'fresh');
  h.setClock(NOW);
  await h.service.save({...noteInput,state:'실기기 검증을 진행했습니다.',next:'오류 로그를 분류합니다.'});
  h.setCurrent({available:true,hash:'changed'});
  const snapshot = await h.service.snapshot();
  assert.equal(snapshot.date,'2026-11-19');
  assert.equal(snapshot.yesterdayDate,'2026-11-18');
  assert.equal(snapshot.notes.length,1);
  assert.equal(snapshot.notes[0].verificationFreshness,'stale');
  assert.equal(snapshot.todayEvents.length,1);
  assert.equal(snapshot.yesterdayEvents.length,2);
  assert.equal(snapshot.lastActiveDay,'2026-11-18');
  assert.equal(h.getStateCalls(),1);
  assert.equal(h.stored().notes.length,2);
});

test('missing yesterday stays empty, remote workspaces stay unverified, and state corruption is not overwritten', async () => {
  const h = host({workspaces:[{...row,hostId:'ssh:office'}]});
  const saved = await saveNote(h);
  assert.equal(saved.fingerprint.available,false);
  const snapshot = await h.service.snapshot();
  assert.equal(snapshot.yesterdayEvents.length,0);
  assert.equal(snapshot.lastActiveDay,null);
  assert.equal(snapshot.notes[0].verificationFreshness,'unknown');
  const bad = host({stored:{version:2,notes:[],resumes:[]}});
  await assert.rejects(saveNote(bad),throwsCode('state_corrupt'));
  assert.equal(bad.stored().version,2);
});

test('resuming twice reuses the fresh terminal before agent status arrives', async () => {
  const h = host();
  await saveNote(h);
  const first = await h.service.resume({workspaceId:row.id,agent:'codex'});
  const second = await h.service.resume({workspaceId:row.id,agent:'codex'});
  assert.equal(first.status,'started');
  assert.equal(second.reused,true);
  assert.equal(second.agentState,'starting');
  assert.equal(h.called('agent.launch').length,1);
  assert.equal(h.stored().resumes.length,1);
  assert.match(h.called('agent.launch')[0].input.prompt,/handoff-data/);
});

test('a completed resume is not automatically re-executed from the same handoff', async () => {
  const h = host();
  await saveNote(h);
  await h.service.resume({workspaceId:row.id});
  h.setAgents([{terminalId:'terminal-1',state:'done'}]);
  const again = await h.service.resume({workspaceId:row.id});
  assert.equal(again.reused,true);
  assert.equal(again.agentState,'done');
  assert.equal(h.called('agent.launch').length,1);
});

test('expired launching intent after a crash remains uncertain instead of duplicating work', async () => {
  const h = host();
  const note = await saveNote(h);
  const stored = h.stored();
  stored.resumes.push({workspaceId:row.id,noteId:note.id,sessionId:null,status:'launching',at:'2026-01-01T00:00:00Z',terminalId:null});
  h.values.set(STORE,stored);
  await assert.rejects(h.service.resume({workspaceId:row.id}),throwsCode('launch_uncertain'));
  assert.equal(h.called('agent.launch').length,0);
});

test('ambiguous host launch is journaled and not retried, including after service restart', async () => {
  const h = host({handlers:{'agent.launch':async()=>{throw new Error('transport timeout');}}});
  await saveNote(h);
  await assert.rejects(h.service.resume({workspaceId:row.id}),throwsCode('launch_uncertain'));
  assert.equal(h.stored().resumes[0].status,'uncertain');
  await assert.rejects(h.service.resume({workspaceId:row.id}),throwsCode('launch_uncertain'));
  const restarted = createTodayService({orca:h.orca,getState:()=>({runs:[]}),now:()=>NOW,inspect:async()=>({available:false}),readLogs:async()=>[]});
  await assert.rejects(restarted.resume({workspaceId:row.id}),throwsCode('launch_uncertain'));
  assert.equal(h.called('agent.launch').length,1);
});

test('missing launch receipt and disappeared terminal cannot create an automatic duplicate', async () => {
  const missing = host({handlers:{'agent.launch':async()=>({})}});
  await saveNote(missing);
  await assert.rejects(missing.service.resume({workspaceId:row.id}),throwsCode('launch_uncertain'));
  assert.equal(missing.stored().resumes[0].status,'uncertain');
  const h = host();
  await saveNote(h);
  await h.service.resume({workspaceId:row.id});
  h.setTerminals([]);
  await assert.rejects(h.service.resume({workspaceId:row.id}),throwsCode('launch_uncertain'));
  assert.equal(h.called('agent.launch').length,1);
});

test('session resume verifies workspace ownership and uses the recorded provider', async () => {
  const h = host({sessions:[
    {sessionId:'session-valid',workspaceId:row.id,agent:'claude'},
    {sessionId:'session-other',workspaceId:'other-workspace',agent:'codex'},
  ]});
  await assert.rejects(h.service.resume({workspaceId:row.id,sessionId:'session-other'}),throwsCode('invalid_params'));
  const result = await h.service.resume({workspaceId:row.id,sessionId:'session-valid',agent:'grok'});
  assert.equal(result.agent,'claude');
  assert.deepEqual(h.called('agent.resume')[0].input,{workspaceId:row.id,agent:'claude',sessionId:'session-valid'});
  assert.equal(h.called('agent.launch').length,0);
});

test('invalid saves and unknown workspaces fail before storage or launch mutation', async () => {
  const h = host();
  await assert.rejects(h.service.save({workspaceId:row.id,state:'',next:'something'}),throwsCode('invalid_params'));
  await assert.rejects(h.service.save({...noteInput,workspaceId:'unknown'}),throwsCode('invalid_params'));
  await assert.rejects(h.service.resume({workspaceId:row.id}),throwsCode('invalid_params'));
  assert.equal(h.stored(),undefined);
  assert.equal(h.called('agent.launch').length,0);
});


test('index flags which can hide modified tracked files cannot report a fresh verification', async t => {
  const folder = await repository(t);
  for (const flag of ['assume-unchanged','skip-worktree']) {
    await git(folder,['update-index','--'+flag,'app.txt']);
    const before = await fingerprint(folder);
    await fs.writeFile(path.join(folder,'app.txt'),flag==='assume-unchanged'?'bravo\n':'delta\n');
    const after = await fingerprint(folder);
    assert.notEqual(verificationFreshness({verified:'tests passed',fingerprint:before},after),'fresh',flag);
    await git(folder,['update-index','--no-'+flag,'app.txt']);
  }
});

test('replacing a tracked regular file with a symlink does not verify its uninspected target', {skip:process.platform==='win32'}, async t => {
  const folder = await repository(t);
  const outside = await temporary(t);
  await fs.writeFile(path.join(outside,'target.txt'),'alpha\n');
  await fs.unlink(path.join(folder,'app.txt'));
  await fs.symlink(path.join(outside,'target.txt'),path.join(folder,'app.txt'));
  const first = await fingerprint(folder);
  await fs.writeFile(path.join(outside,'target.txt'),'bravo\n');
  const second = await fingerprint(folder);
  assert.equal(first.available,false);
  assert.equal(second.available,false);
});

function historicalNote(index, extra={}) {
  return {id:'note-'+index,workspaceId:'workspace-'+index,projectName:'App '+index,state:'Saved '+index,next:'Continue '+index,verified:'tests passed',fingerprint:{available:true,hash:'one'},at:'2026-11-18T16:00:00Z',day:'2026-11-19',...extra};
}

test('snapshot pages every workspace, hashes only comparable visible notes, and bounds concurrent inspections', async () => {
  const notes = Array.from({length:40},(_,i)=>historicalNote(i));
  notes[37].verified='';
  notes[36].fingerprint={available:false};
  const workspaces = notes.map((note,i)=>({...row,id:note.workspaceId,path:'/virtual/'+(i===38?39:i)}));
  const inspected=[];
  let active=0, maximum=0;
  const h = host({
    workspaces,stored:{version:1,notes,resumes:[]},
    inspect:async directory=>{
      inspected.push(directory);
      maximum=Math.max(maximum,++active);
      await new Promise(resolve=>setImmediate(resolve));
      active--;
      return {available:true,hash:'one'};
    }
  });
  const result = await h.service.snapshot({noteOffset:0,noteLimit:6});
  assert.deepEqual(result.notes.map(note=>note.id),['note-39','note-38','note-37','note-36','note-35','note-34']);
  assert.deepEqual(result.notesPage,{offset:0,limit:6,total:40,hasMore:true});
  assert.deepEqual(inspected.sort(),['/virtual/34','/virtual/35','/virtual/39']);
  assert.ok(maximum<=2);
  assert.equal(result.notes[2].verificationFreshness,'unknown');
  assert.equal(result.notes[3].verificationFreshness,'unknown');
  assert.deepEqual(h.getStateInputs,[{view:'timeline'}]);
  const last = await h.service.snapshot({noteOffset:36,noteLimit:6});
  assert.equal(last.notes.length,4);
  assert.equal(last.notesPage.hasMore,false);
  assert.equal((await h.service.snapshot()).notes.length,40);
  for (const input of [{noteOffset:-1},{noteOffset:1.5},{noteLimit:0},{noteLimit:101}]) {
    await assert.rejects(h.service.snapshot(input),throwsCode('invalid_params'));
  }
});

test('concurrent identical snapshots share in-flight IO without caching a subsequent freshness result', async () => {
  let inspections=0;
  let hash='one';
  const h = host({stored:{version:1,notes:[historicalNote(1)],resumes:[]},inspect:async()=>{
    inspections++;
    await new Promise(resolve=>setImmediate(resolve));
    return {available:true,hash};
  }});
  const first = await Promise.all([h.service.snapshot(),h.service.snapshot()]);
  assert.equal(inspections,1);
  assert.equal(h.getStateCalls(),1);
  assert.equal(first[0].notes[0].verificationFreshness,'fresh');
  hash='changed';
  const next = await h.service.snapshot();
  assert.equal(inspections,2);
  assert.equal(next.notes[0].verificationFreshness,'stale');
});

test('event aggregation sorts instants across offsets and numeric timestamps, retaining epoch zero', async () => {
  const h = host({state:{
    runs:[{id:'active',goal:'Active',events:[
      {id:'offset',at:'2026-11-19T08:00:00+09:00'},
      {id:'utc',at:'2026-11-19T00:30:00Z'},
      {id:'numeric',timestamp:Date.parse('2026-11-19T02:00:00Z')},
      {id:'epoch',at:0},
    ]}],
    archivedRuns:[{id:'archived',goal:'Archived',events:[{id:'time',time:'2026-11-19T03:00:00Z'}]}],
  }});
  const today = await h.service.snapshot();
  assert.deepEqual(today.todayEvents.map(event=>event.id),['time','numeric','utc','offset']);
  assert.ok(today.todayEvents.every(event=>typeof event.at==='string'));
  const epoch = await h.service.snapshot({date:'1970-01-01'});
  assert.deepEqual(epoch.todayEvents.map(event=>event.id),['epoch']);
});

test('saving and resuming preserve history beyond former silent retention limits', async () => {
  let inspections=0;
  const h = host({
    stored:{version:1,
      notes:Array.from({length:1000},(_,i)=>historicalNote(i,{workspaceId:row.id})),
      resumes:Array.from({length:300},(_,i)=>({id:'receipt-'+i,workspaceId:row.id,noteId:'note-'+i,sessionId:null,status:'uncertain'})),
    },
    inspect:async()=>{inspections++;return {available:true,hash:'one'};},
  });
  await h.service.save({...noteInput,verified:''});
  assert.equal(h.stored().notes.length,1001);
  assert.equal(h.stored().notes[0].id,'note-0');
  assert.equal(inspections,0);
  await h.service.resume({workspaceId:row.id});
  assert.equal(h.stored().resumes.length,301);
  assert.equal(h.stored().resumes[0].id,'receipt-0');
});

test('the same prior session cannot be resumed twice merely by saving a newer handoff', async () => {
  const h = host({sessions:[{sessionId:'session-one',workspaceId:row.id,agent:'claude'}]});
  await h.service.resume({workspaceId:row.id,sessionId:'session-one'});
  h.setAgents([{terminalId:'terminal-resume',state:'working'}]);
  await saveNote(h);
  const again = await h.service.resume({workspaceId:row.id,sessionId:'session-one'});
  assert.equal(again.reused,true);
  assert.equal(h.called('agent.resume').length,1);
  const uncertain = host({
    sessions:[{sessionId:'session-one',workspaceId:row.id,agent:'claude'}],
    handlers:{'agent.resume':async()=>{throw new Error('timeout');}},
  });
  await assert.rejects(uncertain.service.resume({workspaceId:row.id,sessionId:'session-one'}),throwsCode('launch_uncertain'));
  await saveNote(uncertain);
  await assert.rejects(uncertain.service.resume({workspaceId:row.id,sessionId:'session-one'}),throwsCode('launch_uncertain'));
  assert.equal(uncertain.called('agent.resume').length,1);
});

test('worklogs include projects beyond 100 and expose preview omissions instead of silently hiding them', async t => {
  const folder = await temporary(t);
  const day = '2026-11-19';
  for (let i=0;i<101;i++) {
    const project=path.join(folder,'project-'+String(i).padStart(3,'0'));
    await fs.mkdir(project);
    await fs.writeFile(path.join(project,day+'.md'),'Work '+i);
  }
  await fs.mkdir(path.join(folder,'프로젝트'));
  await fs.writeFile(path.join(folder,'프로젝트',day+'.md'),'한글 경로 기록');
  await fs.mkdir(path.join(folder,'long-preview'));
  await fs.writeFile(path.join(folder,'long-preview',day+'.md'),'a'.repeat(17000));
  await fs.mkdir(path.join(folder,'oversized'));
  await fs.writeFile(path.join(folder,'oversized',day+'.md'),'b'.repeat(129*1024));
  const warnings=[];
  const records = await readWorklogs(folder,[day],{onWarning:warning=>warnings.push(warning)});
  assert.equal(records.length,103);
  assert.ok(records.some(record=>record.project==='project-100'));
  assert.ok(records.some(record=>record.project==='프로젝트'));
  assert.equal(records.find(record=>record.project==='long-preview').truncated,true);
  assert.ok(warnings.some(warning=>warning.includes('oversized')));
  assert.ok(warnings.some(warning=>warning.includes('long-preview')));
});

test('session truncation and worklog IO failures are visible while other Today records remain available', async () => {
  const h = host({
    stored:{version:1,notes:[historicalNote(1)],resumes:[]},
    handlers:{'agent.listSessions':async()=>({sessions:[],truncated:true})},
    readLogs:async()=>{throw new Error('EACCES');},
  });
  const result = await h.service.snapshot();
  assert.equal(result.notes.length,1);
  assert.equal(result.sessionsTruncated,true);
  assert.ok(result.warnings.some(warning=>warning.includes('세션') && warning.includes('80')));
  assert.ok(result.warnings.some(warning=>warning.includes('일지')));
});


test('saving during an in-flight snapshot prevents newer requests from sharing its old handoff', async () => {
  let entered, release;
  const started = new Promise(resolve=>{entered=resolve;});
  const gate = new Promise(resolve=>{release=resolve;});
  const h = host({stored:{version:1,notes:[historicalNote(1)],resumes:[]},inspect:async()=>{
    entered();
    await gate;
    return {available:true,hash:'one'};
  }});
  const old = h.service.snapshot();
  await started;
  const saved = await h.service.save({...noteInput,state:'new handoff',verified:''});
  const fresh = h.service.snapshot();
  release();
  const [before,after] = await Promise.all([old,fresh]);
  assert.equal(before.notes[0].id,'note-1');
  assert.equal(after.notes[0].id,saved.id);
  assert.equal(after.notes[0].state,'new handoff');
  assert.equal(after.notes[0].verificationFreshness,'unknown');
});

test('remote workspaces cannot borrow a local fingerprint for the same pathname', async () => {
  let inspections=0;
  const h = host({
    workspaces:[row,{...row,id:'workspace-2',hostId:'ssh:office'}],
    stored:{version:1,notes:[historicalNote(1),historicalNote(2)],resumes:[]},
    inspect:async()=>{inspections++;return {available:true,hash:'one'};},
  });
  const result = await h.service.snapshot();
  assert.equal(inspections,1);
  assert.equal(result.notes.find(note=>note.workspaceId==='workspace-1').verificationFreshness,'fresh');
  assert.equal(result.notes.find(note=>note.workspaceId==='workspace-2').verificationFreshness,'unknown');
});

test('missing hashes and undated events stay unknown and explicitly retained', async () => {
  assert.equal(verificationFreshness({verified:'passed',fingerprint:{available:true}},{available:true}),'unknown');
  assert.equal(verificationFreshness({verified:'passed',fingerprint:{available:true,hash:''}},{available:true,hash:''}),'unknown');
  const h = host({state:{runs:[{id:'run',events:[{id:'missing'},{id:'invalid',at:'not-a-date'}]}]}});
  const result = await h.service.snapshot();
  assert.deepEqual(result.undatedEvents.map(event=>event.id),['missing','invalid']);
  assert.equal(result.todayEvents.length,0);
  assert.ok(result.warnings.some(warning=>warning.includes('2건')));
});

test('simultaneous resume requests launch once and incomplete prior receipts stay blocked', async () => {
  const h = host();
  const note = await saveNote(h);
  const results = await Promise.all([h.service.resume({workspaceId:row.id}),h.service.resume({workspaceId:row.id})]);
  assert.equal(results[1].reused,true);
  assert.equal(h.called('agent.launch').length,1);
  const broken = host({stored:{version:1,notes:[note],resumes:[{workspaceId:row.id,noteId:note.id,sessionId:null,status:'started',terminalId:null}]}});
  await assert.rejects(broken.service.resume({workspaceId:row.id}),throwsCode('launch_uncertain'));
  assert.equal(broken.called('agent.launch').length,0);
});

// Plan 5.2: a stale verification is re-verified on what changed since, once per code state.
const stale = {available:true,hash:'two',head:'head-2',branch:'main',dirty:true};
test('re-verifying a stale handoff launches one verification-only agent scoped to the changes since the recorded head', async () => {
  // Arrange
  const h = host();
  await saveNote(h);
  h.setCurrent(stale);
  // Act
  const first = await h.service.resume({workspaceId:row.id,agent:'claude',mode:'reverify'});
  const again = await h.service.resume({workspaceId:row.id,agent:'claude',mode:'reverify'});
  // Assert
  assert.equal(first.status,'started');
  assert.equal(first.mode,'reverify');
  assert.equal(again.reused,true);
  assert.equal(h.called('agent.launch').length,1,'pressing re-verify again reuses the running agent');
  const prompt = h.called('agent.launch')[0].input.prompt;
  assert.match(prompt,/git diff head\.\.HEAD/);
  assert.match(prompt,/영향을 주는 검증만/);
  assert.match(prompt,/새 기능 작업은 하지 마세요/);
  assert.match(prompt,/node --test: 5 passed/);
  assert.equal(h.stored().notes[0].verified,'node --test: 5 passed','the stored handoff is not changed by a re-verification');
});

test('re-verify refuses a fresh or undecidable handoff and is separate from continuing its next step', async () => {
  const h = host();
  await saveNote(h);
  await assert.rejects(h.service.resume({workspaceId:row.id,mode:'reverify'}),/다시 검증할 변경이 없습니다/);
  h.setCurrent({available:false,reason:'x'});
  await assert.rejects(h.service.resume({workspaceId:row.id,mode:'reverify'}),/판단할 수 없어/);
  await assert.rejects(h.service.resume({workspaceId:row.id,mode:'deploy'}),throwsCode('invalid_params'));
  h.setCurrent(stale);
  await h.service.resume({workspaceId:row.id,mode:'reverify'});
  h.setTerminals([]);
  const next = await h.service.resume({workspaceId:row.id});
  assert.equal(next.status,'started','continuing the handoff is its own operation');
  assert.match(h.called('agent.launch')[1].input.prompt,/다음 행동을 수행/);
});

test('after the code changes again a new re-verification may start; an uncertain one never repeats and shows on the note', async () => {
  const h = host();
  await saveNote(h);
  h.setCurrent(stale);
  await h.service.resume({workspaceId:row.id,mode:'reverify'});
  h.setCurrent({...stale,hash:'three'});
  const running = await h.service.resume({workspaceId:row.id,mode:'reverify'});
  assert.equal(running.reused,true,'files the running re-verify wrote do not start a second agent');
  h.setAgents([{terminalId:'terminal-1',state:'done'}]);
  h.setCurrent(stale);
  const done = await h.service.resume({workspaceId:row.id,mode:'reverify'});
  assert.deepEqual({reused:done.reused,agentState:done.agentState},{reused:true,agentState:'done'},'the same code is not re-verified twice');
  h.setCurrent({...stale,hash:'three'});
  await h.service.resume({workspaceId:row.id,mode:'reverify'});
  assert.equal(h.called('agent.launch').length,2,'a finished re-verify on older code lets the changed code be re-verified');
  const failing = host({handlers:{'agent.launch':async()=>{throw new Error('host lost');}}});
  await saveNote(failing);
  failing.setCurrent(stale);
  await assert.rejects(failing.service.resume({workspaceId:row.id,mode:'reverify'}),throwsCode('launch_uncertain'));
  await assert.rejects(failing.service.resume({workspaceId:row.id,mode:'reverify'}),throwsCode('launch_uncertain'));
  assert.equal(failing.called('agent.launch').length,1);
  const snapshot = await failing.service.snapshot();
  assert.deepEqual({mode:snapshot.notes[0].launch.mode,status:snapshot.notes[0].launch.status},{mode:'reverify',status:'uncertain'});
});

test('a note shows the start that still blocks: an uncertain continue outranks a newer re-verify', async () => {
  const failing = host({handlers:{'agent.launch':async()=>{throw new Error('host lost');}}});
  await saveNote(failing);
  await assert.rejects(failing.service.resume({workspaceId:row.id}),throwsCode('launch_uncertain'));
  const data = failing.stored();
  data.resumes.push({id:'r2',workspaceId:row.id,noteId:data.notes[0].id,sessionId:null,agent:'codex',mode:'reverify',hash:'two',status:'started',at:new Date(NOW+1000).toISOString(),terminalId:'t2'});
  const h = host({stored:data});
  const snapshot = await h.service.snapshot();
  assert.deepEqual({mode:snapshot.notes[0].launch.mode,status:snapshot.notes[0].launch.status},{mode:'next',status:'uncertain'});
});
