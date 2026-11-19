/**
 * Local UI development server. All bridge actions use synthetic in-memory state.
 * No Orca agent, Google API, credentials, or real project is touched.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRun, claimNode, recordLaunch, pauseRun, resumeRun, cancelRun } from '../src/engine.mjs';
import { dayKey, previousDay } from '../src/today.mjs';

if(process.argv.includes('--start')) {
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--serve'],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
  const timer=setTimeout(()=>{child.kill();console.error('Preview did not start.');process.exit(1);},8000);
  child.once('message',message=>{clearTimeout(timer);console.log(JSON.stringify(message));child.disconnect();child.unref();});
  child.once('error',error=>{clearTimeout(timer);console.error(error.message);process.exitCode=1;});
} else {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const stamp=Date.now(),date=dayKey(stamp),yesterdayDate=previousDay(date);
  let sample=createRun({id:'preview-demo',goal:'달빛 습관 · 하루 5분 루틴 앱',projectId:'preview-project',maxConcurrency:2,now:stamp-86400000});
  const roles={research:'grok',brief:'codex',architecture:'codex',design:'cursor',assets:'gemini',build:'codex',test:'claude',policy:'claude',listing:'grok',internal:'codex',release:'codex'};
  for(const node of sample.nodes) {
    node.agent=roles[node.id];node.reviewer='claude';
    if(['research','brief','architecture','design','assets'].includes(node.id)) {
      node.status='passed';node.attempts=1;node.reviewAttempts=1;
      node.report={outcome:'passed',summary:'개발 미리보기용 예시 보고서입니다.',evidence:[{kind:'artifact',path:'preview/example.md'}]};
      node.review={outcome:'passed',summary:'실제 검증 결과가 아닌 화면 확인용 샘플입니다.',evidence:[]};
    }
  }
  sample.workspaceId='preview-workspace';sample.workspacePath='/example/moon-habit';sample.started=true;
  sample=claimNode(sample,'build',{phase:'work',nonce:'preview-nonce',now:stamp-600000});
  sample=recordLaunch(sample,'build',{nonce:'preview-nonce',terminalId:'preview-terminal',workspaceId:'preview-workspace',now:stamp-600000});
  sample.jobs=[{nodeId:'build',nonce:'preview-nonce',terminalId:'preview-terminal',state:'running'}];
  const workspaces=[{id:'preview-workspace',projectId:'preview-project',name:'달빛 습관',project:'moon-habit',path:'/example/moon-habit',hostId:'local',kind:'worktree',branch:'neon/preview'}];
  const state={version:1,runs:[sample],archivedRuns:[],projects:[{id:'preview-project',name:'moon-habit',kind:'git',hostId:'local',path:'/example/moon-habit'}],workspaces,context:{workspaceId:'preview-workspace',displayName:'달빛 습관',branch:'neon/preview',terminals:[]},providers:['codex','claude','cursor','grok','antigravity','gemini','opencode','kiro'],agents:[{terminalId:'preview-terminal',agent:'codex',title:'앱 구현 · 데모',state:'working',stateStartedAt:stamp-600000}],warnings:[]};
  const note={workspaceId:'preview-workspace',projectName:'moon-habit',state:'온보딩과 습관 카드 디자인을 정리했습니다.',next:'루틴 타이머를 구현하고 화면 전환을 확인합니다.',why:'설계 검토를 마치고 구현 단계로 넘어갔습니다.',hold:'알림 시간 기본값',verified:'미리보기 데이터 · 실제 테스트 결과 아님',at:new Date(stamp-86400000).toISOString(),day:yesterdayDate,verificationFreshness:'fresh'};
  const today={date,yesterdayDate,timeZone:'Asia/Seoul',notes:[note],todayEvents:[{at:new Date(stamp-600000).toISOString(),summary:'앱 구현 단계에 Codex를 배정했습니다. (샘플)',goal:sample.goal}],yesterdayEvents:[{at:note.at,summary:'화면 설계 검토가 끝났습니다. (샘플)',goal:sample.goal}],lastActiveDay:yesterdayDate,worklogs:[],sessions:[],warnings:[]};
  const accounts=[{id:'preview-account',name:'샘플 개발자 계정',packages:[],tracks:['production','internal'],hasCredential:false,checkedAt:new Date(stamp).toISOString(),discovery:{observedAt:new Date(stamp).toISOString(),stale:false},apps:[{packageName:'com.example.moonhabit',name:'달빛 습관 (미리보기)',status:'in_review',published:true,needsAttention:true,storeUrl:'https://play.google.com/store/apps/details?id=com.example.moonhabit',tracks:[{track:'production',observedAt:new Date(stamp).toISOString(),stale:false,releases:[{name:'0.9.0',versionCodes:['9'],state:'published'},{name:'1.0.0',versionCodes:['10'],state:'in_review'}]},{track:'internal',observedAt:new Date(stamp-86400000).toISOString(),stale:true,error:{message:'429 · 미리보기용 API 제한 상태'},releases:[{name:'1.0.1',versionCodes:['11'],state:'published'}]}]}]}];
  const lookup=id=>{const value=state.runs.find(r=>r.id===id);if(!value)throw Error('Unknown preview run');return value;};
  const replace=value=>{state.runs[state.runs.findIndex(r=>r.id===value.id)]=value;return value;};
  const rpc=async(name,input)=>{
    if(name==='state.get')return state;
    if(name==='today.snapshot')return today;
    if(name==='play.list')return {version:1,protection:{status:'os-keyring'},accounts};
    if(name==='runs.create') {const run=createRun({...input,id:randomUUID()});run.jobs=[];state.runs.unshift(run);return run;}
    if(name==='runs.pause')return replace(pauseRun(lookup(input.runId)));
    if(name==='runs.resume')return replace(resumeRun(lookup(input.runId)));
    if(name==='runs.cancel')return replace(cancelRun(lookup(input.runId)));
    if(name==='runs.start'){const run=lookup(input.runId);run.workspaceId='preview-workspace';run.workspacePath='/example/moon-habit';return run;}
    if(name==='runs.refresh')return lookup(input.runId);
    if(name==='runs.updateAssignments'){const run=lookup(input.runId);for(const [id,value] of Object.entries(input.assignments))Object.assign(run.nodes.find(n=>n.id===id),value);return run;}
    if(name==='today.save'){const value={...input,projectName:'moon-habit',at:new Date().toISOString(),day:date,verificationFreshness:'unknown'};today.notes.unshift(value);return value;}
    if(name==='play.check')return accounts.find(a=>a.id===input.accountId);
    if(name.startsWith('play.account.'))throw Error('미리보기에서는 실제 계정과 키를 저장하지 않습니다.');
    return {preview:true};
  };
  const banner='<div style="background:#312642;color:#e4d5ff;font:11px system-ui;padding:7px 14px;text-align:center" role="note">UI 개발 미리보기 · 샘플 데이터 · 실제 에이전트와 Play API는 실행하지 않습니다.</div>';
  const bridge="window.orca={plugin:{request:async(name,input)=>{const r=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,input})});const body=await r.json();if(!r.ok)throw Error(body.error);return body;},on:()=>({dispose(){}})},shell:{openExternal:async()=>({opened:false})}};";
  const server=http.createServer(async(req,res)=>{
    try {
      const pathname=new URL(req.url,'http://localhost').pathname;
      if(req.method==='POST'&&pathname==='/__stop'){res.end('stopped');server.close();return;}
      if(req.method==='POST'&&pathname==='/rpc'){
        let body='';for await(const chunk of req){body+=chunk;if(body.length>100000)throw Error('Request too large');}
        const input=JSON.parse(body),result=await rpc(input.name,input.input??{});
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
      }
      if(req.method!=='GET') {res.writeHead(405);res.end();return;}
      const files={'/':'panel/index.html','/studio.css':'panel/studio.css','/graph.css':'panel/graph.css','/studio.mjs':'panel/studio.mjs'};
      if(!files[pathname]){res.writeHead(404);res.end('Not found');return;}
      let content=await fs.readFile(path.join(root,files[pathname]),'utf8');
      if(pathname==='/')content=content.replace('<body>','<body>'+banner+'<script>'+bridge+'</script>');
      res.setHeader('Content-Type',pathname.endsWith('.css')?'text/css':pathname.endsWith('.mjs')?'text/javascript':'text/html');
      res.setHeader('Cache-Control','no-store');res.end(content);
    }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });
  server.listen(0,'127.0.0.1',()=>{
    const details={url:'http://127.0.0.1:'+server.address().port,mode:'synthetic-ui-preview',pid:process.pid};
    if(process.send)process.send(details);else console.log(JSON.stringify(details));
  });
  // This development preview is short-lived; no background service is installed.
  setTimeout(()=>server.close(),30*60*1000).unref();
}
