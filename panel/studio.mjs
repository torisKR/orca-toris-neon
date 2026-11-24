import { e, statusNames, badge, localDate, todayDate, title, button, options, goalTitle } from './kit.mjs';
import { flowTypeSwitch, improveFields, diagnoseFields, resumeList, candidateList, newRunPayload, catalogApprovalForm, catalogApprovalInput } from './newflow.mjs';
import { transitions, snapshotStates, elapsed, eccOverride, stageState, STATE_LABELS } from './teams.mjs';
import { collabStrip, relay, inspector, attachCard, people, assignmentForm, teamNavigator } from './flow.mjs';
import { runResult, artifactCacheKey, artifactId } from './result.mjs';
import { runTokens } from './tokens.mjs';
import { preflightBlock, preflightSummary } from './preflight.mjs';
import { todayRunCard, noteAction } from './todayactions.mjs';
import { playLinkBlock, linkKey } from './playlinks.mjs';
import { operationsOverview, runOperationsLine, diskBlock, diskSummary } from './operations.mjs';
import { exportControls, exportHistory } from './history.mjs';
const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const bridge = window.orca;
const ui = {tab:'today',state:null,today:null,play:null,runId:null,nodeId:null,agentRole:null,accountId:null,newRun:false,newAccount:false,error:null,busy:false,drafts:{},day:'yesterday',feedLimit:8,sessionLimit:12,archiveId:null,notesBusy:false,pendingUpdate:false,artifacts:new Map(),cancelling:new Set(),internal:new Map(),exportConfirm:null};
const playFilters = {query:'',status:'all'};
let submissionAccounts = [];
const details = new Map();
const preflights = new Map(); // runId -> {loading, value, error}: 실행 전 점검 (panel/preflight.mjs)
const disks = new Map(); // runId -> {loading, value, error}: 디스크 사용량, fetched only when asked (panel/operations.mjs)
let preflightShown = null;
const detailRequests = new Map();
const dirtyForms = new Set();
const disclosures = new Set();
const stageSnapshots = new Map(), stageMotions = new Map();
const MOTION_MS = 700;
let navigation = 0, renderPending = false, detailPending = false, refreshPromise = null, refreshQueued = false, hostRefreshQueued = false;
const revision = () => ui.state?.revision ?? 0;
const playStatus = {
  rejected:{label:'거부됨',priority:0,action:true},
  not_sent_for_review:{label:'심사 제출 전',priority:1,action:true},
  approved_not_published:{label:'승인 · 게시 전',priority:2,action:true},
  lookup_error:{label:'조회 오류',priority:3},
  draft:{label:'초안',priority:4},
  stale:{label:'재확인 필요',priority:5},
  unknown:{label:'미확인',priority:5},
  in_review:{label:'심사 중',priority:6},
  testing:{label:'테스트 중',priority:7},
  published:{label:'게시됨',priority:8},
  no_release:{label:'릴리스 없음',priority:9},
};
const playFiltersForSelect = [
  {value:'all',label:'모든 상태'}, {value:'action',label:'조치 필요'}, {value:'lookup',label:'조회 확인'},
  ...['rejected','not_sent_for_review','approved_not_published','draft','in_review','testing','published','no_release']
    .map(value=>({value,label:playStatus[value].label})),
];
const playNameOrder = new Intl.Collator('ko-KR',{numeric:true,sensitivity:'base'});
const searchable = value => value.normalize('NFKC').toLowerCase();
const assignmentMutable = node => !node.active && !['passed','awaiting-approval'].includes(node.status);
const ownedTerminal = id => (ui.state?.runs??[]).some(r=>(r.jobs??[]).some(j=>j.terminalId===id));
const draft = (form,name,fallback='') => ui.drafts[form+'.'+name]??fallback;
const providers = () => (ui.state?.providers??['codex','claude','cursor','grok','antigravity','gemini','opencode','kiro']).map(p=>typeof p==='string'?p:p.id);
const providerOptions = selected => options(providers(),selected);
const playAccountValue = account => account.id+':'+account.developerId;
// Live runs first, newest first; finished and cancelled runs sink so the tab opens on work in progress.
const FINISHED_RUN = new Set(['cancelled','completed']);
const orderedRuns = () => [...(ui.state?.runs??[])].sort((a,b)=>FINISHED_RUN.has(a.status)-FINISHED_RUN.has(b.status)||String(b.updatedAt??'').localeCompare(String(a.updatedAt??'')));
// The token summary rides on the summary runs; a loaded runs.get detail carries the raw ledger instead.
const tokensOf = item => item?.tokenUsage ?? ui.state?.runs?.find(r=>r.id===item?.id)?.tokenUsage ?? null;
const run = () => {
  const summary=ui.state?.runs?.find(item=>item.id===ui.runId)??orderedRuns()[0];
  const cached=details.get(summary?.id);
  return cached?.revision===revision()&&Array.isArray(cached.value?.nodes)?cached.value:summary;
};
function acceptState(state) {
  if(typeof state?.revision==='number'&&state.revision<revision())return false;
  ui.state={...(ui.state??{}),...state};
  if(!ui.state.runs?.some(r=>r.id===ui.runId))ui.runId=orderedRuns()[0]?.id??null;
  return true;
}
function scheduleRender() {
  if(renderPending)return;
  renderPending=true;
  requestAnimationFrame(()=>{renderPending=false;render({background:true});});
}
async function ensureRunDetail(id) {
  if(!id)return;
  const version=revision(),key=id+':'+version,cached=details.get(id);
  if(cached?.revision===version)return cached.value;
  if(detailRequests.has(key))return detailRequests.get(key);
  const pending=request('runs.get',{runId:id}).then(value=>{
    if(revision()!==version)return;
    details.delete(id);details.set(id,{revision:version,value});
    while(details.size>6)details.delete(details.keys().next().value);
    return value;
  }).finally(()=>detailRequests.delete(key));
  detailRequests.set(key,pending);
  return pending;
}
function scheduleDetail() {
  if(detailPending)return;
  detailPending=true;
  requestAnimationFrame(()=>{detailPending=false;if(ui.tab==='studio'&&!ui.newRun)loadSelectedDetail();});
}
async function loadSelectedDetail() {
  const id=ui.runId,epoch=navigation;
  try {
    await ensureRunDetail(id);
    if(epoch===navigation&&ui.tab==='studio'&&ui.runId===id)scheduleRender();
  } catch(error) {
    if(epoch===navigation&&ui.tab==='studio'&&ui.runId===id){ui.error=error.message;scheduleRender();}
  }
}
// Fetched when a run's card opens and after a start (the worker re-checks before starting); never on every render.
// A recheck the person asked for is announced once and keeps keyboard focus on its button; automatic loads stay quiet.
const focusRecheck=id=>app.querySelector('[data-action="recheck-preflight"][data-run="'+id+'"]')?.focus?.();
function loadPreflight(id,force=false,{announce=false}={}) {
  const entry=preflights.get(id);
  if(!id||(entry?.loading&&!force))return;
  preflights.set(id,{value:entry?.value,loading:true});
  request('runs.preflight',{runId:id,force})
    .then(value=>preflights.set(id,{value}),error=>preflights.set(id,{value:entry?.value,error:error.message??String(error)}))
    .finally(()=>{
      if(!announce){scheduleRender();return;}
      render();
      const announcer=document.querySelector('#announcer');if(announcer)announcer.textContent=preflightSummary(preflights.get(id));
      focusRecheck(id);
    });
}
// Operations fields ride on the summary run; a loaded runs.get detail lacks them. The disk is read only on request.
const summaryOf = item => ui.state?.runs?.find(r=>r.id===item.id)??item;
// Focus returns to the button only if it was there (or nowhere); the result is announced once.
function loadDisk(id){const entry=disks.get(id);if(entry?.loading)return;disks.set(id,{value:entry?.value,loading:true});request('runs.disk',{runId:id}).then(value=>disks.set(id,{value}),error=>disks.set(id,{value:entry?.value,error:error.message??String(error)})).finally(()=>{const button=()=>[...app.querySelectorAll('[data-action="check-disk"]')].find(item=>item.dataset.run===id),active=document.activeElement,refocus=!active||active===document.body||active.dataset?.action==='check-disk';render();if(refocus)button()?.focus?.();const announcer=document.querySelector('#announcer');if(announcer)announcer.textContent=diskSummary(disks.get(id));});}
function preflightSection(item) {
  if(FINISHED_RUN.has(item.status))return '';
  if(preflightShown!==item.id||!preflights.has(item.id)){preflightShown=item.id;Promise.resolve().then(()=>loadPreflight(item.id));}
  return preflightBlock(preflights.get(item.id)??{loading:true},{runId:item.id});
}
function leaveView() {
  navigation++;dirtyForms.clear();ui.pendingUpdate=false;
  if(typeof window.scrollTo==='function')window.scrollTo({top:0,behavior:'instant'});
}

