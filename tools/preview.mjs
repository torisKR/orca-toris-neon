/**
 * Local UI development server. All bridge actions use synthetic in-memory state.
 * No Orca agent, Google API, credentials, or real project is touched.
 * Import createPreviewModel() to inspect fixtures without starting a server.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRun, claimNode, recordLaunch, applyReport, pauseRun, resumeRun, cancelRun, templateGraph } from '../src/engine.mjs';
import { dayKey, previousDay } from '../src/today.mjs';
import { projectState } from '../src/views.mjs';
import { deflateSync, crc32 } from 'node:zlib';

const PREVIEW_STAMP = Date.parse('2026-11-19T05:00:00.000Z');
const clone = value => structuredClone(value);
const projectsSample = [
  ['moon-habit','달빛 습관'], ['quiet-notes','고요 메모'], ['one-bite','한입 레시피'],
  ['afternoon-walk','오후 산책'], ['green-water','초록 물주기'], ['pocket-budget','작은 가계부'],
  ['daily-sentence','하루 문장'], ['star-reading','별빛 독서'], ['one-page','한 장 일기'],
  ['focus-timer','집중 타이머'], ['stretch-day','오늘 스트레칭'], ['bookshelf','책장 정리'],
  ['cloud-weather','구름 날씨'], ['mood-check','마음 체크'],
];
const roles = {research:'grok',brief:'codex',architecture:'codex',design:'cursor',assets:'gemini',build:'codex',test:'claude',policy:'claude',listing:'grok',internal:'codex',release:'codex'};
const iso = stamp => new Date(stamp).toISOString();

// The same summary projection Orca pushes (limits, waiting reasons, cleanup included).
const compactState = state => projectState(state, 'summary');
function fillPassed(node, stamp, prefix) {
  node.status='passed';node.attempts=1;node.reviewAttempts=1;
  node.report={outcome:'passed',summary:'미리보기 자료 · 실제 작업이나 검증 결과가 아닙니다.',
    evidence:[{kind:'artifact',path:prefix+'/'+node.id+'/example.md'},{kind:'artifact',path:prefix+'/'+node.id+'/notes.md'}]};
  node.review={outcome:'passed',summary:'화면 검토를 위한 독립 검토 예시입니다.',
    evidence:[{kind:'artifact',path:prefix+'/'+node.id+'/review.md'}]};
  node.receipt={path:prefix+'/'+node.id+'/result.json',at:iso(stamp),phase:'review',
    artifacts:[{path:prefix+'/'+node.id+'/review.md',size:128,sha256:'preview-only'}]};
  node.history=Array.from({length:3},(_,index)=>({at:iso(stamp-(3-index)*60000),type:'preview',summary:'샘플 단계 이력 '+(index+1)}));
}

export function createPreviewModel({ liveAt = PREVIEW_STAMP } = {}) {
  const stamp=PREVIEW_STAMP,date=dayKey(stamp),yesterdayDate=previousDay(date);
  let sequence=0,clockStep=0;
  const tick=()=>stamp+(++clockStep)*60000;
  const projects=projectsSample.map(([slug,label],index)=>({id:index?'preview-project-'+(index+1):'preview-project',name:slug,displayName:label,kind:'git',hostId:'local',path:'/example/'+slug}));
  const workspaces=projects.map((project,index)=>({id:index?'preview-workspace-'+(index+1):'preview-workspace',
    projectId:project.id,name:projectsSample[index][1],project:project.name,path:project.path,
    hostId:'local',kind:'worktree',branch:'neon/preview-'+(index+1)}));
  let sample=createRun({id:'preview-demo',goal:'달빛 습관 · 하루 5분 루틴 앱',projectId:'preview-project',maxConcurrency:2,now:stamp-86400000});
  for(const node of sample.nodes) {
    node.agent=roles[node.id];node.reviewer='claude';
    if(['research','brief','architecture','design','assets'].includes(node.id)) fillPassed(node,stamp-3600000,'preview/demo');
  }
  sample.workspaceId='preview-workspace';sample.workspacePath='/example/moon-habit';sample.started=true;
  sample=claimNode(sample,'build',{phase:'work',nonce:'preview-nonce',now:liveAt-74000});
  sample=recordLaunch(sample,'build',{nonce:'preview-nonce',terminalId:'preview-terminal',workspaceId:'preview-workspace',now:liveAt-74000});
  sample.jobs=sample.nodes.filter(node=>node.status==='passed').map(node=>({nodeId:node.id,nonce:'preview-finished-'+node.id,terminalId:'preview-finished-'+node.id,state:'completed'}));
  sample.jobs.push({nodeId:'build',nonce:'preview-nonce',terminalId:'preview-terminal',state:'running',agent:'codex'});

  const archivedRuns=Array.from({length:3},(_,index)=>{
    const run=createRun({id:'preview-archive-'+(index+1),goal:projectsSample[index+1][1]+' · 이전 작업 샘플',
      projectId:projects[index+1].id,now:stamp-(index+2)*86400000});
    run.workspaceId=workspaces[index+1].id;run.workspacePath=workspaces[index+1].path;
    run.status=index===1?'cancelled':'completed';run.started=true;
    run.updatedAt=iso(stamp-(index+1)*3600000);run.archivedAt=run.updatedAt;
    const passed=index===1?6:run.nodes.length;
    for(const [position,node] of run.nodes.entries()) {
      node.agent=roles[node.id];node.reviewer='claude';
      if(position<passed)fillPassed(node,stamp-(index+1)*3600000,'preview/archive-'+(index+1));
    }
    run.jobs=run.nodes.filter(node=>node.status==='passed').map(node=>({nodeId:node.id,nonce:'preview-archive-'+index+'-'+node.id,state:'completed'}));
    return run;
  });
  const improved=improvementSample(stamp),diagnosed=diagnosisSample(stamp);
  const state={version:1,revision:1,build:{label:'v0.2.0 · preview · 개발 폴더'},runs:[sample,improved,diagnosed],archivedRuns,projects,workspaces,
    context:{workspaceId:'preview-workspace',displayName:'달빛 습관',branch:'neon/preview-1',terminals:[]},
    providers:['codex','claude','cursor','grok','antigravity','gemini','opencode','kiro'],
    agents:[{terminalId:'preview-terminal',agent:'codex',title:'앱 구현 · 데모',state:'working',stateStartedAt:liveAt-74000}],warnings:[]};
  const notes=workspaces.map((workspace,index)=>({
    id:'preview-note-'+(index+1),workspaceId:workspace.id,projectName:workspace.project,
    state:workspace.name+'의 '+['화면 구조와 입력 상태를 정리했습니다.','테스트 범위와 다음 수정 항목을 정리했습니다.','MVP 범위와 보류할 기능을 정했습니다.'][index%3],
    next:['주요 화면을 연결하고 전환 상태를 확인합니다.','오류 상황을 재현하고 필요한 테스트를 추가합니다.','핵심 기능을 구현하고 독립 검토를 요청합니다.'][index%3],
    why:'미리보기용 인계 기록입니다.',hold:['알림 시간 기본값','오프라인 저장 정책','첫 화면 안내 문구'][index%3],
    verified:index%3===2?'':'미리보기 데이터 · 실제 테스트 결과 아님',
    at:iso(stamp-86400000-index*1200000),day:yesterdayDate,verificationFreshness:['fresh','stale','unknown'][index%3],
  }));
  const allRuns=[sample,...archivedRuns];
  const eventTitles=['제품 목표와 완료 기준을 정리했습니다.','화면 설계 검토를 마쳤습니다.','구현 작업에 담당자를 배정했습니다.','테스트 결과와 남은 일을 정리했습니다.','다음 단계의 준비 범위를 확인했습니다.'];
  const todayEvents=Array.from({length:20},(_,index)=>{
    const run=allRuns[index%allRuns.length];
    return {id:'preview-today-event-'+(index+1),at:iso(stamp-index*900000),day:date,type:'runtime',
      summary:eventTitles[index%eventTitles.length]+' (샘플)',goal:run.goal,runId:run.id,nodeId:['brief','design','build','test','internal'][index%5]};
  });
  const yesterdayEvents=Array.from({length:8},(_,index)=>{
    const run=allRuns[index%allRuns.length];
    return {id:'preview-yesterday-event-'+(index+1),at:iso(stamp-86400000-index*1800000),day:yesterdayDate,type:'runtime',
      summary:eventTitles[(index+1)%eventTitles.length]+' (샘플)',goal:run.goal,runId:run.id};
  });
  for(const run of allRuns)run.events=[...yesterdayEvents,...todayEvents].filter(event=>event.runId===run.id).sort((a,b)=>a.at.localeCompare(b.at));
  const today={date,yesterdayDate,timeZone:'Asia/Seoul',notes,todayEvents,yesterdayEvents,undatedEvents:[],lastActiveDay:yesterdayDate,
    worklogs:[{project:'moon-habit',day:yesterdayDate,sourcePath:'/example/journal/moon-habit/'+yesterdayDate+'.md',
      text:'# 미리보기 일지\n\n이 문서는 실제 파일에서 읽은 기록이 아닙니다.\n화면 설계와 다음 구현 범위를 보여 주기 위한 고정 샘플입니다.'}],
    sessions:[{sessionId:'preview-session-1',workspaceId:'preview-workspace',agent:'codex',title:'루틴 타이머 설계 · 샘플',updatedAt:iso(stamp-86400000),messageCount:12},
      {sessionId:'preview-session-2',workspaceId:'preview-workspace-2',agent:'claude',title:'메모 편집 흐름 검토 · 샘플',updatedAt:iso(stamp-90000000),messageCount:8}],
    sessionsTruncated:false,warnings:[]};
  const accounts=[{id:'preview-account',name:'샘플 개발자 계정',developerId:'1000000000000000000',packages:['com.example.moonhabit'],tracks:['production','internal'],hasCredential:false,
    checkedAt:iso(stamp),discovery:{observedAt:iso(stamp),stale:false},apps:[{packageName:'com.example.moonhabit',name:'달빛 습관 (미리보기)',
      status:'in_review',published:true,needsAttention:true,storeUrl:'https://play.google.com/store/apps/details?id=com.example.moonhabit',
      tracks:[{track:'production',observedAt:iso(stamp),stale:false,releases:[{name:'0.9.0',versionCodes:['9'],state:'published'},{name:'1.0.0',versionCodes:['10'],state:'in_review'}]},
        {track:'internal',observedAt:iso(stamp-86400000),stale:true,error:{message:'429 · 미리보기용 API 제한 상태'},releases:[{name:'1.0.1',versionCodes:['11'],state:'published'}]}]}]}];

  const lookup=(id,archived=false)=>{
    const value=state.runs.find(run=>run.id===id)||(archived?state.archivedRuns.find(run=>run.id===id):null);
    if(!value)throw Error('미리보기 실행을 찾을 수 없습니다.');
    return value;
  };
  const changed=value=>{state.revision++;return value;};
  const replace=value=>{state.runs[state.runs.findIndex(run=>run.id===value.id)]=value;return changed(value);};
  const snapshot=input=>{
    const view=input.view??'full';
    if(view==='full')return state;
    if(view!=='summary')throw Error('지원되지 않는 미리보기 조회 형식입니다.');
    return {...state,...compactState(state)};
  };
  const todaySnapshot=input=>{
    const requestedDate=input.date??date,previous=previousDay(requestedDate);
    const offset=input.noteOffset??0,limit=input.noteLimit??today.notes.length;
    if(!Number.isSafeInteger(offset)||offset<0||
      (input.noteLimit!==undefined&&(!Number.isSafeInteger(limit)||limit<1||limit>100)))throw Error('인계 목록의 시작 위치는 0 이상, 페이지 크기는 1–100 정수여야 합니다.');
    const selected=today.notes.slice(offset,offset+limit),events=[...today.todayEvents,...today.yesterdayEvents];
    return {...today,date:requestedDate,yesterdayDate:previous,notes:selected,
      notesPage:{offset,limit,total:today.notes.length,hasMore:offset+selected.length<today.notes.length},
      todayEvents:events.filter(event=>event.day===requestedDate),yesterdayEvents:events.filter(event=>event.day===previous),
      worklogs:today.worklogs.filter(log=>[requestedDate,previous].includes(log.day)),
      lastActiveDay:[...new Set(events.map(event=>event.day))].sort().reverse().find(day=>day<requestedDate)??null,
      sessions:input.workspaceId?today.sessions.filter(session=>session.workspaceId===input.workspaceId):today.sessions};
  };
  const scenarioBase=clone(sample);
  // Drive the same engine states the panel receives from Orca, with synthetic reports only.
  function scenario(name) {
    let run=clone(scenarioBase),eventAt=liveAt-48000;
    const start=(id,phase,nonce)=>{
      eventAt+=3000;
      run=claimNode(run,id,{phase,nonce,now:eventAt});
      run=recordLaunch(run,id,{nonce,terminalId:'preview-'+nonce,workspaceId:run.workspaceId,now:eventAt});
      run.jobs.push({nodeId:id,nonce,terminalId:'preview-'+nonce,state:'running',promptSeen:true});
    };
    const report=(nodeId,outcome,summary)=>{
      const {nonce,phase}=run.nodes.find(node=>node.id===nodeId).active;
      eventAt+=3000;
      run=applyReport(run,nodeId,{runId:run.id,nodeId,nonce,phase,outcome,summary,
        evidence:[{kind:'note',text:'미리보기 전용 근거'}]},{now:eventAt});
    };
    if(name==='idle') {
      run=cancelRun(run,{now:liveAt});
    } else if(name!=='work') {
      report('build','passed','구현 결과와 빌드 근거를 검토자에게 넘겼습니다.');
      if(name!=='queued')start('build','review','build-review');
      if(name==='return') {
        report('build','failed','저장 실패 후 재시도 경로를 추가해 주세요.');
        start('build','work','build-repair');
      }
      if(name==='qa') {
        report('build','passed','구현 검토를 통과했습니다.');
        start('test','work','test-work');
        report('test','passed','재시작 복원 테스트를 검토자에게 넘겼습니다.');
        start('test','review','test-review');
        report('test','failed','앱 재시작 시 마지막 저장 값이 복원되지 않습니다.');
        start('build','work','qa-repair');
      }
    }
    return replace(run);
  }
  const dispatch=async(name,input)=>{
    if(name==='preview.scenario') {
      if(!['work','queued','review','return','qa','idle'].includes(input.scenario))throw Error('지원되지 않는 미리보기 상태입니다.');
      return scenario(input.scenario);
    }
    if(name==='state.get')return snapshot(input);
    if(name==='runs.get')return lookup(input.runId,true);
    if(name==='today.snapshot')return todaySnapshot(input);
    if(name==='play.list')return {version:1,protection:{status:'os-keyring'},accounts};
    if(name==='play.submissionAccounts')return accounts.map(({id,name,developerId})=>({id,name,developerId}));
    if(name==='artifacts.read')return previewArtifact(input.path);
    if(name==='runs.create') {
      const template=input.fromDiagnosis?'improve':input.template??'new-app',kind=input.fromDiagnosis?'bugfix':input.kind;
      const run=createRun({goal:input.goal??'미리보기 진단',projectId:input.projectId??'preview-project-5',nodes:templateGraph(template,{kind,...input.options}),id:'preview-created-'+(++sequence),now:tick()});
      if(template!=='new-app')Object.assign(run,{template,parentRunId:input.parentRunId??input.fromDiagnosis?.runId,improvement:{kind,options:input.options??{},projectName:input.projectId,playLink:null}});
      run.jobs=[];state.runs.unshift(run);return changed(run);
    }
    if(name==='runs.pause')return replace(pauseRun(lookup(input.runId),{now:tick()}));
    if(name==='runs.resume')return replace(resumeRun(lookup(input.runId),{now:tick()}));
    if(name==='runs.cancel')return replace(cancelRun(lookup(input.runId),{now:tick()}));
    if(name==='runs.start'){
      const run=lookup(input.runId),workspace=workspaces.find(row=>row.projectId===run.projectId)??workspaces[0];
      run.workspaceId=workspace.id;run.workspacePath=workspace.path;
      run.started=true;run.updatedAt=iso(tick());return changed(run);
    }
    if(name==='runs.refresh')return lookup(input.runId);
    if(name==='runs.updateAssignments'){
      const run=lookup(input.runId);
      for(const [id,value]of Object.entries(input.assignments??{})){
        const node=run.nodes.find(entry=>entry.id===id);
        if(node)Object.assign(node,value);
      }
      run.updatedAt=iso(tick());return changed(run);
    }
    if(name==='runs.archive'){
      const run=lookup(input.runId);
      if(!['cancelled','completed'].includes(run.status))throw Error('완료하거나 취소한 미리보기 실행만 보관할 수 있습니다.');
      const archivedRun={...run,archivedAt:iso(tick())};
      state.runs=state.runs.filter(entry=>entry.id!==run.id);state.archivedRuns.push(archivedRun);
      return changed({archived:true,runId:run.id,archivedRun});
    }
    if(name==='today.save'){
      const workspace=workspaces.find(row=>row.id===input.workspaceId);
      if(!workspace||!String(input.state??'').trim()||!String(input.next??'').trim())throw Error('작업 공간, 진행 내용과 다음 행동을 입력하세요.');
      const at=iso(tick()),value={id:'preview-note-saved-'+(++sequence),workspaceId:workspace.id,projectName:workspace.project,
        state:String(input.state).slice(0,4000),next:String(input.next).slice(0,4000),why:String(input.why??'').slice(0,4000),
        hold:String(input.hold??'').slice(0,4000),verified:String(input.verified??'').slice(0,4000),at,day:date,verificationFreshness:'unknown'};
      today.notes=[value,...today.notes.filter(note=>note.workspaceId!==workspace.id)];
      today.todayEvents.unshift({id:'preview-handoff-'+sequence,at,day:date,type:'handoff.saved',summary:value.state,next:value.next,projectName:value.projectName,workspaceId:workspace.id});
      return value;
    }
    if(name==='play.check')return accounts.find(account=>account.id===input.accountId);
    if(name.startsWith('play.account.'))throw Error('미리보기에서는 실제 계정과 키를 저장하지 않습니다.');
    return {preview:true};
  };
  return {rpc:async(name,input={})=>clone(await dispatch(name,input)),
    compact:()=>clone(compactState(state)),revision:()=>state.revision};
}

// A synthetic phone screen, drawn here so the preview never reads a real file.
function previewPng(variant) {
  const width=180,height=320,rows=[];
  for(let y=0;y<height;y++){
    const row=[0];
    for(let x=0;x<width;x++){
      let color=[24,28,36];
      if(y<44)color=variant==='mockup'?[70,60,110]:[46,125,92];
      else if(y>60&&(y-60)%52<40&&x>12&&x<168)color=(y-60)/52<1&&variant!=='mockup'?[64,160,120]:[44,50,62];
      if(variant==='mockup'&&(x+y)%23===0)color=[120,110,170];
      row.push(...color);
    }
    rows.push(Buffer.from(row));
  }
  const chunk=(type,data)=>{const head=Buffer.alloc(8);head.writeUInt32BE(data.length);head.write(type,4);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type),data])));return Buffer.concat([head,data,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header.set([8,2,0,0,0],8);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))]);
}
function previewArtifact(file) {
  if(/\.png$/.test(file)){const data=previewPng(/mock/.test(file)?'mockup':'screenshot');return {kind:'image',mime:'image/png',size:data.length,data:data.toString('base64')};}
  return {kind:'text',size:2048,text:'> Task :app:testDebugUnitTest\nNotificationSchedulerTest > schedulesOnce PASSED\nBUILD SUCCESSFUL in 41s (미리보기 로그)',truncated:false};
}
function improvementSample(stamp) {
  const run=createRun({id:'preview-improve',goal:'초록 물주기 · 같은 알림이 두 번 울리는 문제 고치기',projectId:'preview-project-5',now:stamp-7200000,nodes:templateGraph('improve',{kind:'bugfix'})});
  Object.assign(run,{template:'improve',started:true,status:'completed',workspaceId:'preview-workspace-5',workspacePath:'/example/green-water',jobs:[],
    improvement:{kind:'bugfix',options:{design:false,payments:false},projectName:'green-water',playLink:null}});
  for(const node of run.nodes){node.agent='codex';node.reviewer='claude';fillPassed(node,stamp-3600000,'preview/improve');}
  const dir='/example/receipts/preview-improve/build/1-work-n';
  Object.assign(run.nodes.find(node=>node.id==='build').report,{summary:'알림 예약 중복을 없앴습니다. (미리보기 자료)',
    changes:['앱 재시작 때 NotificationScheduler가 이미 예약된 알림을 다시 예약하지 않습니다.','알림 ID를 식물 ID에서 만들도록 바꿨습니다.'],
    criteria:[{criterion:'같은 시각에 알림이 한 번만 울린다',met:true,evidence:'NotificationSchedulerTest.schedulesOnce'},{criterion:'기존 사용자의 알림 설정이 유지된다',met:true,evidence:'업그레이드 테스트'},{criterion:'Android 9 실기기에서 확인',met:false}],
    beforeAfter:[{label:'재시작 후 예약된 알림 수',before:'2',after:'1'},{label:'단위 테스트',before:'41개',after:'43개'}],
    notVerified:['Android 9 실기기에서의 알림 표시'],
    evidence:[{kind:'command',command:'./gradlew testDebugUnitTest',exitCode:0},{kind:'command',command:'./gradlew testDebugUnitTest (수정 전)',exitCode:1,role:'history'},
      {kind:'artifact',path:dir+'/after.png',label:'screenshot'},{kind:'artifact',path:dir+'/mock-settings.png',label:'mockup'},{kind:'artifact',path:dir+'/build.log'}]});
  return run;
}
function diagnosisSample(stamp) {
  const run=createRun({id:'preview-diagnose',goal:'고요 메모 진단: 근거 있는 개선 후보 찾기',projectId:'preview-project-2',now:stamp-5400000,nodes:templateGraph('diagnose')});
  Object.assign(run,{template:'diagnose',started:true,status:'completed',workspaceId:'preview-workspace-2',workspacePath:'/example/quiet-notes',jobs:[],
    improvement:{kind:null,options:{},projectName:'quiet-notes',playLink:null}});
  for(const node of run.nodes){node.agent='claude';node.reviewer='codex';fillPassed(node,stamp-1800000,'preview/diagnose');}
  run.nodes.find(node=>node.id==='diagnose').report.candidates=[
    {kind:'performance',title:'첫 실행이 3초 넘게 걸림',problem:'메모 전체를 시작 시점에 읽습니다.',evidence:'콜드 스타트 3.4초 (Pixel 6, 5회 평균)',impact:'첫 화면 이탈',scope:'MemoRepository 초기 로딩',verify:'같은 기기에서 콜드 스타트 재측정'},
    {kind:'bugfix',title:'긴 메모 저장 시 마지막 줄 유실',problem:'4,000자 이상에서 잘립니다.',evidence:'재현 테스트 실패 로그',impact:'사용자 데이터 손실',scope:'MemoEditor 저장 경로',verify:'4,000자 메모 저장 후 재열기 테스트'},
    {kind:'design',title:'다크 모드 대비 부족',problem:'본문 대비 3.1:1',evidence:'대비 측정 스크린샷',impact:'읽기 어려움',scope:'테마 색상',verify:'대비 4.5:1 이상 측정'}];
  return run;
}

const banner='<div style="background:#312642;color:#e4d5ff;font:11px system-ui;padding:7px 14px;text-align:center" role="note">UI 개발 미리보기 · 샘플 데이터 · 실제 에이전트와 Play API는 실행하지 않습니다.</div>';
const bridge=`(()=>{
  const listeners=new Map();let eventRevision=0;
  const notify=async()=>{
    const response=await fetch('/__state');if(!response.ok)return;
    const state=await response.json();if(state.revision<=eventRevision)return;
    eventRevision=state.revision;
    for(const listener of listeners.get('state.changed')??[])queueMicrotask(()=>listener(structuredClone(state)));
  };
  window.orca={plugin:{
    request:async(name,input)=>{
      const response=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,input})});
      const body=await response.json();if(!response.ok)throw Error(body.error);
      if(response.headers.get('X-Preview-State-Changed')==='1')void notify().catch(()=>{});
      return body;
    },
    on:(name,listener)=>{
      if(!listeners.has(name))listeners.set(name,new Set());
      listeners.get(name).add(listener);return {dispose(){listeners.get(name)?.delete(listener);}};
    }
  },shell:{openExternal:async()=>({opened:false})}};
})();`;

function servePreview() {
  const root=fileURLToPath(new URL('../',import.meta.url)),model=createPreviewModel({ liveAt: Date.now() });
  const server=http.createServer(async(req,res)=>{
    try {
      const {pathname,searchParams}=new URL(req.url,'http://localhost');
      res.setHeader('Cache-Control','no-store');
      if(req.method==='POST'&&pathname==='/__stop'){res.end('stopped');server.close();return;}
      if(req.method==='GET'&&pathname==='/__state'){
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(model.compact()));return;
      }
      if(req.method==='POST'&&pathname==='/rpc'){
        let body='';for await(const chunk of req){body+=chunk;if(body.length>100000)throw Error('Request too large');}
        const input=JSON.parse(body),before=model.revision(),result=await model.rpc(input.name,input.input??{});
        res.setHeader('Content-Type','application/json');
        res.setHeader('X-Preview-State-Changed',model.revision()>before?'1':'0');
        res.end(JSON.stringify(result));return;
      }
      if(req.method!=='GET'){res.writeHead(405);res.end();return;}
      // The panel's own files only: index.html plus flat panel/*.css|*.mjs names.
      const file=pathname==='/'?'panel/index.html':/^\/[\w-]+\.(css|mjs)$/.test(pathname)?'panel'+pathname:null;
      if(!file){res.writeHead(404);res.end('Not found');return;}
      let content;
      try{content=await fs.readFile(path.join(root,file),'utf8');}
      catch(error){if(error.code!=='ENOENT')throw error;res.writeHead(404);res.end('Not found');return;}
      if(pathname==='/') {
        if(searchParams.get('theme')==='light')content=content.replace('<html lang="ko" class="dark">','<html lang="ko" class="light">');
        content=content.replace('<body>','<body>'+banner+'<script>'+bridge+'</script>');
      }
      res.setHeader('Content-Type',pathname.endsWith('.css')?'text/css':pathname.endsWith('.mjs')?'text/javascript':'text/html');res.end(content);
    }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });
  server.listen(0,'127.0.0.1',()=>{
    const details={url:'http://127.0.0.1:'+server.address().port,mode:'synthetic-ui-preview',pid:process.pid};
    if(process.send)process.send(details);else console.log(JSON.stringify(details));
  });
  // This development preview is short-lived; no background service is installed.
  setTimeout(()=>server.close(),30*60*1000).unref();
}

// Importing the fixture model must never start a server or spawn a process.
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--start')){
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--serve'],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
    const timer=setTimeout(()=>{child.kill();console.error('Preview did not start.');process.exit(1);},8000);
    child.once('message',message=>{clearTimeout(timer);console.log(JSON.stringify(message));child.disconnect();child.unref();});
    child.once('error',error=>{clearTimeout(timer);console.error(error.message);process.exitCode=1;});
  }else servePreview();
}
