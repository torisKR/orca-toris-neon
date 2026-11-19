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
    getState:()=>{getStateCalls++;return structuredClone(state);},
    now:()=>clock,
    inspect:async()=>structuredClone(current),
    readLogs:async()=>structuredClone(options.logs??[]),
  });
  return {
    service,calls,values,orca,
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