function toast(message,error=false) {
  toastEl.textContent=message;
  toastEl.className='show'+(error?' error':'');
  clearTimeout(toastEl.timer);
  toastEl.timer=setTimeout(()=>{toastEl.className='';},6500);
}
async function request(name,input={}) {
  if (!bridge?.plugin?.request) throw new Error('이 화면은 Orca 플러그인 안에서 실행해 주세요.');
  return bridge.plugin.request(name,input,{timeoutMs:120000});
}
async function hydrateTab() {
  const tab=ui.tab,epoch=navigation;
  if(tab==='today') {
    const data=await request('today.snapshot',{noteOffset:0,noteLimit:6});
    if(epoch===navigation&&ui.tab===tab)ui.today=data;
  }
  if(tab==='play') {
    const data=await request('play.list');
    if(epoch===navigation&&ui.tab===tab) {
      ui.play=data;
      if(!data.accounts.some(a=>a.id===ui.accountId))ui.accountId=data.accounts[0]?.id??null;
    }
  }
  if(tab==='studio'&&!ui.newRun) {
    const [data]=await Promise.all([request('play.submissionAccounts'),loadSelectedDetail()]);
    if(epoch===navigation&&ui.tab===tab)submissionAccounts=data;
    // "Published" is shown only from Play's observed status, so read it when a run has an approved submission.
    if((ui.state?.runs??[]).some(r=>r.nodes?.some(n=>n.approval?.submission?.developerId))){try{ui.play=await request('play.list');ui.playError=null;}catch(err){ui.play=null;ui.playError=err.message;}}
  }
}
async function refresh({quiet=false,forceHost=false}={}) {
  refreshQueued=true;hostRefreshQueued ||= forceHost;
  if(refreshPromise)return refreshPromise;
  refreshPromise=(async()=>{
    ui.busy=true;if(!quiet)render({background:true});
    try {
      do {
        refreshQueued=false;
        const force=hostRefreshQueued,epoch=navigation;hostRefreshQueued=false;
        try {
          const state=await request('state.get',{view:'summary',...(force?{forceHost:true}:{})});
          acceptState(state);
          if(epoch===navigation)await hydrateTab();
          if(epoch===navigation)ui.error=null;
        } catch(error) {if(epoch===navigation)ui.error=error.message??String(error);}
      } while(refreshQueued);
    } finally {ui.busy=false;render({background:true});}
  })();
  try {await refreshPromise;} finally {refreshPromise=null;}
}
async function moreNotes() {
  if(ui.notesBusy||!ui.today?.notesPage?.hasMore)return;
  ui.notesBusy=true;
  const epoch=navigation,offset=ui.today.notesPage.offset+ui.today.notesPage.limit;
  render();
  try {
    const data=await request('today.snapshot',{noteOffset:offset,noteLimit:6});
    if(epoch!==navigation||ui.tab!=='today')return;
    const byWorkspace=new Map(ui.today.notes.map(note=>[note.workspaceId,note]));
    for(const note of data.notes)byWorkspace.set(note.workspaceId,note);
    ui.today={...ui.today,notes:[...byWorkspace.values()],notesPage:data.notesPage,warnings:[...new Set([...(ui.today.warnings??[]),...(data.warnings??[])])]};
  } catch(error) {if(epoch===navigation)toast(error.message,true);}
  finally {ui.notesBusy=false;if(epoch===navigation)render();}
}
const empty = (heading,text,action) => '<div class="empty"><div class="empty-icon">◇</div><h3>'+e(heading)+'</h3><p>'+e(text)+'</p>'+(action??'')+'</div>';
function rememberDisclosures(root) {
  for(const element of root.querySelectorAll('details[data-disclosure]')) {
    if(element.open)disclosures.add(element.dataset.disclosure);else disclosures.delete(element.dataset.disclosure);
  }
}
function restoreDisclosures(root) {
  for(const element of root.querySelectorAll('details[data-disclosure]'))if(disclosures.has(element.dataset.disclosure))element.open=true;
}
function render({background=false}={}) {
  if(background&&dirtyForms.size) {
    ui.pendingUpdate=true;
    app.setAttribute('aria-busy',String(ui.busy));
    const notice=app.querySelector('[data-update-notice]');
    if(notice)notice.hidden=false;
    return;
  }
  rememberDisclosures(app);
  const scroll=typeof window.scrollY==='number'?window.scrollY:0;
  const focusId=background&&/^[a-zA-Z][\w-]*$/.test(document.activeElement?.id??'')?document.activeElement.id:null;
  const selection=focusId==='play-search'?[document.activeElement.selectionStart,document.activeElement.selectionEnd,document.activeElement.selectionDirection]:null;
  const active=(ui.state?.runs??[]).filter(r=>r.status==='running').length;
  app.setAttribute('aria-busy',String(ui.busy));
  app.innerHTML='<div class="shell"><header class="topbar"><div class="brand-mark" aria-hidden="true">N</div><div class="grow"><div class="brand-name">TORIS NEON</div><div class="brand-meta"><span>APP STUDIO</span><span>·</span><span>FOR ORCA</span></div></div><div class="top-actions"><span class="status-label"><i class="dot '+(!ui.state?'offline':'')+'"></i>'+(active?active+'개 실행':ui.state?'연결됨':'연결 대기')+'</span><button class="icon-button" data-action="refresh" aria-label="새로고침" title="새로고침" '+(ui.busy?'disabled':'')+'>↻</button></div></header><nav class="nav" aria-label="주요 메뉴">'+[['today','오늘 이어하기'],['studio','Auto App'],['play','Play Store'],['agents','에이전트']].map(([id,label])=>'<button data-action="tab" data-tab="'+id+'" class="'+(ui.tab===id?'active':'')+'" aria-current="'+(ui.tab===id?'page':'false')+'">'+label+'</button>').join('')+'</nav><main class="main"><div class="update-notice" data-update-notice hidden>새 상태가 도착했습니다. 작성 중인 내용은 저장하거나 화면을 이동할 때 갱신됩니다.</div>'+(ui.error?'<div class="callout error page-error" role="alert">'+e(ui.error)+'</div>':'')+(ui.state?.warnings??[]).map(w=>'<div class="callout warning">'+e(w)+'</div>').join('')+(ui.tab==='today'?renderToday():ui.tab==='studio'?renderStudio():ui.tab==='play'?renderPlay():renderAgents())+'<footer class="footer"><span>상태와 근거를 남기는 앱 제작 공간</span><span>'+e(ui.state?.build?.label??'버전 확인 중')+' · Asia/Seoul</span></footer></main></div>';
  restoreDisclosures(app);
  ui.pendingUpdate=false;
  if(focusId) {
    const control=app.querySelector('#'+focusId);
    control?.focus?.({preventScroll:true});
    if(typeof selection?.[0]==='number')control?.setSelectionRange?.(...selection);
  }
  if(background&&typeof window.scrollTo==='function')window.scrollTo({top:scroll,behavior:'instant'});
}
function renderToday() {
  const data=ui.today,runs=ui.state?.runs??[];
  const yesterdayCount=(data?.yesterdayEvents?.length??0)+(data?.worklogs?.filter(w=>w.day===data.yesterdayDate).length??0);
  const waiting=runs.filter(r=>r.status==='blocked'||r.nodes?.some(n=>n.status==='awaiting-approval')).length;
  let html='<section class="hero today-hero"><div class="hero-row"><div><p class="eyebrow">YOUR NEXT STEP</p><h1>어제의 맥락, 오늘의 한 걸음.</h1></div><span class="date-pill">'+e(todayDate())+'</span></div><p>남겨둔 다음 행동과 실제 검증 결과를 함께 확인하세요.</p></section><div class="stats"><div class="stat"><span class="stat-label">어제의 기록</span><span class="stat-value">'+yesterdayCount+'<span>건</span></span></div><div class="stat"><span class="stat-label">진행 중</span><span class="stat-value">'+runs.filter(r=>r.status==='running').length+'<span>개</span></span></div><div class="stat"><span class="stat-label">확인 필요</span><span class="stat-value">'+waiting+'<span>건</span></span></div></div>';
  if(!data)html+=empty(ui.busy?'기록을 읽고 있습니다':'기록을 연결해 주세요','Orca 작업 공간과 날짜별 인계 기록이 이곳에 표시됩니다.');
  else {
    const warnings=data.warnings??[];
    html+=warnings.length>1?'<details class="callout warning warnings-group" data-disclosure="today-warnings"><summary>기록 조회 안내 · '+warnings.length+'건</summary>'+warnings.map(w=>'<p>'+e(w)+'</p>').join('')+'</details>':warnings.map(w=>'<div class="callout warning">'+e(w)+'</div>').join('');
    const incomplete=runs.filter(r=>!['completed','cancelled'].includes(r.status));
    html+='<div class="section-heading"><div><h2>이어서 할 일</h2><p>가장 최근에 남긴 다음 행동부터 시작하세요.</p></div>'+button('+ 새 앱','new-run','','small')+'</div>';
    if(!incomplete.length&&!data.notes.length)html+=empty('아직 저장된 이어하기가 없습니다','앱 제작을 시작하거나 현재 프로젝트의 인계 메모를 남겨 주세요.',button('첫 앱 흐름 만들기','new-run','','primary'));
    for(const item of incomplete.slice(0,ui.runLimit??4))html+=todayRunCard(item); // its one next action (panel/todayactions.mjs)
    if(incomplete.length>(ui.runLimit??4))html+=button('진행 중인 흐름 더 보기 · '+incomplete.length+'개','more-runs','','full');
    const finished=runs.filter(r=>r.status==='completed').sort((a,b)=>String(b.updatedAt??'').localeCompare(String(a.updatedAt??''))).slice(0,3);
    if(finished.length)html+='<h3 class="section-meta">완료된 결과 · 이어서 개선</h3>'+finished.map(todayRunCard).join('');
    html+='<div class="note-grid">'+data.notes.map(note=>'<article class="card note-card"><div class="card-head"><div class="grow"><div class="card-title">'+e(note.projectName)+'</div><div class="card-subtitle">'+e(localDate(note.at))+'</div></div>'+badge(note.verificationFreshness)+'</div><div class="next-step"><span class="note-label">다음 행동</span><p>'+e(note.next||'인계 내용을 확인해 주세요.')+'</p></div>'+noteAction(note,providerOptions('codex')).html+'<details class="note-context" data-disclosure="note:'+e(note.workspaceId)+'"><summary>진행 내용과 검증 근거</summary><div class="note-line"><span class="note-label">진행한 일</span>'+e(note.state)+'</div>'+(note.why?'<div class="note-line"><span class="note-label">멈춘 이유</span>'+e(note.why)+'</div>':'')+(note.hold?'<div class="note-line"><span class="note-label">보류한 결정</span>'+e(note.hold)+'</div>':'')+(note.verified?'<div class="evidence">'+e(note.verified)+'</div>':'<p class="hint">저장된 검증 근거가 없습니다.</p>')+'</details></article>').join('')+'</div>';
    if(data.notesPage?.hasMore)html+='<div class="pagination">'+button(ui.notesBusy?'불러오는 중…':'인계 메모 더 보기','more-notes',ui.notesBusy?'disabled':'','full')+'<span class="hint">'+data.notes.length+' / '+data.notesPage.total+'개 표시</span></div>';
    const day=ui.day==='today'?data.date:data.yesterdayDate,events=ui.day==='today'?data.todayEvents:data.yesterdayEvents,logs=(data.worklogs??[]).filter(w=>w.day===day);
    html+='<section class="section daily-section"><div class="section-heading"><h2>작업 기록</h2><div class="segmented" role="group" aria-label="기록 날짜">'+[['yesterday','어제'],['today','오늘']].map(([id,label])=>button(label,'select-day','data-day="'+id+'" aria-pressed="'+(ui.day===id)+'"','small'+(ui.day===id?' active':''))).join('')+'</div></div><p class="section-meta">'+e(day)+' · 실행 기록 '+(events?.length??0)+'개 · 작업 일지 '+logs.length+'개</p>'+renderEvents(events,logs.length?'아래 작업 일지에서 진행한 내용을 확인하세요.':'이 날짜에 저장된 실행 기록이 없습니다.','day:'+day)+logs.slice(0,ui.feedLimit).map(renderWorklog).join('')+(logs.length>ui.feedLimit?button('작업 일지 더 보기 · '+(logs.length-ui.feedLimit)+'개','more-feed','','full'):'')+'</section>';
    if(data.lastActiveDay&&data.lastActiveDay!==data.yesterdayDate)html+='<p class="hint spacer">마지막 기록이 있는 날 · '+e(data.lastActiveDay)+'</p>';
    if(data.undatedEvents?.length)html+='<details class="card spacer" data-disclosure="undated"><summary>날짜를 확인할 수 없는 기록 '+data.undatedEvents.length+'개</summary>'+renderEvents(data.undatedEvents,'','undated')+'</details>';
  }
  if(ui.state?.archivedRuns?.length) {
    html+='<section class="section"><details class="card" data-disclosure="archives"><summary>보관된 실행 '+ui.state.archivedRuns.length+'개</summary>';
    for(const item of [...ui.state.archivedRuns].reverse()) {
      const cached=details.get(item.id),full=cached?.revision===revision()?cached.value:null,open=ui.archiveId===item.id;
      html+='<div class="track"><div class="track-header"><strong class="goal-title">'+e(goalTitle(item.goal))+'</strong>'+badge(item.status)+'</div><p>보관 · '+e(localDate(item.archivedAt))+' · '+(item.passedCount??item.nodes?.filter(n=>n.status==='passed').length??0)+'/'+(item.nodeCount??item.nodes?.length??0)+'단계</p>'+button(open?'기록 닫기':'실행 기록 보기','open-archive','data-run="'+e(item.id)+'" aria-expanded="'+open+'"','small')+exportControls(item.id,ui.exportConfirm,goalTitle(item.goal))+(open?(full?renderEvents([...(full.events??[])].reverse(),'기록이 없습니다.','archive:'+item.id):'<p class="hint" role="status">실행 기록을 불러오고 있습니다.</p>'):'')+'</div>';
    }
    html+='</details></section>';
  }
  html+='<section class="section"><details class="card" data-disclosure="handoff" '+(data&&!data.notes?.length?'open':'')+'><summary>현재 프로젝트의 인계 메모 남기기</summary>'+handoffForm()+'</details></section>';
  if(data?.sessions?.length)html+='<section class="section"><details class="card" data-disclosure="sessions"><summary>이전 에이전트 세션 '+data.sessions.length+'개</summary><p class="hint">세션 제목과 시각입니다. 작업 완료나 검증 통과를 의미하지 않습니다.</p>'+data.sessions.slice(0,ui.sessionLimit).map(s=>'<div class="track"><div class="track-header"><strong>'+e(s.title||s.agent)+'</strong><span class="mono">'+e(s.agent)+'</span></div><p>'+e(localDate(s.updatedAt))+' · '+(s.messageCount??0)+'개 메시지</p>'+(s.workspaceId?'<div class="actions">'+button('세션 이어하기','resume-session','data-workspace="'+e(s.workspaceId)+'" data-agent="'+e(s.agent)+'" data-session="'+e(s.sessionId)+'"','small')+'</div>':'')+'</div>').join('')+(data.sessions.length>ui.sessionLimit?button('이전 세션 더 보기','more-sessions','','full'):'')+'</details></section>';
  return html;
}
function renderEvents(events,placeholder,key='events') {
  if(!events?.length)return '<div class="empty small"><p>'+e(placeholder)+'</p></div>';
  const limit=ui.eventLimits?.[key]??8;
  return '<div class="timeline">'+events.slice(0,limit).map(ev=>'<div class="event"><div class="event-title">'+e(ev.summary??ev.type)+'</div><div class="event-meta">'+e(localDate(ev.at??ev.timestamp,true))+' · '+e(ev.projectName??(ev.goal?goalTitle(ev.goal):null)??ev.nodeId??'앱 작업')+'</div>'+(ev.next?'<p class="hint">다음 · '+e(ev.next)+'</p>':'')+'</div>').join('')+'</div>'+(events.length>limit?button('실행 기록 더 보기 · '+(events.length-limit)+'개','more-events','data-key="'+e(key)+'"','small spacer'):'');
}
function renderWorklog(log) {
  return '<details class="card worklog-card spacer" data-disclosure="log:'+e(log.day+':'+log.project)+'"><summary>'+e(log.project)+' · 작업 일지</summary><p class="hint">기존 기록을 읽어 표시합니다. 새로 검증한 결과는 아닙니다.'+(log.truncated?' 미리보기 일부만 표시됩니다.':'')+'</p><pre class="worklog">'+e(log.text)+'</pre></details>';
}
function handoffForm() {
  const workspaces=(ui.state?.workspaces??[]).map(w=>({value:w.id,label:(w.project?w.project+' / ':'')+w.name}));
  return '<form id="handoff"><label class="label" for="handoff-workspace">작업 공간</label><select class="field" id="handoff-workspace" name="workspaceId" required><option value="">프로젝트를 선택하세요</option>'+options(workspaces,draft('handoff','workspaceId',ui.state?.context?.workspaceId))+'</select><label class="label" for="handoff-state">진행한 내용</label><textarea class="field" id="handoff-state" name="state" maxlength="4000" required placeholder="무엇을 만들었고 어디까지 확인했나요?">'+e(draft('handoff','state'))+'</textarea><label class="label" for="handoff-next">다음에 할 한 가지</label><textarea class="field" id="handoff-next" name="next" maxlength="4000" required placeholder="내일의 내가 바로 실행할 수 있게 적어 주세요.">'+e(draft('handoff','next'))+'</textarea><div class="field-grid"><div><label class="label" for="handoff-why">멈춘 이유</label><input class="field" id="handoff-why" name="why" maxlength="4000" value="'+e(draft('handoff','why'))+'" placeholder="예: 실기기 테스트 대기"></div><div><label class="label" for="handoff-hold">보류한 결정</label><input class="field" id="handoff-hold" name="hold" maxlength="4000" value="'+e(draft('handoff','hold'))+'" placeholder="예: 구독 상품 가격"></div></div><label class="label" for="handoff-verified">실제로 실행한 검증</label><input class="field mono" id="handoff-verified" name="verified" maxlength="4000" value="'+e(draft('handoff','verified'))+'" placeholder="예: flutter test — 24 passed"><p class="hint">검증 메모를 저장할 때 코드 지문을 기록합니다. 이후 코드가 바뀌면 재확인 필요로 표시합니다.</p><div class="actions"><button class="button primary" type="submit">인계 메모 저장</button></div></form>';
}
function renderStudio() {
  let html='<section class="hero flow-tab"><div class="hero-row"><h1>Auto App</h1>'+button('+ 새 흐름','new-run','','small')+'</div></section>';
  if(ui.newRun) return html+newRunForm();
  const item=run();
  if(!item) return html+empty('첫 앱의 흐름을 만들어 보세요','목표와 프로젝트를 선택하면 여섯 팀, 11개 단계의 흐름이 준비됩니다. 실행은 시작 버튼을 누를 때 진행됩니다.',button('앱 제작 흐름 만들기','new-run','','primary'));
  const nodes=item.nodes??[],selected=selectedNode(item),ctx=flowContext(item);
  html+=runPicker(item)+'<div class="studio-overview">'+runSummaryCard(item,nodes)+collabStrip(item,ctx)+'</div>'+runResult(item,{runs:ui.state?.runs??[],play:ui.play,playError:ui.playError,tokens:tokensOf(item)})+(item.template==='diagnose'?candidateList(item):'');
  if(['completed','cancelled'].includes(item.status)) html+='<div class="actions">'+(item.stopFailures?.length?'':button('완료된 실행 보관','archive-run','data-run="'+e(item.id)+'"','small'))+exportControls(item.id,ui.exportConfirm,goalTitle(item.goal))+'</div>';
  if(item.workspaceCreation?.state==='uncertain'&&!item.workspaceId) html+=attachCard(item,ctx);
  html+=teamNavigator(item,ctx)+'<div class="studio-columns">'+relay(item,ctx)+inspector(item,selected,ctx)+'</div>';
  html+='<section class="section"><div class="section-heading"><h2>실행 기록</h2><span class="hint">'+(item.events?.length??0)+'개</span></div>'+renderEvents([...(item.events??[])].reverse(),'아직 실행 기록이 없습니다.','run:'+item.id)+'</section>';
  return html;
}
function selectedNode(item) {
  const nodes=item.nodes??[];
  const selected=nodes.find(n=>n.id===ui.nodeId)??nodes.find(n=>n.active)??nodes.find(n=>n.status!=='passed')??nodes[0];
  if(ui.nodeId!==selected?.id)ui.agentRole=null;
  ui.nodeId=selected?.id;
  return selected;
}
function flowContext(item) {
  const now=Date.now(),active=new Map([...(stageMotions.get(item.id)??[])].filter(([,entry])=>now-entry.at<MOTION_MS));
  const changes=transitions(stageSnapshots.get(item.id),item);
  for(const [nodeId,kind] of changes)active.set(nodeId,{kind,at:now});
  announce(item,changes);
  stageSnapshots.set(item.id,snapshotStates(item));stageMotions.set(item.id,active);
  return {state:ui.state,selectedId:ui.nodeId,selectedRole:ui.agentRole,providers:providers(),eccChoices:ui.state?.eccAgents??[],launchOptions:ui.state?.launchOptions,draft,approvalForm,now,motion:active,artifacts:ui.artifacts,tokens:tokensOf(item)};
}
// One polite sentence per real transition, outside the re-rendered #app.
function announce(item,changes) {
  const announcer=document.querySelector('#announcer');
  if(!announcer||!changes.size)return;
  announcer.textContent=[...changes].map(([id,kind])=>{
    const node=item.nodes.find(n=>n.id===id);
    const label=kind==='handoff'?'검토 인계':kind==='retry'&&node.feedback?'수정 요청':STATE_LABELS[stageState(node)];
    return title(node)+' · '+label;
  }).join('. ');
}
function runPicker(item) {
  return '<select class="field run-select" aria-label="앱 제작 흐름 선택" id="run-select">'+options(orderedRuns().map(r=>({value:r.id,label:'['+(statusNames[r.status]??r.status)+'] '+goalTitle(r.goal).slice(0,80)})),item.id)+'</select>';
}
// Cancel states as confirmed: requested, done (Orca confirmed every owned terminal closed), or needs checking.
function stopBadge(item) {
  if(ui.cancelling.has(item.id))return '<span class="badge cancelled">취소 요청 처리 중</span>';
  if(item.status==='cancelled')return '<span class="badge '+(item.cancelUnsaved?'blocked">취소 저장 대기':item.stopFailures?.length?'blocked">종료 확인 필요':'cancelled">취소 완료')+'</span>';
  return badge(item.status);
}
function runSummaryCard(item,nodes) {
  const done=nodes.filter(n=>n.status==='passed').length;
  // A run whose workspace was never created restarts with the same start button.
  const startable=item.status==='ready'||(!item.workspaceId&&item.status==='blocked'&&item.workspaceCreation?.state!=='uncertain');
  // A short title; the full goal (often thousands of characters) only on demand, here only.
  const short=goalTitle(item.goal);
  const goal='<div class="card-title goal-title">'+e(short)+'</div>'+(item.goal.trim()!==short?'<details class="goal-detail" data-disclosure="goal:'+e(item.id)+'"><summary>전체 목표 보기 · '+item.goal.length.toLocaleString('ko-KR')+'자</summary><p class="note-line goal-full">'+e(item.goal)+'</p></details>':'');
  return '<div class="card run-summary"><div class="card-head"><div class="grow">'+goal+'<div class="card-subtitle">'+e(item.workspacePath??'시작하면 별도 작업 브랜치를 준비합니다.')+'</div></div>'+stopBadge(item)+'</div><div class="progress"><span style="width:'+(done/Math.max(nodes.length,1)*100)+'%"></span></div><div class="progress-label"><span>'+done+' / '+nodes.length+' 단계 통과</span><span>수정 루프 '+(item.repairLoops??0)+' / '+item.maxRepairLoops+' · 동시 '+item.maxConcurrency+'</span></div>'+(item.started?runTokens(tokensOf(item),{id:item.id,live:!FINISHED_RUN.has(item.status)}):'')+preflightSection(item)+'<div class="actions">'+
    (startable?button(item.workspaceId?'계속 실행':'앱 제작 시작','start-run','data-run="'+e(item.id)+'"','primary'):'')+
    (!startable&&['paused','blocked'].includes(item.status)?button(item.status==='blocked'?'상태 확인 후 재개':'재개','resume-run','data-run="'+e(item.id)+'"','primary'):'')+
    (['running','ready','blocked'].includes(item.status)?button('새 배정 멈춤','pause-run','data-run="'+e(item.id)+'" title="새 단계 배정만 멈춥니다. 작업 중인 에이전트는 계속 작업합니다."'):'')+button('상태 동기화','refresh-run','data-run="'+e(item.id)+'"')+
    (item.workspaceId?button('작업 공간 열기','open-workspace','data-workspace="'+e(item.workspaceId)+'"'):'')+(!['cancelled','completed'].includes(item.status)?button('실행 취소','cancel-run','data-run="'+e(item.id)+'"','danger'):'')+'</div>'+
    autonomyLine(item)+cleanupLine(item)+cleanupResult(summaryOf(item))+runOperationsLine(summaryOf(item))+storageLine(item)+diskBlock(disks.get(item.id),{runId:item.id})+
    (item.status==='paused'?'<p class="hint spacer">새 단계 배정만 멈췄습니다. 이미 작업 중인 에이전트는 계속 작업하고 완료 보고서를 남길 수 있습니다. 모두 멈추려면 실행 취소를 누르세요.</p>':'')+(item.runtimeMessage?'<div class="callout error" role="status">'+e(item.runtimeMessage)+'</div>':'')+
    (item.stopFailures?.length?'<div class="callout error"><strong>'+(item.cancelUnsaved?'취소가 아직 저장되지 않았습니다.':'일부 에이전트의 종료를 확인하지 못했습니다.')+'</strong>'+item.stopFailures.map(f=>'<p>'+e(f.message)+'</p>'+(f.terminalId?button('해당 에이전트 확인','focus-terminal','data-terminal="'+e(f.terminalId)+'"','small'):button('Orca 작업 공간 확인','open-workspace','data-workspace="'+e(item.workspaceId)+'"','small'))).join('')+'</div>':'')+'</div>';
}
// What cleanup did for this run: closed, already gone, failed (and why), kept (and why).
function cleanupResult(item) {
  const c=item.cleanup;if(!c)return '';
  return '<details class="cleanup-result"><summary class="hint">끝난 터미널 '+e(c.closed)+'개 닫음'+(c.gone?' · 이미 없음 '+e(c.gone)+'개':'')+(c.failed.length?' · 닫기 실패 '+e(c.failed.length)+'개':'')+(c.kept.length?' · 남김 '+e(c.kept.length)+'개':'')+'</summary>'+
    c.failed.map(f=>'<p class="hint mono">'+e(f.terminalId)+' — '+e(f.attempts)+'번 실패: '+e(f.error??'원인 미기록')+'</p>').join('')+
    c.kept.map(k=>'<p class="hint mono">'+e(k.terminalId)+' — 에이전트가 '+e(k.state)+' 상태라 남김</p>').join('')+'</details>';
}
// Finished agents' terminals close on their own (src/cleanup.mjs); off keeps them for reading.
function cleanupLine(item) {
  const on=typeof item.closeFinishedTerminals==='boolean'?item.closeFinishedTerminals:item.autonomous===true;
  return '<div class="autonomy-line"><span class="hint">끝난 터미널 자동 닫기 '+(on?'켜짐 · 보고서가 받아들여진 작업의 터미널을 2분 뒤 닫습니다(세션은 다시 열 수 있음)':'꺼짐 · 끝난 에이전트 화면을 그대로 둡니다')+'</span>'+
    button(on?'자동 닫기 끄기':'자동 닫기 켜기','toggle-terminal-cleanup','data-run="'+e(item.id)+'" data-enabled="'+(!on)+'"','small')+'</div>';
}
// The worker keeps running from memory and retries; the person should still know nothing is saved.
function storageLine(item) {
  const warning=item.storageWarning;
  return warning?'<div class="callout error" role="alert"><strong>실행 상태를 저장하지 못하고 있습니다 ('+e(warning.attempts)+'회)</strong><br>진행은 계속되고 저장을 자동으로 다시 시도합니다. 지금 Orca를 다시 시작하면 '+e(localDate(warning.since))+' 이후 진행이 사라질 수 있습니다.<br><span class="hint">'+e(warning.message)+'</span></div>':'';
}
// Autonomous runs retry, approve internal gates and resume on their own within visible limits.
function autonomyLine(item) {
  const limits=ui.state?.autonomyLimits,state=item.autonomy??{},on=item.autonomous===true;
  const usage=on&&limits?' · 자동 재시도 '+(state.total??0)+'/'+limits.retriesPerRun+' (단계당 '+limits.retriesPerStage+'번, 같은 에이전트 '+limits.switchAgentAfter+'번 실패 시 교체)':'';
  return '<div class="autonomy-line"><span class="hint">'+(on?'자율 진행 켜짐':'자율 진행 꺼짐')+e(usage)+'</span>'+
    button(on?'자율 진행 끄기':'자율 진행 켜기','toggle-autonomy','data-run="'+e(item.id)+'" data-enabled="'+(!on)+'"','small')+'</div>'+
    (on&&state.stopped?'<div class="callout warning" role="status">'+e(state.stopped.reason)+'</div>':'');
}
function approvalForm(item,node) {
  if(node.humanApproval)return catalogApprovalForm(item,node,{draft:(name,fallback)=>draft('catalog-approval',name,fallback)});
  const canSubmit=submissionAccounts.length>0;
  const actual=canSubmit&&draft('approval','actualSubmission',false);
  const required=actual?'required':'';
  const accounts=submissionAccounts.map(account=>({value:playAccountValue(account),label:account.name+' · '+account.developerId}));
  return `<div class="divider"></div><form id="approval" data-run="${e(item.id)}" data-node="${e(node.id)}">
    <label class="label" for="approval-note">이번 단계에서 허용할 작업</label>
    <textarea class="field" id="approval-note" name="note" required maxlength="2000" placeholder="예: 내부 테스트 빌드와 업로드 전 자료를 준비해 주세요.">${e(draft('approval','note'))}</textarea>
    <label class="checkbox"><input type="checkbox" name="actualSubmission" id="actual-submission" ${actual?'checked':''} ${canSubmit?'':'disabled'}>실제 Play 제출까지 승인</label>
    ${canSubmit?'':'<p class="hint">실제 제출을 승인하려면 Play Store 탭에서 개발자 계정 ID와 대상 패키지를 등록하세요.</p>'}
    <div id="submission-fields" ${actual?'':'hidden'}>
      <label class="label" for="submission-account">Play 개발자 계정</label>
      <select class="field" id="submission-account" name="playAccount" ${required}>
        <option value="">개발자 계정 선택</option>${options(accounts,draft('approval','playAccount'))}
      </select>
      <label class="label" for="submission-package">패키지 이름</label>
      <input class="field mono" id="submission-package" name="packageName" value="${e(draft('approval','packageName'))}" placeholder="com.example.app" ${required}>
      <div class="field-grid"><div><label class="label" for="submission-track">트랙</label>
        <input class="field" id="submission-track" name="track" value="${node.id==='internal'?'internal':'production'}" readonly></div>
        <div><label class="label" for="submission-version">버전 코드</label>
        <input class="field" id="submission-version" type="number" min="1" max="2100000000" name="versionCode" value="${e(draft('approval','versionCode'))}" ${required}></div></div>
      <p class="hint">배정 전에 Play 조회 권한을 확인합니다. 제출에는 해당 프로젝트의 배포 도구와 출시 권한이 필요합니다.</p>
    </div>
    <div class="actions"><button class="button primary" type="submit">범위 승인 후 계속</button></div>
    <p class="hint">기본 승인 범위는 준비와 검토입니다.</p>
  </form>`;
}
// "Improve this result": the new run links to the previous one and never changes it.
function parentNotice() {
  const id=draft('new-run','parentRunId');if(!id)return'';
  const parent=(ui.state?.runs??[]).find(r=>r.id===id);
  const paste=parent?.template==='diagnose'?'<br>진단 보고서(verification.md)의 후보 하나를 골라 개선 목표에 그 내용을 붙여 넣고, 후보에 맞는 개선 종류를 고르세요.':'';
  return '<input type="hidden" name="parentRunId" value="'+e(id)+'"><div class="callout"><strong>이전 결과에서 이어서 개선합니다.</strong><br>'+e(parent?goalTitle(parent.goal):id)+' · 이전 실행과 보고서는 그대로 두고 새 실행으로 만듭니다.'+paste+'</div>';
}
const ARTIFACT_CACHE=8;
// One artifact at a time, only when asked; never part of a state push (src/artifacts.mjs).
async function loadArtifact(runId,path) {
  const key=artifactCacheKey(runId,path);
  const known=ui.artifacts.get(key);if(known&&!known.error)return;
  const announcer=document.querySelector('#announcer'),say=text=>{if(announcer)announcer.textContent=text;};
  ui.artifacts.set(key,{loading:true});render();say('결과 파일을 불러오는 중입니다.');
  try{const loaded=await request('artifacts.read',{runId,path});ui.artifacts.set(key,loaded);say(loaded?.kind==='changed'?loaded.text:'결과 파일을 불러왔습니다.');}
  catch(err){ui.artifacts.set(key,{error:'불러오지 못했습니다: '+err.message});say('결과 파일을 불러오지 못했습니다: '+err.message);}
  while(ui.artifacts.size>ARTIFACT_CACHE)ui.artifacts.delete(ui.artifacts.keys().next().value);
  render();
  document.querySelector('#'+artifactId(runId,path))?.focus?.(); // the pressed button is replaced; keep the place
}
function newRunForm() {
  const projects=(ui.state?.projects??[]).filter(p=>p.kind==='git'&&(!p.hostId||p.hostId==='local')).map(p=>({value:p.id,label:p.name}));
  const type=draft('new-run','flowType','new-app'),improve=type==='improve',diagnose=type==='diagnose',existing=improve||diagnose;
  const head='<section class="card accent"><div class="section-heading"><div><p class="eyebrow">'+({improve:'IMPROVE AN APP',diagnose:'DIAGNOSE',resume:'RESUME'}[type]??'NEW APP FLOW')+'</p><h2>'+({improve:'어떤 앱을 개선할까요?',diagnose:'어떤 앱을 진단할까요?',resume:'어떤 흐름을 이어갈까요?'}[type]??'어떤 앱을 만들까요?')+'</h2></div>'+button('닫기','close-new','','small')+'</div>'+flowTypeSwitch(type);
  if(type==='resume')return head+resumeList(ui.state?.runs)+'</section>';
  ui.drafts['new-run.requestId']??='form-'+(globalThis.crypto?.randomUUID?.()??Date.now().toString(36)+Math.random().toString(36).slice(2));
  return head+'<form id="new-run"><input type="hidden" name="flowType" value="'+e(type)+'"><input type="hidden" name="requestId" value="'+e(ui.drafts['new-run.requestId'])+'">'+parentNotice()+'<label class="label" for="app-goal">'+(diagnose?'진단 메모 (선택)':improve?'개선 목표와 완료 기준':'앱 목표와 완료 기준')+'</label><textarea class="field" style="min-height:125px" id="app-goal" name="goal" '+(diagnose?'':'required ')+'maxlength="6000" placeholder="'+(diagnose?'예: 최근 리뷰에 앱이 느리다는 말이 많아요. 그쪽을 먼저 봐 주세요.':improve?'예: 물주기 앱의 홈 화면을 새 디자인으로 바꾸고, 알림 시간 설정과 광고 제거 결제를 추가하고 싶어요. 기존 사용자 기록은 그대로 유지해야 해요.':'예: Flutter로 캐릭터와 대화하는 사주 앱을 만들고 싶어요. 첫 버전은 생년월일 입력, 채팅, 결과 저장까지. Android 실기기에서 확인해 주세요.')+'">'+e(draft('new-run','goal'))+'</textarea><label class="label" for="app-project">Orca에 등록된 Git 프로젝트</label><select class="field" id="app-project" name="projectId" required><option value="">프로젝트 선택</option>'+options(projects,draft('new-run','projectId'))+'</select><p class="hint">'+(existing?'이미 출시한 앱의 저장소를 고르세요. 커밋이 있어야 하며, 시작 시 별도 브랜치와 작업 공간에서 개선합니다.':'프로젝트에 첫 커밋이 있어야 합니다. 시작 시 별도 브랜치와 작업 공간을 만듭니다.')+'</p>'+(improve?improveFields({draft:(name,fallback)=>draft('new-run',name,fallback),play:ui.play}):diagnose?diagnoseFields({draft:(name,fallback)=>draft('new-run',name,fallback),play:ui.play}):'')+'<div class="field-grid"><div><label class="label" for="app-agent">기본 작업 에이전트</label><select class="field" id="app-agent" name="agent">'+providerOptions(draft('new-run','agent','codex'))+'</select></div><div><label class="label" for="app-reviewer">독립 검토 에이전트</label><select class="field" id="app-reviewer" name="reviewer">'+providerOptions(draft('new-run','reviewer','codex'))+'</select></div></div><details class="spacer"><summary>동시 실행과 반복 한도</summary><div class="field-grid"><div><label class="label" for="app-concurrency">동시 실행 수</label><select class="field" id="app-concurrency" name="maxConcurrency">'+options([1,2,3,4,5,6],draft('new-run','maxConcurrency',2))+'</select></div><div><label class="label" for="app-attempts">단계별 최대 시도</label><select class="field" id="app-attempts" name="maxAttempts">'+options([1,2,3,4,5],draft('new-run','maxAttempts',3))+'</select></div><div><label class="label" for="app-loops">테스트 → 구현 수정 한도</label><select class="field" id="app-loops" name="maxRepairLoops">'+options([0,1,2,3,4,5],draft('new-run','maxRepairLoops',3))+'</select></div><div><label class="label" for="app-base">기준 브랜치 (선택)</label><input class="field" id="app-base" name="baseBranch" value="'+e(draft('new-run','baseBranch'))+'" placeholder="프로젝트 기본값"></div></div></details><div class="callout"><strong>담당자와 검토자를 분리합니다.</strong><br>작업 종료만으로 통과 처리하지 않습니다. 산출물과 검증 근거를 확인하고, 독립 검토를 거친 다음 후속 단계를 엽니다.</div><div class="actions"><button type="submit" class="button primary">그래프 만들기 →</button></div><p class="hint">그래프를 만든 뒤 역할별 배정을 바꾸고 직접 실행을 시작할 수 있습니다.</p></form></section>';
}
function selectedPlayAccount() {
  const accounts=ui.play?.accounts??[];
  return accounts.find(account=>account.id===ui.accountId)??accounts[0];
}
function filteredPlayApps(apps) {
  const words=searchable(playFilters.query).trim().split(/\s+/).filter(Boolean);
  const filter=playFilters.status;
  return apps.filter(item=>{
    const haystack=searchable((item.name??'')+' '+item.packageName);
    return words.every(word=>haystack.includes(word));
  })
    .map(item=>{
      const tracks=item.tracks??[];
      const lifecycle=new Set(tracks.flatMap(track=>(track.releases??[]).map(release=>release.state)));
      const status=item.status==='rejected'?'rejected'
        :lifecycle.has('not_sent_for_review')?'not_sent_for_review'
        :lifecycle.has('approved_not_published')?'approved_not_published'
        :Object.hasOwn(playStatus,item.status)?item.status:'unknown';
      const check=tracks.some(track=>track.error)?'lookup_error':tracks.some(track=>track.stale)?'stale':null;
      const priority=Math.min(playStatus[status].priority,check?playStatus[check].priority:Infinity);
      return {item,status,check,priority};
    })
    .filter(({status,check})=>filter==='all'||status===filter||
      (filter==='action'&&playStatus[status].action)||(filter==='lookup'&&(check||status==='unknown')))
    .sort((a,b)=>a.priority-b.priority||playNameOrder.compare(a.item.name||a.item.packageName,b.item.name||b.item.packageName)||
      playNameOrder.compare(a.item.packageName,b.item.packageName));
}
function playResultCount(shown,total) {
  return shown===total?'전체 '+total+'개':total+'개 중 '+shown+'개';
}
function playAppList(matches,account) {
  const accountId=account.id;
  if(!matches.length)return empty('검색 결과가 없습니다','검색어 또는 상태 필터를 바꿔 보세요.',button('검색 및 필터 초기화','reset-play-filters','','small'));
  const label=status=>'<span class="badge '+status+'">'+playStatus[status].label+'</span>';
  return '<ul class="play-list" aria-label="Play Store 앱">'+matches.map(({item,status,check})=>`<li>
    <details class="play-app" data-disclosure="play-app:${e(accountId)}:${e(item.packageName)}">
      <summary class="play-app-row">
        <span class="play-app-name">
          <span class="play-title">${e(item.name||item.packageName)}</span>
          <span class="mono play-package">${e(item.packageName)}</span>
        </span>
        <span class="play-app-status">${status==='unknown'&&check?'':label(status)}${check?label(check):''}</span>
        <span class="play-chevron" aria-hidden="true"></span>
      </summary>
      <div class="play-app-tracks">${(item.tracks??[]).map(playTrack).join('')}
        <div class="actions">${button('스토어 페이지 ↗','external','data-url="'+e(item.storeUrl)+'"','small')}</div>
        ${playLinkBlock({account,app:item,links:ui.play?.links,projects:ui.state?.projects,internal:ui.internal.get(linkKey(accountId,item.packageName))})}
      </div>
    </details></li>`).join('')+'</ul>';
}
function playTrack(track) {
  const releases=track.releases??[];
  return `<div class="track">
    <div class="track-header"><strong>${e(track.track)}</strong>${track.stale?badge('stale'):`<span class="hint">${e(localDate(track.observedAt))}</span>`}</div>
    ${releases.length?releases.map(release=>`<div class="release-row">
      <span>${e(release.name||'이름 없는 릴리스')}</span><span class="mono">v${e(release.versionCodes.join(', '))}</span>
      <span class="badge">${e(releaseState(release.state))}</span></div>`).join(''):`<p>${track.error?'조회 결과 없음':'활성 릴리스 없음'}</p>`}
    ${track.stale?`<p>마지막 성공한 관측 · ${e(localDate(track.observedAt))}</p>`:''}
    ${track.error?`<p class="play-track-error">${e(track.error.message??track.error)}</p>`:''}
  </div>`;
}
function updatePlayResults() {
  const results=app.querySelector('#play-results');
  if(!results)return;
  const account=selectedPlayAccount();
  const apps=account?.apps??[],matches=filteredPlayApps(apps);
  rememberDisclosures(results);
  results.innerHTML=playAppList(matches,account);
  restoreDisclosures(results);
  const count=app.querySelector('#play-result-count');
  const nextCount=playResultCount(matches.length,apps.length);
  if(count&&count.textContent!==nextCount)count.textContent=nextCount;
}
function renderPlay() {
  const accounts=ui.play?.accounts??[],account=selectedPlayAccount();
  const header='<section class="hero play-hero"><div class="hero-row"><h1>Play Store</h1>'+button('+ 계정 연결','new-account','','small')+'</div></section>';
  if(ui.newAccount)return header+accountForm();
  if(!ui.play&&!ui.error)return header+'<p class="muted">Play 계정을 불러오고 있습니다.</p>';
  if(!account)return header+empty('Play 개발자 계정을 연결하세요','Google Play API 조회 권한이 있는 서비스 계정이 필요합니다. 자격 증명은 운영체제 키 저장소에 보관합니다.',button('첫 계정 연결','new-account','','primary'));
  const accountData='data-account="'+e(account.id)+'"';
  const apps=account.apps??[],matches=filteredPlayApps(apps);
  return header+`<div class="account-switcher" role="group" aria-label="Play 개발자 계정">
    ${accounts.map(item=>button(e(item.name),'select-account','data-account="'+e(item.id)+'" aria-pressed="'+(item.id===account.id)+'"',item.id===account.id?'active':'')).join('')}
    </div>
    <section class="play-account">
      <div class="play-account-toolbar">
        <span class="hint">마지막 점검 · ${e(localDate(account.checkedAt))}</span>
        ${button('지금 점검','check-play',accountData,'primary small')}
      </div>
      <details class="play-account-settings" data-disclosure="play-account:${e(account.id)}">
        <summary>계정 관리</summary>
        ${account.developerId?`<p class="hint">개발자 계정 ID <span class="mono">${e(account.developerId)}</span></p>`:''}
        <p class="hint">${e(account.tracks.join(' · '))}</p>
        <div class="actions">${button('계정 설정','edit-account',accountData,'small')}${button('연결 해제','remove-account',accountData,'small danger')}</div>
      </details>
      ${account.error?`<div class="callout error">${e(account.error.message??account.error)}</div>`:''}
      ${ui.play?.linksError?`<div class="callout warning">프로젝트 연결 · ${e(ui.play.linksError)}</div>`:''}
      ${account.discovery?.error?`<div class="callout warning">앱 자동 조회 · ${e(account.discovery.error.message??account.discovery.error)}</div>`:''}
    </section>
    ${apps.length?`<section class="play-catalog" aria-labelledby="play-app-list-title">
      <div class="section-heading play-list-heading">
        <h2 id="play-app-list-title">앱 목록</h2><span class="hint" id="play-result-count" role="status">${playResultCount(matches.length,apps.length)}</span>
      </div>
      <div class="play-filters">
        <div><label class="label" for="play-search">앱 검색</label>
          <input type="search" class="field" id="play-search" placeholder="앱 이름 또는 패키지명" autocomplete="off" value="${e(playFilters.query)}">
        </div>
        <div><label class="label" for="play-status-filter">상태 필터</label>
          <select class="field" id="play-status-filter">${options(playFiltersForSelect,playFilters.status)}</select>
        </div>
      </div>
      <div id="play-results">${playAppList(matches,account)}</div>
    </section>`:empty('아직 점검 결과가 없습니다','지금 점검을 눌러 앱 목록과 트랙별 릴리스 상태를 읽어오세요.')}`;
}
function releaseState(value) {
  const names={RELEASE_LIFECYCLE_STATE_DRAFT:'초안',RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW:'심사 제출 전',RELEASE_LIFECYCLE_STATE_IN_REVIEW:'심사 중',RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED:'승인 · 게시 전',RELEASE_LIFECYCLE_STATE_NOT_APPROVED:'승인되지 않음',RELEASE_LIFECYCLE_STATE_PUBLISHED:'게시됨'};
  return names[value]??({not_sent_for_review:'심사 제출 전',not_approved:'승인되지 않음'})[value]??statusNames[value]??value;
}
function accountForm() {
  const id=typeof ui.newAccount==='string'?ui.newAccount:null;
  const account=ui.play?.accounts?.find(a=>a.id===id);
  const def=(name,value='')=>draft('account',name,value);
  return '<section class="card"><div class="section-heading"><h2>'+(account?'계정 설정':'개발자 계정 연결')+'</h2>'+button('닫기','close-account','','small')+'</div><form id="account" '+(id?'data-account="'+e(id)+'"':'')+'><label class="label" for="account-name">계정 이름</label><input class="field" id="account-name" name="name" value="'+e(def('name',account?.name??''))+'" required placeholder="예: Toris"><label class="label" for="account-developer-id">Play 개발자 계정 ID</label><input class="field mono" id="account-developer-id" name="developerId" inputmode="numeric" pattern="[0-9]{19}" maxlength="19" value="'+e(def('developerId',account?.developerId??''))+'"><p class="hint">Auto App에서 제출 대상으로 사용하려면 Play Console에 표시된 19자리 ID와 패키지 목록을 입력하세요.</p><label class="label" for="credential-path">이 컴퓨터의 서비스 계정 JSON 경로</label><input class="field mono" id="credential-path" name="credentialPath" value="" autocomplete="off" placeholder="~/.config/google/play-service-account.json"><p class="hint">'+(account?'비워두면 현재 키를 유지합니다.':'Orca가 실행되는 컴퓨터의 절대 경로 또는 ~/ 경로를 입력하세요.')+' 가져온 원문은 화면에 다시 표시하지 않습니다.</p><details class="spacer"><summary>JSON 직접 붙여넣기</summary><textarea class="field mono" name="serviceAccountJson" aria-label="서비스 계정 JSON" autocomplete="off" spellcheck="false" placeholder="서비스 계정 JSON 원문 · 로컬 경로와 둘 중 하나만 입력"></textarea></details><label class="label" for="account-packages">계정의 패키지 목록 (비워두면 전체 자동 조회)</label><textarea class="field mono" id="account-packages" name="packages" placeholder="com.example.app&#10;com.example.other">'+e(def('packages',account?.packages?.join('\n')??''))+'</textarea><label class="label" for="account-tracks">조회할 트랙 · 줄바꿈 또는 쉼표로 구분</label><input class="field" id="account-tracks" name="tracks" value="'+e(def('tracks',account?.tracks?.join(', ')??'production, beta, alpha, internal'))+'" required><p class="hint">이름을 지정한 비공개 테스트나 기기별 트랙도 추가할 수 있습니다.</p><div class="callout">Google Play Console에서 해당 서비스 계정에 필요한 조회 권한을 부여해 주세요. 앱 자동 조회에는 Play Developer Reporting API를 사용합니다.</div><div class="actions"><button class="button primary" type="submit">'+(account?'설정 저장':'계정 연결')+'</button></div></form></section>';
}
function renderAgents() {
  const agents=ui.state?.agents??[],item=run();
  const limits=ui.state?.limits;
  let html='<section class="hero flow-tab"><h1>팀별 에이전트</h1>'+(limits?'<p class="limits-line"><strong>작업 '+e(limits.active)+' / '+e(limits.activeJobs)+'</strong> · 빌드·테스트 '+e(limits.heavy)+' / '+e(limits.heavyJobs)+'<span class="hint"> Neon이 배정하는 작업에만 적용됩니다. 직접 실행한 다른 에이전트는 세지 않습니다. 한도는 플러그인 설정에서 바꿀 수 있습니다.</span></p>':'')+'</section>'+operationsOverview({runs:ui.state?.runs??[],limits,resources:ui.state?.resources,now:Date.now()});
  if(item) {
    selectedNode(item);const ctx=flowContext(item);
    html+='<div class="agent-overview">'+runPicker(item)+collabStrip(item,ctx)+teamNavigator(item,ctx)+'</div><div class="people">'+people(item,ctx)+'</div>';
    html+='<section class="section"><details class="card" data-disclosure="assignments"><summary>전체 배정 · '+(item.nodes?.length??0)+'개 단계</summary><p class="hint">모델과 추론 설정은 각 에이전트의 Orca 설정을 따릅니다. 검토자는 매번 별도 세션으로 시작합니다.</p>'+assignmentForm(item,item.nodes??[],ctx)+'</details></section>';
  } else html+=empty('아직 흐름이 없습니다','Auto App에서 흐름을 만들면 팀별 담당자와 검토자가 여기에 나타납니다.',button('앱 제작 흐름 만들기','new-run','','primary'));
  html+='<section class="section"><details class="card" data-disclosure="workspace-agents"><summary>현재 작업 공간의 Orca 에이전트 · '+agents.length+'</summary>';
  html+=agents.length?'<div class="agent-grid">'+agents.map(a=>'<div class="card agent-card"><div class="card-head"><h3>'+e(a.title??a.agent??'Agent')+'</h3>'+badge(a.state)+'</div><p>'+e(a.agent??'')+' · '+e(localDate(a.stateStartedAt))+'</p>'+(a.terminalId&&ownedTerminal(a.terminalId)?'<div class="actions">'+button('열기','focus-terminal','data-terminal="'+e(a.terminalId)+'"','small')+'</div>':'')+'</div>').join('')+'</div>':'<p class="hint">현재 공간에서 확인되는 에이전트가 없습니다.</p>';
  html+='<p class="hint spacer">배정 가능한 종류 · '+providers().map(e).join(', ')+'. CLI 설치와 로그인은 Orca에서 먼저 완료해 주세요.</p></details></section>';
  return html;
}
// Elapsed times tick locally; nothing is re-requested and typed text is untouched.
function tickTimes() {
  const now=Date.now();
  for(const time of app.querySelectorAll('time[data-since]')){
    if(document.activeElement?.contains?.(time))continue; // a focused control's text stays stable
    const text=elapsed(time.dataset.since,now);
    if(time.textContent!==text)time.textContent=text;
  }
}
function assignmentChange(node,values) {
  const change={};
  for(const field of ['agent','reviewer'])if(values[node.id+'.'+field]!==undefined&&values[node.id+'.'+field]!==node[field])change[field]=values[node.id+'.'+field];
  const ecc=values[node.id+'.eccAgent'];
  if(ecc!==undefined&&ecc!==(eccOverride(node)??''))change.eccAgent=ecc;
  for(const field of ['model','effort'])if(values[node.id+'.'+field]!==undefined&&values[node.id+'.'+field]!==(node[field]??''))change[field]=values[node.id+'.'+field];
  return change;
}
function clearDraft(form) {
  for(const key of Object.keys(ui.drafts))if(key.startsWith(form+'.'))delete ui.drafts[key];
  dirtyForms.delete(form);
}
app.addEventListener('input',event=>{
  const target=event.target;
  if(target.id==='play-search') {
    playFilters.query=target.value;updatePlayResults();return;
  }
  const form=target.closest('form');
  if(form&&target.name) {
    dirtyForms.add(form.id);
    if(!['serviceAccountJson','credentialPath'].includes(target.name))ui.drafts[form.id+'.'+target.name]=target.type==='checkbox'?target.checked:target.value;
  }
});
app.addEventListener('change',event=>{
  const target=event.target;
  if(target.id==='play-status-filter') {
    playFilters.status=target.value;updatePlayResults();return;
  }
  const form=target.closest?.('form');
  if(form&&target.name){dirtyForms.add(form.id);if(!['serviceAccountJson','credentialPath'].includes(target.name))ui.drafts[form.id+'.'+target.name]=target.type==='checkbox'?target.checked:target.value;}
  if(target.id==='run-select'){leaveView();ui.runId=target.value;ui.nodeId=null;ui.agentRole=null;clearDraft('assignments');clearDraft('approval');render();loadSelectedDetail();}
  if(target.id==='actual-submission') {
    const fields=app.querySelector('#submission-fields');if(fields) fields.hidden=!target.checked;
    for(const field of app.querySelectorAll('#submission-fields select, #submission-fields input:not([readonly])'))field.required=target.checked;
  }
});
app.addEventListener('click',async event=>{
  const target=event.target.closest('[data-action]');
  if(!target||target.disabled)return;
  const action=target.dataset.action;
  if(action==='tab'){leaveView();ui.tab=target.dataset.tab;ui.error=null;const epoch=navigation;render();try{await hydrateTab();if(epoch===navigation)render();}catch(err){if(epoch===navigation){ui.error=err.message;render();}}return;}
  if(['select-node','select-agent','inspect-stage','show-agent','open-stage'].includes(action)) {
    const nextTab=action==='show-agent'?'agents':action==='open-stage'?'studio':ui.tab;
    const switched=nextTab!==ui.tab;
    if(switched)leaveView();
    if(ui.nodeId!==target.dataset.node || switched)clearDraft('approval');
    ui.nodeId=target.dataset.node;
    ui.agentRole=target.dataset.role==='work'||target.dataset.role==='review'?target.dataset.role:null;
    ui.tab=nextTab;
    render();
    const selector=action==='inspect-stage'?'#stage-inspector':ui.tab==='studio'?'#stage-'+ui.nodeId
      :ui.agentRole?'#member-'+ui.nodeId+'-'+ui.agentRole:'#pair-'+ui.nodeId;
    const focus=app.querySelector(selector);
    focus?.focus?.({preventScroll:true});
    focus?.scrollIntoView?.({block:action==='inspect-stage'?'start':'nearest',behavior:'instant'});
    if(switched) {
      const epoch=navigation;
      hydrateTab().then(()=>{if(epoch===navigation)scheduleRender();},error=>{if(epoch===navigation){ui.error=error.message;scheduleRender();}});
    }
    return;
  }
  if(action==='open-run'){leaveView();ui.runId=target.dataset.run;ui.tab='studio';ui.newRun=false;ui.nodeId=null;ui.agentRole=null;clearDraft('assignments');clearDraft('approval');render();await loadSelectedDetail();return;}
  if(action==='new-run'){leaveView();delete ui.drafts['new-run.parentRunId'];ui.newRun=true;ui.tab='studio';render();return;}
  if(action==='resume-existing'){const item=(ui.state?.runs??[]).find(r=>r.id===target.dataset.run);if(item?.status==='paused')await request('runs.resume',{runId:item.id});leaveView();ui.runId=target.dataset.run;ui.newRun=false;render();await loadSelectedDetail();return;}
  if(action==='pick-candidate'){const created=await request('runs.create',{fromDiagnosis:{runId:target.dataset.run,index:Number(target.dataset.index)}});leaveView();ui.runId=created.id;ui.nodeId=null;toast('후보로 개선 흐름을 만들었습니다. 같은 후보를 다시 고르면 이 흐름이 열립니다.');render();await loadSelectedDetail();return;}
  if(action==='load-artifact'){await loadArtifact(target.dataset.run,target.dataset.path);return;}
  if(action==='export-history'){target.disabled=true;const done=await exportHistory({runId:target.dataset.run,confirm:target.dataset.confirm==='true',request}).catch(err=>({pending:null,error:err.message}));ui.exportConfirm=done.pending??null;render();(done.pending?app.querySelector('[data-action="export-history"][data-confirm="true"]'):[...app.querySelectorAll('[data-action="export-history"]')].find(item=>item.dataset.run===target.dataset.run))?.focus?.();toast(done.error?'내보내지 않았습니다: '+done.error:done.message,Boolean(done.error));return;}
  if(action==='improve-result'){const item=run()?.id===target.dataset.run?run():(ui.state?.runs??[]).find(r=>r.id===target.dataset.run);if(!item)return;leaveView();Object.assign(ui.drafts,{'new-run.flowType':'improve','new-run.projectId':item.projectId,'new-run.parentRunId':item.id});ui.newRun=true;ui.tab='studio';render();document.querySelector('#app-goal')?.focus?.();if(!ui.play){try{ui.play=await request('play.list');}catch(err){toast('Play 계정을 불러오지 못했습니다: '+err.message);}render();}return;}
  if(action==='flow-type'){ui.drafts['new-run.flowType']=target.dataset.type;render();if(['improve','diagnose'].includes(target.dataset.type)&&!ui.play){try{ui.play=await request('play.list');}catch(err){toast('Play 계정을 불러오지 못했습니다: '+err.message);}render();}return;}
  if(action==='close-new'){leaveView();ui.newRun=false;render();loadSelectedDetail();return;}
  if(action==='new-account'){leaveView();clearDraft('account');ui.newAccount=true;ui.tab='play';render();return;}
  if(action==='close-account'){leaveView();ui.newAccount=false;clearDraft('account');render();return;}
  if(action==='edit-account'){leaveView();clearDraft('account');ui.newAccount=target.dataset.account;render();return;}
  if(action==='select-account'){ui.accountId=target.dataset.account;render();return;}
  if(action==='reset-play-filters') {
    playFilters.query='';playFilters.status='all';
    const search=app.querySelector('#play-search'),filter=app.querySelector('#play-status-filter');
    search.value='';filter.value='all';updatePlayResults();search.focus();return;
  }
  if(action==='select-day'){ui.day=target.dataset.day;ui.feedLimit=8;render();return;}
  if(action==='more-feed'){ui.feedLimit+=8;render();return;}
  if(action==='more-sessions'){ui.sessionLimit+=12;render();return;}
  if(action==='more-runs'){ui.runLimit=(ui.runLimit??4)+4;render();return;}
  if(action==='more-events'){ui.eventLimits??={};ui.eventLimits[target.dataset.key]=(ui.eventLimits[target.dataset.key]??8)+20;render();return;}
  if(action==='more-notes'){await moreNotes();return;}
  if(action==='open-archive') {
    const id=target.dataset.run,epoch=navigation;ui.archiveId=ui.archiveId===id?null:id;render();
    if(ui.archiveId){try{await ensureRunDetail(id);if(epoch===navigation&&ui.archiveId===id)render();}catch(error){toast(error.message,true);}}
    return;
  }
  if(action==='refresh'){await refresh({forceHost:true});return;}
  if(action==='check-disk'){const id=target.dataset.run;loadDisk(id);render();[...app.querySelectorAll('[data-action="check-disk"]')].find(item=>item.dataset.run===id)?.focus?.();return;}
  if(action==='recheck-preflight'){loadPreflight(target.dataset.run,true,{announce:true});render();focusRecheck(target.dataset.run);return;}
  target.disabled=true;
  try {
    const methods={'start-run':'runs.start','pause-run':'runs.pause','resume-run':'runs.resume','cancel-run':'runs.cancel','refresh-run':'runs.refresh'};
    if(methods[action]) {
      const cancelling=action==='cancel-run'?target.dataset.run:null;
      if(cancelling){ui.cancelling.add(cancelling);render();}
      let result;
      try{result=await request(methods[action],{runId:target.dataset.run});}finally{if(cancelling)ui.cancelling.delete(cancelling);}
      if(action==='start-run')loadPreflight(target.dataset.run); // the worker checked again just before starting
      toast(action==='pause-run'?'새 단계 배정만 멈췄습니다. 작업 중인 에이전트는 계속 작업합니다.':cancelling?(result?.cancelUnsaved?'취소를 아직 저장하지 못했습니다. 새 단계는 배정하지 않고, 저장되면 에이전트를 닫습니다.':result?.stopFailures?.length?'취소했지만 일부 에이전트의 종료를 확인해야 합니다. 실행 카드에서 확인하세요.':'취소 완료: Neon이 배정한 에이전트 터미널의 종료를 Orca가 확인했습니다.'):'작업 상태를 갱신했습니다.');
    } else if(action==='retry-node') {
      const selected=run()?.nodes?.find(n=>n.id===target.dataset.node);
      const acknowledgeUncertain=app.querySelector('#retry-ack')?.checked===true;
      if(selected?.launchUncertain&&!acknowledgeUncertain)throw new Error('Orca에서 이전 실행 상태를 확인한 후 체크해 주세요.');
      await request('nodes.retry',{runId:target.dataset.run,nodeId:target.dataset.node,acknowledgeUncertain,stopPrevious:app.querySelector('#retry-stop')?.checked===true,...(target.dataset.nonce?{expectedNonce:target.dataset.nonce}:{})});
    }
    else if(action==='deliver-prompt') {
      if(app.querySelector('#delivery-ack')?.checked!==true)throw new Error('이전 에이전트의 빈 입력 화면을 확인한 후 체크해 주세요.');
      await request('nodes.deliverPrompt',{runId:target.dataset.run,nodeId:target.dataset.node,acknowledgeUnsent:true,...(target.dataset.nonce?{expectedNonce:target.dataset.nonce}:{})});
      toast('기존 터미널에 지시를 전달했습니다. 일시정지 상태라면 재개를 눌러 주세요.');
    }
    else if(action==='toggle-terminal-cleanup'){const enabled=target.dataset.enabled==='true';await request('runs.setTerminalCleanup',{runId:target.dataset.run,enabled});toast(enabled?'끝난 에이전트 터미널을 자동으로 닫습니다.':'끝난 에이전트 터미널을 열어 둡니다.');}
    else if(action==='toggle-autonomy'){const enabled=target.dataset.enabled==='true';await request('runs.setAutonomous',{runId:target.dataset.run,enabled});toast(enabled?'자율 진행을 켰습니다. 외부 제출 전까지 사람 없이 진행합니다.':'자율 진행을 껐습니다.');}
    else if(action==='archive-run'){await request('runs.archive',{runId:target.dataset.run});ui.runId=null;toast('기록을 보존하고 실행을 보관했습니다.');}
    else if(action==='release-slot'){if(app.querySelector('#release-ack-'+CSS.escape(target.dataset.nonce))?.checked!==true)throw new Error('Orca에서 실행 중인 에이전트가 없는지 확인한 후 체크해 주세요.');await request('jobs.releaseUncertain',{runId:target.dataset.run,nonce:target.dataset.nonce,confirmed:true,by:'panel'});toast('확인한 내용으로 슬롯을 해제했습니다. 누가·언제 해제했는지 실행 기록에 남겼습니다.');}
    else if(action==='open-workspace')await request('workspace.open',{workspaceId:target.dataset.workspace});
    else if(action==='focus-terminal')await request('terminals.focus',{terminalId:target.dataset.terminal});
    else if(action==='resume-note') {
      const picker=[...app.querySelectorAll('[data-note-agent]')].find(p=>p.dataset.noteAgent===target.dataset.workspace);
      const result=await request('today.resume',{workspaceId:target.dataset.workspace,agent:picker?.value??'codex'});
      toast(result.reused?(result.agentState==='done'?'이 인계의 작업은 이미 종료됐습니다. 새 인계 메모를 저장하면 새 작업을 시작할 수 있습니다.':'기존 이어하기 에이전트를 사용합니다.'):'저장한 맥락으로 이어하기를 시작했습니다.');
    } else if(action==='reverify-note') {
      const picker=[...app.querySelectorAll('[data-note-agent]')].find(p=>p.dataset.noteAgent===target.dataset.workspace);
      const result=await request('today.resume',{workspaceId:target.dataset.workspace,agent:picker?.value??'codex',mode:'reverify'});
      toast(result.reused?(result.agentState==='done'?'이 코드 상태는 이미 재검증했습니다. 코드가 바뀌면 다시 재검증할 수 있습니다.':'진행 중인 재검증 에이전트를 사용합니다.'):'바뀐 범위의 재검증을 시작했습니다. 새로 실행한 검증만 통과로 보고합니다.');
    } else if(['play-action','play-internal','play-unlink'].includes(action)) {
      const key=linkKey(target.dataset.account,target.dataset.package),input={accountId:target.dataset.account,packageName:target.dataset.package};
      if(action==='play-unlink'){await request('play.link.remove',input);toast('Play 앱과 프로젝트의 연결을 해제했습니다.');}
      else if(action==='play-internal'){toast('internal 트랙을 다시 읽고 있습니다.');const result=await request('play.internalCheck',input);ui.internal.set(key,result);toast(result.text);}
      else {
        const reason=[...app.querySelectorAll('[data-play-reason]')].find(field=>field.dataset.playReason===key)?.value;
        const created=await request('play.action.start',{...input,action:target.dataset.kind,agent:'codex',reviewer:'claude',...(reason?.trim()?{rejectionReason:reason}:{})});
        leaveView();ui.runId=created.id;ui.tab='studio';ui.newRun=false;ui.nodeId=null;
        toast('실행 계획을 만들었습니다. 실행 전 점검을 확인하고 시작하세요. 같은 작업을 다시 누르면 이 실행이 열립니다.');
      }
    } else if(action==='resume-session') {
      await request('today.resume',{workspaceId:target.dataset.workspace,agent:target.dataset.agent,sessionId:target.dataset.session});
      toast('이전 세션을 이어갑니다.');
    } else if(action==='check-play') {
      toast('트랙별 현재 상태를 읽고 있습니다.');
      await request('play.check',{accountId:target.dataset.account,force:true});
      toast('점검 결과를 갱신했습니다.');
    } else if(action==='remove-account') {
      if(target.dataset.confirm!=='yes') {
        target.dataset.confirm='yes';target.textContent='다시 눌러 연결 해제';target.disabled=false;return;
      }
      await request('play.account.remove',{accountId:target.dataset.account});
      toast('이 플러그인의 계정 연결과 보관 키를 제거했습니다.');
    } else if(action==='external') {
      const url=new URL(target.dataset.url);
      if(url.protocol!=='https:')throw new Error('HTTPS 주소만 열 수 있습니다.');
      await bridge.shell.openExternal(url.href);return;
    }
    await refresh({quiet:true});
  } catch(error){toast(error.message??String(error),true);}
  finally{target.disabled=false;}
});
app.addEventListener('submit',async event=>{
  const form=event.target;
  event.preventDefault();
  const submit=form.querySelector('[type="submit"]');
  if(submit.disabled)return;
  submit.disabled=true;
  const values=Object.fromEntries(new FormData(form));
  try {
    if(form.id==='new-run') {
      const data=newRunPayload(values); // a named template, never a stage list (panel/newflow.mjs)
      const created=await request('runs.create',data);
      ui.runId=created.id;ui.newRun=false;ui.nodeId=null;clearDraft('new-run');toast(data.template==='improve'?'개선 흐름을 만들었습니다. 앱 정체성 확인부터 시작합니다.':data.template==='diagnose'?'진단 흐름을 만들었습니다. 시작하면 개선 후보를 찾습니다.':'앱 제작 그래프를 만들었습니다. 배정을 확인하고 시작하세요.');
    } else if(form.id==='assignments') {
      const item=run(),assignments=Object.fromEntries(item.nodes.filter(assignmentMutable).map(n=>[n.id,assignmentChange(n,values)]).filter(([,change])=>Object.keys(change).length));
      if(!Object.keys(assignments).length){toast('변경된 팀 배정이 없습니다.');return;}
      await request('runs.updateAssignments',{runId:form.dataset.run,assignments});clearDraft('assignments');toast('팀 배정을 저장했습니다.');
    } else if(form.id==='approval') {
      const input={runId:form.dataset.run,nodeId:form.dataset.node,note:values.note};
      if(values.actualSubmission) {
        const account=submissionAccounts.find(item=>playAccountValue(item)===values.playAccount);
        if(!account)throw new Error('Play 개발자 계정을 선택해 주세요.');
        if(!values.packageName||!values.track||!Number.isInteger(Number(values.versionCode))||Number(values.versionCode)<1)throw new Error('제출할 패키지·트랙·버전 코드를 모두 입력해 주세요.');
        input.submission={accountId:account.id,developerId:account.developerId,packageName:values.packageName.trim(),track:values.track.trim(),versionCode:Number(values.versionCode)};
      }
      await request('runs.approve',input);clearDraft('approval');toast(input.submission?'지정한 제출 범위로 승인했습니다.':'준비·검토 단계의 범위를 승인했습니다.');
    } else if(form.id==='catalog-approval') {
      await request('runs.approve',catalogApprovalInput(form,values));clearDraft('catalog-approval');toast('상품 등록을 확인했습니다. 내부 테스트 준비를 이어갑니다.');
    } else if(form.id==='attach-workspace') {
      await request('runs.attachWorkspace',{runId:form.dataset.run,workspaceId:values.workspaceId});
      toast('작업 공간을 연결했습니다. 배정을 확인한 뒤 재개해 주세요.');
    } else if(form.dataset?.form==='play-link') {
      await request('play.link.save',{accountId:form.dataset.account,packageName:form.dataset.package,projectId:values.projectId});clearDraft(form.id);toast('Play 앱을 프로젝트에 연결했습니다.');
    } else if(form.id==='handoff') {
      await request('today.save',values);clearDraft('handoff');toast('다음에 이어갈 맥락을 저장했습니다.');
    } else if(form.id==='account') {
      const split=value=>String(value??'').split(/[\n,]/).map(s=>s.trim()).filter(Boolean);
      const input={name:values.name,developerId:values.developerId?.trim()||null,packages:split(values.packages),tracks:split(values.tracks)};
      if(form.dataset.account)input.id=form.dataset.account;
      if(values.credentialPath?.trim())input.credentialPath=values.credentialPath.trim();
      if(values.serviceAccountJson?.trim())input.serviceAccountJson=values.serviceAccountJson.trim();
      const account=await request('play.account.save',input);
      ui.accountId=account.id;ui.newAccount=false;clearDraft('account');toast('계정 연결 정보를 저장했습니다.');
    }
    await refresh({quiet:true});
  } catch(error){toast(error.message??String(error),true);}
  finally {
    for(const field of form.querySelectorAll('[name="serviceAccountJson"],[name="credentialPath"]'))field.value='';
    submit.disabled=false;
  }
});
if(bridge?.plugin) {
  bridge.plugin.on('state.changed',state=>{
    if(!acceptState(state))return;
    scheduleRender();
    if(ui.tab==='studio'&&!ui.newRun)scheduleDetail();
  });
  refresh();
} else {
  ui.error='Orca 연결이 없습니다. Orca에서 Toris Neon 패널을 열어 주세요.';
  render();
}
if(typeof setInterval==='function')setInterval(tickTimes,1000);
