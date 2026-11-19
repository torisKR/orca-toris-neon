const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const bridge = window.orca;
const ui = {tab:'today',state:null,today:null,play:null,runId:null,nodeId:null,accountId:null,newRun:false,newAccount:false,error:null,busy:false,drafts:{}};
const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const statusNames = {ready:'실행 준비',pending:'대기',running:'진행 중',review:'검토',passed:'통과',failed:'실패',blocked:'확인 필요',paused:'일시 정지',cancelled:'취소',completed:'완료','awaiting-approval':'승인 대기',waiting:'응답 대기',working:'작업 중',done:'에이전트 종료',fresh:'현재 코드와 일치',stale:'재확인 필요',unknown:'미확인',published:'게시됨',testing:'테스트 중',in_review:'심사 중',rejected:'거부됨',draft:'초안',approved_not_published:'승인 · 게시 전',no_release:'릴리스 없음'};
const nodeNames = {research:'시장·앱 조사',brief:'제품 기획',architecture:'구조 설계',design:'화면·상호작용 설계',assets:'앱 에셋',build:'앱 구현',test:'테스트·수정 루프',policy:'Play 정책·권한 점검',listing:'스토어 자료 준비',internal:'내부 테스트 준비',release:'출시 검토'};
const descriptions = {research:'사용자 문제, 유사 앱, 차별점과 확인한 근거를 정리합니다.',brief:'첫 버전의 범위와 수락 기준을 고정합니다.',architecture:'앱 구조, 데이터 흐름, 구현 책임을 나눕니다.',design:'실제 화면과 상태, 상호작용을 설계합니다.',assets:'앱에서 사용할 에셋과 출처를 정리합니다.',build:'설계와 에셋을 연결해 앱을 구현합니다.',test:'검증 결과와 결함을 기록합니다. 실패하면 구현 단계로 돌아갑니다.',policy:'구현한 코드의 권한, 개인정보와 스토어 정책 준비 상태를 검토합니다.',listing:'스토어 문구와 스크린샷 등 제출 자료를 준비합니다.',internal:'내부 테스트 자료를 준비합니다. 실제 제출은 계정과 대상을 확인한 명시 승인이 필요합니다.',release:'출시 준비 상태를 검토합니다. 실제 제출을 승인할 때 패키지·트랙·버전을 지정합니다.'};
const badge = status => '<span class="badge '+e(status)+'">'+e(statusNames[status]??status??'미확인')+'</span>';
const localDate = (value,short=false) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '—';
  return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',...(short?{}:{month:'short',day:'numeric'}),hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
};
const todayDate = () => new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',weekday:'short'}).format(new Date());
const title = node => nodeNames[node.id]??node.title;
const assignmentMutable = node => !node.active && !['passed','awaiting-approval'].includes(node.status);
const ownedTerminal = id => (ui.state?.runs??[]).some(r=>(r.jobs??[]).some(j=>j.terminalId===id));
const draft = (form,name,fallback='') => ui.drafts[form+'.'+name]??fallback;
const button = (text,action,extra='',className='') => '<button type="button" class="button '+className+'" data-action="'+action+'" '+extra+'>'+text+'</button>';
const providers = () => (ui.state?.providers??['codex','claude','cursor','grok','antigravity','gemini','opencode','kiro']).map(p=>typeof p==='string'?p:p.id);
const options = (values,selected) => values.map(item => {
  const value=typeof item==='object'?item.value:item,label=typeof item==='object'?item.label:item;
  return '<option value="'+e(value)+'" '+(String(value)===String(selected)?'selected':'')+'>'+e(label)+'</option>';
}).join('');
const providerOptions = selected => options(providers(),selected);
const run = () => ui.state?.runs?.find(item=>item.id===ui.runId)??ui.state?.runs?.[0];
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
  if (ui.tab==='today') ui.today=await request('today.snapshot');
  if (ui.tab==='play') {
    ui.play=await request('play.list');
    if (!ui.play.accounts.some(a=>a.id===ui.accountId)) ui.accountId=ui.play.accounts[0]?.id??null;
  }
}
async function refresh({quiet=false}={}) {
  if (ui.busy) return;
  ui.busy=true;
  if(!quiet) render();
  try {
    ui.state=await request('state.get');
    if(!ui.state.runs?.some(r=>r.id===ui.runId)) ui.runId=ui.state.runs?.[0]?.id??null;
    await hydrateTab();
    ui.error=null;
  } catch(error) {ui.error=error.message??String(error);}
  finally {ui.busy=false;render();}
}
const empty = (heading,text,action) => '<div class="empty"><div class="empty-icon">◇</div><h3>'+e(heading)+'</h3><p>'+e(text)+'</p>'+(action??'')+'</div>';
function render() {
  const active=(ui.state?.runs??[]).filter(r=>r.status==='running').length;
  app.setAttribute('aria-busy',String(ui.busy));
  app.innerHTML='<div class="shell"><header class="topbar"><div class="brand-mark" aria-hidden="true">N</div><div class="grow"><div class="brand-name">TORIS NEON</div><div class="brand-meta"><span>APP STUDIO</span><span>·</span><span>FOR ORCA</span></div></div><div class="top-actions"><span class="status-label"><i class="dot '+(!ui.state?'offline':'')+'"></i>'+(active?active+'개 실행':ui.state?'연결됨':'연결 대기')+'</span><button class="icon-button" data-action="refresh" aria-label="새로고침" title="새로고침" '+(ui.busy?'disabled':'')+'>↻</button></div></header><nav class="nav" aria-label="주요 메뉴">'+[['today','오늘 이어하기'],['studio','Auto App'],['play','Play Store'],['agents','에이전트']].map(([id,label])=>'<button data-action="tab" data-tab="'+id+'" class="'+(ui.tab===id?'active':'')+'" aria-current="'+(ui.tab===id?'page':'false')+'">'+label+'</button>').join('')+'</nav><main class="main">'+(ui.error?'<div class="callout error page-error" role="alert">'+e(ui.error)+'</div>':'')+(ui.state?.warnings??[]).map(w=>'<div class="callout warning">'+e(w)+'</div>').join('')+(ui.tab==='today'?renderToday():ui.tab==='studio'?renderStudio():ui.tab==='play'?renderPlay():renderAgents())+'<footer class="footer"><span>상태와 근거를 남기는 앱 제작 공간</span><span>v0.1.0 · Asia/Seoul</span></footer></main></div>';
  requestAnimationFrame(drawGraph);
}
function renderToday() {
  const data=ui.today;
  const runs=ui.state?.runs??[];
  const yesterdayCount=(data?.yesterdayEvents?.length??0)+(data?.worklogs?.filter(w=>w.day===data.yesterdayDate).length??0);
  const waiting=runs.filter(r=>r.status==='blocked'||r.nodes?.some(n=>n.status==='awaiting-approval')).length;
  let html='<section class="hero"><div class="hero-row"><div><p class="eyebrow">PICK UP WHERE YOU LEFT OFF</p><h1>오늘의 다음 한 걸음</h1></div><span class="date-pill">'+e(todayDate())+'</span></div><p>어제 남긴 맥락과 검증 결과에서, 오늘의 작업을 시작하세요.</p></section><div class="stats"><div class="stat"><div class="stat-label">어제의 기록</div><div class="stat-value">'+yesterdayCount+'<span>건</span></div></div><div class="stat"><div class="stat-label">진행 중</div><div class="stat-value">'+runs.filter(r=>r.status==='running').length+'<span>프로젝트</span></div></div><div class="stat"><div class="stat-label">확인이 필요해요</div><div class="stat-value">'+waiting+'<span>건</span></div></div></div>';
  if(!data) html+=empty(ui.busy?'기록을 읽고 있습니다':'기록을 연결해 주세요','Orca 작업 공간과 날짜별 인계 기록이 이곳에 표시됩니다.');
  else {
    html+=(data.warnings??[]).map(w=>'<div class="callout warning">'+e(w)+'</div>').join('');
    html+='<div class="section-heading"><div><h2>이어서 할 일</h2><p>새로 시작할 필요 없이, 남긴 지점에서 계속합니다.</p></div>'+button('+ 새 앱','new-run','','small')+'</div>';
    const incomplete=runs.filter(r=>!['completed','cancelled'].includes(r.status));
    if(!incomplete.length&&!data.notes.length) html+=empty('아직 저장된 이어하기가 없습니다','앱 제작을 시작하거나 아래에서 현재 프로젝트의 인계 메모를 남겨 주세요.',button('첫 앱 흐름 만들기','new-run','','primary'));
    for (const item of incomplete.slice(0,6)) {
      const node=item.nodes?.find(n=>['running','review','blocked','failed','awaiting-approval'].includes(n.status))??item.nodes?.find(n=>n.status!=='passed');
      const done=item.nodes?.filter(n=>n.status==='passed').length??0,total=item.nodes?.length??0;
      html+='<article class="card accent"><div class="card-head"><div class="grow"><div class="card-title">'+e(item.goal)+'</div><div class="card-subtitle">'+e(node?'다음 지점 · '+title(node):'전체 흐름을 확인해 주세요')+'</div></div>'+badge(item.status)+'</div><div class="progress"><span style="width:'+(total?done/total*100:0)+'%"></span></div><div class="progress-label"><span>'+done+' / '+total+'단계 검토 완료</span><span>'+e(localDate(item.updatedAt))+'</span></div>'+(node?.failureReason?'<div class="callout warning">'+e(node.failureReason)+'</div>':'')+'<div class="actions">'+button('흐름 열기 →','open-run','data-run="'+e(item.id)+'"','primary')+(item.status==='paused'?button('작업 재개','resume-run','data-run="'+e(item.id)+'"'):'')+'</div></article>';
    }
    for(const note of data.notes.slice(0,8)) html+='<article class="card note-card"><div class="card-head"><div class="grow"><div class="card-title">'+e(note.projectName)+'</div><div class="card-subtitle">'+e(localDate(note.at))+'</div></div>'+badge(note.verificationFreshness)+'</div><div class="note-line"><span class="note-label">진행한 일</span>'+e(note.state)+'</div><div class="note-line"><span class="note-label">다음 행동</span>'+e(note.next)+'</div>'+(note.why?'<div class="note-line"><span class="note-label">멈춘 이유</span>'+e(note.why)+'</div>':'')+(note.hold?'<div class="note-line"><span class="note-label">보류한 결정</span>'+e(note.hold)+'</div>':'')+(note.verified?'<div class="evidence">'+e(note.verified)+'</div>':'')+'<div class="actions"><select class="field" style="width:auto;max-width:130px" aria-label="'+e(note.projectName)+' 이어하기 에이전트" data-note-agent="'+e(note.workspaceId)+'">'+providerOptions('codex')+'</select>'+button('오늘 이어하기 →','resume-note','data-workspace="'+e(note.workspaceId)+'"','primary')+button('작업 공간','open-workspace','data-workspace="'+e(note.workspaceId)+'"')+'</div></article>';
    html+='<div class="two-columns section"><section><div class="section-heading"><h2>어제의 기록</h2><span class="muted mono">'+e(data.yesterdayDate)+'</span></div>'+renderEvents(data.yesterdayEvents,(data.worklogs??[]).some(w=>w.day===data.yesterdayDate)?'아래 작업 일지에서 어제 진행한 내용을 확인하세요.':'어제 기록이 없습니다. 날짜가 다른 마지막 작업을 어제 작업으로 표시하지 않습니다.')+(data.worklogs??[]).filter(w=>w.day===data.yesterdayDate).map(renderWorklog).join('')+'</section><section><div class="section-heading"><h2>오늘의 기록</h2><span class="muted mono">'+e(data.date)+'</span></div>'+renderEvents(data.todayEvents,'오늘 진행한 단계와 인계 메모가 시간순으로 쌓입니다.')+(data.worklogs??[]).filter(w=>w.day===data.date).map(renderWorklog).join('')+'</section></div>';
    if(data.lastActiveDay&&data.lastActiveDay!==data.yesterdayDate) html+='<p class="hint spacer">마지막 기록이 있는 날 · '+e(data.lastActiveDay)+'</p>';
  }
  if(ui.state?.archivedRuns?.length) html+='<section class="section"><details class="card"><summary>보관된 실행 '+ui.state.archivedRuns.length+'개</summary>'+[...ui.state.archivedRuns].reverse().map(r=>'<div class="track"><div class="track-header"><strong>'+e(r.goal)+'</strong>'+badge(r.status)+'</div><p>보관 · '+e(localDate(r.archivedAt))+' · '+r.nodes.filter(n=>n.status==='passed').length+'/'+r.nodes.length+'단계</p><details><summary>실행 기록</summary>'+renderEvents([...(r.events??[])].reverse(),'기록 없음')+'</details></div>').join('')+'</details></section>';
  html+='<section class="section"><details class="card" '+(data&&!data.notes?.length?'open':'')+'><summary>현재 프로젝트의 인계 메모 남기기</summary>'+handoffForm()+'</details></section>';
  if(data?.sessions?.length) html+='<section class="section"><details class="card"><summary>이전 에이전트 세션 '+data.sessions.length+'개</summary><p class="hint">세션 제목과 시각입니다. 작업 완료나 검증 통과를 의미하지 않습니다.</p>'+data.sessions.slice(0,15).map(s=>'<div class="track"><div class="track-header"><strong>'+e(s.title||s.agent)+'</strong><span class="mono">'+e(s.agent)+'</span></div><p>'+e(localDate(s.updatedAt))+' · '+s.messageCount+'개 메시지</p>'+(s.workspaceId?'<div class="actions">'+button('세션 이어하기','resume-session','data-workspace="'+e(s.workspaceId)+'" data-agent="'+e(s.agent)+'" data-session="'+e(s.sessionId)+'"','small')+'</div>':'')+'</div>').join('')+'</details></section>';
  return html;
}
function renderEvents(events,placeholder) {
  if(!events?.length) return '<div class="empty small"><p>'+e(placeholder)+'</p></div>';
  return '<div class="timeline">'+events.slice(0,30).map(ev=>'<div class="event"><div class="event-title">'+e(ev.summary??ev.type)+'</div><div class="event-meta">'+e(localDate(ev.at??ev.timestamp,true))+' · '+e(ev.projectName??ev.goal??ev.nodeId??'앱 작업')+'</div>'+(ev.next?'<p class="hint">다음 · '+e(ev.next)+'</p>':'')+'</div>').join('')+'</div>';
}
function renderWorklog(log) {
  return '<details class="card spacer"><summary>'+e(log.project)+' · 기존 작업 일지</summary><p class="hint">기존 기록을 읽어 표시합니다. 새로 검증한 결과는 아닙니다.</p><pre class="worklog">'+e(log.text)+'</pre></details>';
}
function handoffForm() {
  const workspaces=(ui.state?.workspaces??[]).map(w=>({value:w.id,label:(w.project?w.project+' / ':'')+w.name}));
  return '<form id="handoff"><label class="label" for="handoff-workspace">작업 공간</label><select class="field" id="handoff-workspace" name="workspaceId" required><option value="">프로젝트를 선택하세요</option>'+options(workspaces,draft('handoff','workspaceId',ui.state?.context?.workspaceId))+'</select><label class="label" for="handoff-state">진행한 내용</label><textarea class="field" id="handoff-state" name="state" maxlength="4000" required placeholder="무엇을 만들었고 어디까지 확인했나요?">'+e(draft('handoff','state'))+'</textarea><label class="label" for="handoff-next">다음에 할 한 가지</label><textarea class="field" id="handoff-next" name="next" maxlength="4000" required placeholder="내일의 내가 바로 실행할 수 있게 적어 주세요.">'+e(draft('handoff','next'))+'</textarea><div class="field-grid"><div><label class="label" for="handoff-why">멈춘 이유</label><input class="field" id="handoff-why" name="why" maxlength="4000" value="'+e(draft('handoff','why'))+'" placeholder="예: 실기기 테스트 대기"></div><div><label class="label" for="handoff-hold">보류한 결정</label><input class="field" id="handoff-hold" name="hold" maxlength="4000" value="'+e(draft('handoff','hold'))+'" placeholder="예: 구독 상품 가격"></div></div><label class="label" for="handoff-verified">실제로 실행한 검증</label><input class="field mono" id="handoff-verified" name="verified" maxlength="4000" value="'+e(draft('handoff','verified'))+'" placeholder="예: flutter test — 24 passed"><p class="hint">검증 메모를 저장할 때 코드 지문을 기록합니다. 이후 코드가 바뀌면 재확인 필요로 표시합니다.</p><div class="actions"><button class="button primary" type="submit">인계 메모 저장</button></div></form>';
}
function renderStudio() {
  let html='<section class="hero"><p class="eyebrow">IDEA → GRAPH → WORKING APP</p><div class="hero-row"><h1>생각을 앱으로.</h1>'+button('+ 새 흐름','new-run','','small')+'</div><p>담당 에이전트와 검토자를 연결하고, 근거가 남는 수정 루프로 완성합니다.</p></section>';
  if(ui.newRun) return html+newRunForm();
  const item=run();
  if(!item) return html+empty('첫 앱의 흐름을 만들어 보세요','목표와 프로젝트를 선택하면 11개 단계의 의존성 그래프가 준비됩니다. 실행은 시작 버튼을 누를 때 진행됩니다.',button('앱 제작 흐름 만들기','new-run','','primary'))+'<div class="callout spacer"><strong>기본 동시 실행 2개</strong><br>독립적인 설계를 병렬로 진행하고, 같은 작업 공간을 수정하는 단계는 한 번에 하나씩 실행합니다.</div>';
  const nodes=item.nodes??[],done=nodes.filter(n=>n.status==='passed').length;
  const selected=nodes.find(n=>n.id===ui.nodeId)??nodes.find(n=>n.active)??nodes.find(n=>n.status!=='passed')??nodes[0];
  ui.nodeId=selected?.id;
  const levels=new Map();
  const depth=(node,seen=new Set())=>{
    if(levels.has(node.id)) return levels.get(node.id);
    if(seen.has(node.id)) return 0;
    const next=new Set(seen).add(node.id);
    const result=node.deps?.length?Math.max(...node.deps.map(id=>{const n=nodes.find(n=>n.id===id);return n?depth(n,next)+1:0;})):0;
    levels.set(node.id,result);return result;
  };
  nodes.forEach(n=>depth(n));
  const layerMap=new Map();
  nodes.forEach(n=>{const level=levels.get(n.id);if(!layerMap.has(level))layerMap.set(level,[]);layerMap.get(level).push(n.id);});
  html+='<select class="field run-select" aria-label="앱 제작 흐름 선택" id="run-select">'+options((ui.state.runs??[]).map(r=>({value:r.id,label:r.goal.slice(0,90)})),item.id)+'</select><div class="card"><div class="card-head"><div class="grow"><div class="card-title">'+e(item.goal)+'</div><div class="card-subtitle">'+e(item.workspacePath??'시작하면 별도 작업 브랜치를 준비합니다.')+'</div></div>'+badge(item.status)+'</div><div class="progress"><span style="width:'+(done/Math.max(nodes.length,1)*100)+'%"></span></div><div class="progress-label"><span>'+done+' / '+nodes.length+' 단계 통과</span><span>수정 루프 '+(item.repairLoops??0)+' / '+item.maxRepairLoops+' · 동시 '+item.maxConcurrency+'</span></div><div class="actions">'+(['ready'].includes(item.status)?button(item.workspaceId?'계속 실행':'앱 제작 시작','start-run','data-run="'+e(item.id)+'"','primary'):'')+(['paused','blocked'].includes(item.status)?button(item.status==='blocked'?'상태 확인 후 재개':'재개','resume-run','data-run="'+e(item.id)+'"','primary'):'')+(['running','ready','blocked'].includes(item.status)?button('일시 정지','pause-run','data-run="'+e(item.id)+'"'):'')+button('상태 동기화','refresh-run','data-run="'+e(item.id)+'"')+(item.workspaceId?button('작업 공간 열기','open-workspace','data-workspace="'+e(item.workspaceId)+'"'):'')+(!['cancelled','completed'].includes(item.status)?button('실행 취소','cancel-run','data-run="'+e(item.id)+'"','danger'):'')+'</div>'+(item.status==='paused'?'<p class="hint spacer">새 단계 배정을 멈췄습니다. 이미 실행 중인 에이전트는 완료 보고서를 남길 수 있습니다.</p>':'')+(item.runtimeMessage?'<div class="callout error">'+e(item.runtimeMessage)+'</div>':'')+(item.stopFailures?.length?'<div class="callout error"><strong>일부 에이전트의 종료를 확인하지 못했습니다.</strong>'+item.stopFailures.map(f=>'<p>'+e(f.message)+'</p>'+(f.terminalId?button('해당 에이전트 확인','focus-terminal','data-terminal="'+e(f.terminalId)+'"','small'):button('Orca 작업 공간 확인','open-workspace','data-workspace="'+e(item.workspaceId)+'"','small'))).join('')+'</div>':'')+'</div>';
  if(['completed','cancelled'].includes(item.status)&&!item.stopFailures?.length) html+='<div class="actions">'+button('완료된 실행 보관','archive-run','data-run="'+e(item.id)+'"','small')+'</div>';
  if(item.workspaceCreation?.state==='uncertain'&&!item.workspaceId) {
    const candidates=(ui.state.workspaces??[]).filter(w=>w.projectId===item.projectId&&(!w.hostId||w.hostId==='local')).map(w=>({value:w.id,label:w.name+' · '+(w.branch??w.path)}));
    html+='<section class="card"><h3>생성된 작업 공간 연결</h3><p class="hint">응답이 없었어도 작업 공간이 이미 만들어졌을 수 있습니다. Orca에서 확인한 뒤 해당 공간을 선택하세요. 연결 후에는 일시 정지 상태로 유지됩니다.</p><form id="attach-workspace" data-run="'+e(item.id)+'"><label class="label" for="attach-workspace-id">같은 프로젝트의 작업 공간</label><select class="field" id="attach-workspace-id" name="workspaceId" required><option value="">확인한 작업 공간 선택</option>'+options(candidates,'')+'</select><div class="actions"><button class="button primary" type="submit">확인한 공간 연결</button></div></form></section>';
  }
  html+='<div class="graph-legend"><span><i class="legend-swatch purple"></i>작업·독립 검토</span><span><i class="legend-swatch green"></i>근거 확인 완료</span><span><i class="legend-swatch orange"></i>승인·입력 대기</span></div><div class="studio-columns"><div class="graph-wrap"><svg class="graph-lines" aria-hidden="true"></svg><div class="graph">'+nodes.map((n,index)=>{
    const peers=layerMap.get(levels.get(n.id))??[n.id],position=peers.indexOf(n.id),column=peers.length===1?2:peers.length===2?(position?3:1):position%3+1;
    return '<button class="node '+e(n.status)+(n.id===selected?.id?' selected':'')+'" style="--row:'+(levels.get(n.id)+1)+';--col:'+column+'" data-action="select-node" data-node="'+e(n.id)+'" data-id="'+e(n.id)+'" aria-pressed="'+(n.id===selected?.id)+'"><div class="node-head"><span class="node-index">'+String(index+1).padStart(2,'0')+'</span><span class="node-title">'+e(title(n))+'</span></div><div class="node-footer"><span>'+e(n.active?.phase==='review'?'검토 · '+n.reviewer:n.agent)+'</span>'+badge(n.status)+'</div><div class="node-deps">'+(n.deps.length?'선행 · '+n.deps.map(id=>e(nodeNames[id]??id)).join(', '):'시작 단계')+' · 시도 '+n.attempts+'/'+item.maxAttempts+'</div></button>';
  }).join('')+'</div></div>'+renderNode(item,selected)+'</div>';
  html+='<section class="section"><details class="card"><summary>전체 팀 배정 · '+nodes.length+'개 역할</summary><p class="hint">모델과 추론 설정은 각 에이전트의 Orca 설정을 따릅니다. 검토자는 매번 별도 세션으로 시작합니다.</p><form id="assignments" data-run="'+e(item.id)+'"><div class="table-wrap"><table class="team-table"><thead><tr><th>역할</th><th>작업</th><th>독립 검토</th></tr></thead><tbody>'+nodes.map(n=>'<tr><td>'+e(title(n))+'</td><td><select class="field" name="'+e(n.id)+'.agent" '+(!assignmentMutable(n)?'disabled':'')+' aria-label="'+e(title(n))+' 작업 에이전트">'+providerOptions(draft('assignments',n.id+'.agent',n.agent))+'</select></td><td><select class="field" name="'+e(n.id)+'.reviewer" '+(!assignmentMutable(n)?'disabled':'')+' aria-label="'+e(title(n))+' 검토 에이전트">'+providerOptions(draft('assignments',n.id+'.reviewer',n.reviewer))+'</select></td></tr>').join('')+'</tbody></table></div><div class="actions"><button class="button primary" type="submit">팀 배정 저장</button></div></form></details></section>';
  html+='<section class="section"><div class="section-heading"><h2>실행 기록</h2><span class="hint">최근 30개</span></div>'+renderEvents([...(item.events??[])].reverse(),'아직 실행 기록이 없습니다.')+'</section>';
  return html;
}
function renderNode(item,node) {
  if(!node) return '';
  let html='<aside class="details"><div class="card-head"><div><p class="eyebrow">STAGE DETAIL</p><h3>'+e(title(node))+'</h3></div>'+badge(node.status)+'</div><p class="muted" style="font-size:12px">'+e(descriptions[node.id]??node.title)+'</p><div class="meta">작업 '+e(node.agent)+' · 독립 검토 '+e(node.reviewer)+'</div><div class="meta">작업 시도 '+node.attempts+' / '+item.maxAttempts+' · 검토 시도 '+node.reviewAttempts+'</div>';
  if(node.failureReason||node.runtimeMessage) html+='<div class="callout warning">'+e(node.runtimeMessage||node.failureReason)+'</div>';
  if(node.active) html+='<div class="callout"><strong>'+e(node.active.phase==='review'?'독립 검토 중':'에이전트 작업 중')+'</strong><br>'+e(node.active.startedAt?localDate(node.active.startedAt):'진행 상황을 확인합니다.')+'</div>'+(node.active.terminalId?button('에이전트 열기 →','focus-terminal','data-terminal="'+e(node.active.terminalId)+'"','full'):'');
  for(const [label,report] of [['작업 보고서',node.report],['독립 검토 결과',node.review]]) {
    if(!report) continue;
    html+='<div class="divider"></div><h4>'+label+'</h4><p class="note-line">'+e(report.summary)+'</p>';
    for(const evidence of report.evidence??[]) html+='<div class="evidence">'+e(evidence.kind==='command'?evidence.command+'\nexit '+evidence.exitCode:evidence.kind==='artifact'?evidence.path:evidence.text??JSON.stringify(evidence))+'</div>';
  }
  if(node.status==='awaiting-approval') html+='<div class="divider"></div><form id="approval" data-run="'+e(item.id)+'" data-node="'+e(node.id)+'"><label class="label" for="approval-note">이번 단계에서 허용할 작업</label><textarea class="field" id="approval-note" name="note" required maxlength="2000" placeholder="예: 내부 테스트 빌드와 업로드 전 자료를 준비해 주세요.">'+e(draft('approval','note'))+'</textarea><label class="checkbox"><input type="checkbox" name="actualSubmission" id="actual-submission" '+(draft('approval','actualSubmission',false)?'checked':'')+'>실제 Play 제출까지 명시적으로 승인</label><div id="submission-fields" '+(!draft('approval','actualSubmission',false)?'hidden':'')+'><p class="hint spacer">선택한 대상에 한해 기존 프로젝트 배포 도구를 에이전트가 사용합니다. 연결이나 권한이 없으면 중단합니다.</p><label class="label" for="submission-package">패키지 이름</label><input class="field mono" id="submission-package" name="packageName" value="'+e(draft('approval','packageName'))+'" placeholder="com.example.app"><div class="field-grid"><div><label class="label" for="submission-track">트랙</label><input class="field" id="submission-track" name="track" value="'+e(draft('approval','track',node.id==='internal'?'internal':'production'))+'"></div><div><label class="label" for="submission-version">버전 코드</label><input class="field" id="submission-version" type="number" min="1" name="versionCode" value="'+e(draft('approval','versionCode'))+'"></div></div></div><div class="actions"><button class="button primary" type="submit">범위 승인 후 계속</button></div><p class="hint">실제 제출을 선택하지 않으면 준비·검토만 수행합니다.</p></form>';
  if(node.launchUncertain) html+='<label class="checkbox"><input type="checkbox" id="retry-ack">Orca에서 이전 실행 상태를 확인했습니다.</label><p class="hint">응답을 못 받았더라도 에이전트는 시작됐을 수 있습니다. 중복 실행 여부를 먼저 확인하세요.</p>';
  if(node.pendingReceipt?.terminalId) html+='<div class="actions">'+button('이전 에이전트 확인','focus-terminal','data-terminal="'+e(node.pendingReceipt.terminalId)+'"','small')+'</div><label class="checkbox"><input type="checkbox" id="retry-stop">이전 에이전트가 실행 중이면 종료하고 다시 배정</label>';
  if(['failed','blocked'].includes(node.status)&&!node.active&&!['cancelled','completed'].includes(item.status)) html+='<div class="actions">'+button('이 단계 다시 시도','retry-node','data-run="'+e(item.id)+'" data-node="'+e(node.id)+'"','primary')+'</div><p class="hint">정해진 시도 횟수 안에서만 다시 실행합니다. 한도를 넘으면 새 흐름을 만들어 범위를 조정해 주세요.</p>';
  return html+'</aside>';
}
function newRunForm() {
  const projects=(ui.state?.projects??[]).filter(p=>p.kind==='git'&&(!p.hostId||p.hostId==='local')).map(p=>({value:p.id,label:p.name}));
  return '<section class="card accent"><div class="section-heading"><div><p class="eyebrow">NEW APP FLOW</p><h2>어떤 앱을 만들까요?</h2></div>'+button('닫기','close-new','','small')+'</div><form id="new-run"><label class="label" for="app-goal">앱 목표와 완료 기준</label><textarea class="field" style="min-height:125px" id="app-goal" name="goal" required maxlength="6000" placeholder="예: Flutter로 캐릭터와 대화하는 사주 앱을 만들고 싶어요. 첫 버전은 생년월일 입력, 채팅, 결과 저장까지. Android 실기기에서 확인해 주세요.">'+e(draft('new-run','goal'))+'</textarea><label class="label" for="app-project">Orca에 등록된 Git 프로젝트</label><select class="field" id="app-project" name="projectId" required><option value="">프로젝트 선택</option>'+options(projects,draft('new-run','projectId'))+'</select><p class="hint">프로젝트에 첫 커밋이 있어야 합니다. 시작 시 별도 브랜치와 작업 공간을 만듭니다.</p><div class="field-grid"><div><label class="label" for="app-agent">기본 작업 에이전트</label><select class="field" id="app-agent" name="agent">'+providerOptions(draft('new-run','agent','codex'))+'</select></div><div><label class="label" for="app-reviewer">독립 검토 에이전트</label><select class="field" id="app-reviewer" name="reviewer">'+providerOptions(draft('new-run','reviewer','codex'))+'</select></div></div><details class="spacer"><summary>동시 실행과 반복 한도</summary><div class="field-grid"><div><label class="label" for="app-concurrency">동시 실행 수</label><select class="field" id="app-concurrency" name="maxConcurrency">'+options([1,2,3,4,5,6],draft('new-run','maxConcurrency',2))+'</select></div><div><label class="label" for="app-attempts">단계별 최대 시도</label><select class="field" id="app-attempts" name="maxAttempts">'+options([1,2,3,4,5],draft('new-run','maxAttempts',3))+'</select></div><div><label class="label" for="app-loops">테스트 → 구현 수정 한도</label><select class="field" id="app-loops" name="maxRepairLoops">'+options([0,1,2,3,4,5],draft('new-run','maxRepairLoops',3))+'</select></div><div><label class="label" for="app-base">기준 브랜치 (선택)</label><input class="field" id="app-base" name="baseBranch" value="'+e(draft('new-run','baseBranch'))+'" placeholder="프로젝트 기본값"></div></div></details><div class="callout"><strong>담당자와 검토자를 분리합니다.</strong><br>작업 종료만으로 통과 처리하지 않습니다. 산출물과 검증 근거를 확인하고, 독립 검토를 거친 다음 후속 단계를 엽니다.</div><div class="actions"><button type="submit" class="button primary">그래프 만들기 →</button></div><p class="hint">그래프를 만든 뒤 역할별 배정을 바꾸고 직접 실행을 시작할 수 있습니다.</p></form></section>';
}
function renderPlay() {
  const data=ui.play,accounts=data?.accounts??[],account=accounts.find(a=>a.id===ui.accountId)??accounts[0];
  let html='<section class="hero"><p class="eyebrow">STORE HEALTH, CLEARLY</p><div class="hero-row"><h1>앱의 현재 위치.</h1>'+button('+ 계정 연결','new-account','','small')+'</div><p>계정별 앱과 트랙을 한곳에서 확인합니다. 점검은 읽기 전용입니다.</p></section>';
  if(ui.newAccount) return html+accountForm();
  if(!accounts.length) return html+empty('Play 개발자 계정을 연결하세요','Toris와 다른 개발자 계정을 각각 등록할 수 있습니다. 서비스 계정 JSON은 운영체제 키 저장소에 보호해 보관합니다.',button('첫 계정 연결','new-account','','primary'))+'<div class="callout">Google Play API와 권한을 갖춘 서비스 계정이 필요합니다. 연결 전에는 실제 앱 상태를 추정해 표시하지 않습니다.</div>';
  html+='<div class="account-switcher">'+accounts.map(a=>button(e(a.name),'select-account','data-account="'+e(a.id)+'"',a.id===account?.id?'active':'')).join('')+'</div>';
  if(!account) return html;
  const apps=account.apps??[];
  html+='<div class="stats"><div class="stat"><div class="stat-label">확인한 앱</div><div class="stat-value">'+apps.length+'<span>개</span></div></div><div class="stat"><div class="stat-label">게시 상태</div><div class="stat-value">'+apps.filter(a=>a.published).length+'<span>개</span></div></div><div class="stat"><div class="stat-label">주의가 필요해요</div><div class="stat-value">'+apps.filter(a=>a.needsAttention||a.tracks?.some(t=>t.stale)).length+'<span>개</span></div></div></div><div class="card"><div class="card-head"><div><h3>'+e(account.name)+'</h3><p class="card-subtitle">마지막 점검 · '+e(localDate(account.checkedAt))+'</p></div>'+button('지금 점검','check-play','data-account="'+e(account.id)+'"','primary')+'</div><p class="hint">'+e(account.tracks.join(' · '))+'</p>'+(account.error?'<div class="callout error">'+e(account.error.message??account.error)+'</div>':'')+(account.discovery?.error?'<div class="callout warning">앱 자동 조회 · '+e(account.discovery.error.message??account.discovery.error)+'</div>':'')+'<div class="actions">'+button('계정 설정','edit-account','data-account="'+e(account.id)+'"','small')+button('연결 해제','remove-account','data-account="'+e(account.id)+'"','small danger')+'</div></div>';
  if(!apps.length) html+=empty('아직 점검 결과가 없습니다','지금 점검을 눌러 앱 목록과 트랙별 릴리스 상태를 읽어오세요.');
  for(const a of apps) html+='<article class="card"><div class="card-head"><div class="grow"><div class="card-title">'+e(a.name||a.packageName)+'</div><div class="card-subtitle mono">'+e(a.packageName)+'</div></div>'+badge(a.status)+'</div>'+(a.tracks??[]).map(t=>'<div class="track"><div class="track-header"><strong>'+e(t.track)+'</strong>'+(t.stale?badge('stale'):'<span class="hint">'+e(localDate(t.observedAt))+'</span>')+'</div>'+(t.releases?.length?t.releases.map(r=>'<div class="release-row"><span>'+e(r.name||'이름 없는 릴리스')+'</span><span class="mono">v'+e(r.versionCodes.join(', '))+'</span><span class="badge">'+e(releaseState(r.state))+'</span></div>').join(''):'<p>'+(t.error?'조회 결과 없음':'활성 릴리스 없음')+'</p>')+(t.stale?'<p>마지막 성공한 관측 · '+e(localDate(t.observedAt))+'</p>':'')+(t.error?'<p style="color:var(--amber)">'+e(t.error.message??t.error)+'</p>':'')+'</div>').join('')+'<div class="actions">'+button('스토어 페이지 ↗','external','data-url="'+e(a.storeUrl)+'"','small')+'</div></article>';
  html+='<p class="hint spacer">게시됨은 Google API에서 확인한 공개 상태입니다. 100% 단계적 출시 완료를 뜻하지는 않습니다. 오류 시 이전 결과와 원래 확인 시각을 유지합니다.</p>';
  return html;
}
function releaseState(value) {
  const names={RELEASE_LIFECYCLE_STATE_DRAFT:'초안',RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW:'심사 제출 전',RELEASE_LIFECYCLE_STATE_IN_REVIEW:'심사 중',RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED:'승인 · 게시 전',RELEASE_LIFECYCLE_STATE_NOT_APPROVED:'승인되지 않음',RELEASE_LIFECYCLE_STATE_PUBLISHED:'게시됨'};
  return names[value]??({not_sent_for_review:'심사 제출 전',not_approved:'승인되지 않음'})[value]??statusNames[value]??value;
}
function accountForm() {
  const id=typeof ui.newAccount==='string'?ui.newAccount:null;
  const account=ui.play?.accounts?.find(a=>a.id===id);
  const def=(name,value='')=>draft('account',name,value);
  return '<section class="card"><div class="section-heading"><h2>'+(account?'계정 설정':'개발자 계정 연결')+'</h2>'+button('닫기','close-account','','small')+'</div><form id="account" '+(id?'data-account="'+e(id)+'"':'')+'><label class="label" for="account-name">계정 이름</label><input class="field" id="account-name" name="name" value="'+e(def('name',account?.name??''))+'" required placeholder="예: Toris"><label class="label" for="credential-path">이 컴퓨터의 서비스 계정 JSON 경로</label><input class="field mono" id="credential-path" name="credentialPath" value="" autocomplete="off" placeholder="~/.config/google/play-service-account.json"><p class="hint">'+(account?'비워두면 현재 키를 유지합니다.':'Orca가 실행되는 컴퓨터의 절대 경로 또는 ~/ 경로를 입력하세요.')+' 가져온 원문은 화면에 다시 표시하지 않습니다.</p><details class="spacer"><summary>JSON 직접 붙여넣기</summary><textarea class="field mono" name="serviceAccountJson" aria-label="서비스 계정 JSON" autocomplete="off" spellcheck="false" placeholder="서비스 계정 JSON 원문 · 로컬 경로와 둘 중 하나만 입력"></textarea></details><label class="label" for="account-packages">특정 패키지만 조회 (비워두면 전체 자동 조회)</label><textarea class="field mono" id="account-packages" name="packages" placeholder="com.example.app&#10;com.example.other">'+e(def('packages',account?.packages?.join('\n')??''))+'</textarea><label class="label" for="account-tracks">조회할 트랙 · 줄바꿈 또는 쉼표로 구분</label><input class="field" id="account-tracks" name="tracks" value="'+e(def('tracks',account?.tracks?.join(', ')??'production, beta, alpha, internal'))+'" required><p class="hint">이름을 지정한 비공개 테스트나 기기별 트랙도 추가할 수 있습니다.</p><div class="callout">Google Play Console에서 해당 서비스 계정에 필요한 조회 권한을 부여해 주세요. 앱 자동 조회에는 Play Developer Reporting API를 사용합니다.</div><div class="actions"><button class="button primary" type="submit">'+(account?'설정 저장':'계정 연결')+'</button></div></form></section>';
}
function renderAgents() {
  const agents=ui.state?.agents??[],runs=ui.state?.runs??[];
  const owned=runs.flatMap(r=>r.nodes.filter(n=>n.active).map(n=>({run:r,node:n,active:n.active})));
  let html='<section class="hero"><p class="eyebrow">ONE GOAL, MANY MINDS</p><h1>각자의 역할, 하나의 앱.</h1><p>역할마다 적합한 에이전트를 배정하세요. 작업과 독립 검토는 별도 세션으로 진행합니다.</p></section><div class="callout">현재 작업 공간의 에이전트와 Toris Neon이 시작한 작업을 표시합니다. 모델·계정·추론 설정은 Orca의 에이전트 설정을 따릅니다.</div><section class="section"><div class="section-heading"><h2>진행 중인 앱 작업</h2><span class="badge">'+owned.length+'개</span></div>';
  if(!owned.length) html+=empty('현재 배정된 작업이 없습니다','Auto App에서 그래프를 만들고 시작하면 담당자와 검토자의 진행 상황이 나타납니다.');
  else html+='<div class="agent-grid">'+owned.map(({run:r,node:n,active:a})=>'<div class="card agent-card"><div class="agent-line"><div class="agent-avatar">'+e((a.phase==='review'?n.reviewer:n.agent).slice(0,2).toUpperCase())+'</div><div class="grow"><h3>'+e(a.phase==='review'?n.reviewer:n.agent)+'</h3><span class="hint">'+e(title(n))+' · '+(a.phase==='review'?'독립 검토':'작업')+'</span></div>'+badge(n.status)+'</div><p>'+e(r.goal)+'</p><div class="actions">'+(a.terminalId?button('에이전트 열기','focus-terminal','data-terminal="'+e(a.terminalId)+'"','small'):'')+button('그래프','open-run','data-run="'+e(r.id)+'"','small')+'</div></div>').join('')+'</div>';
  html+='</section><section class="section"><div class="section-heading"><h2>현재 작업 공간</h2><span class="hint">'+e(ui.state?.context?.displayName??'선택된 공간 없음')+'</span></div>';
  if(!agents.length)html+='<div class="empty small"><p>현재 공간에서 확인되는 에이전트가 없습니다.</p></div>';
  else html+='<div class="agent-grid">'+agents.map(a=>'<div class="card agent-card"><div class="card-head"><h3>'+e(a.title??a.agent??'Agent')+'</h3>'+badge(a.state)+'</div><p>'+e(a.agent??'')+' · '+e(localDate(a.stateStartedAt))+'</p>'+(a.terminalId&&ownedTerminal(a.terminalId)?'<div class="actions">'+button('열기','focus-terminal','data-terminal="'+e(a.terminalId)+'"','small')+'</div>':'')+'</div>').join('')+'</div>';
  html+='</section><section class="section"><div class="section-heading"><h2>배정 가능한 에이전트 종류</h2></div><div class="actions">'+providers().map(p=>'<span class="badge">'+e(p)+'</span>').join('')+'</div><p class="hint spacer">목록은 지원 종류입니다. 해당 CLI의 설치·로그인은 Orca에서 먼저 완료해 주세요.</p></section>';
  return html;
}
function drawGraph() {
  const svg=app.querySelector('.graph-lines'),container=app.querySelector('.graph-wrap'),item=run();
  if(!svg||!container||!item) return;
  const root=container.getBoundingClientRect();
  svg.setAttribute('viewBox','0 0 '+root.width+' '+root.height);
  const byId=new Map([...container.querySelectorAll('.node')].map(n=>[n.dataset.id,n]));
  let lines='<defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="currentColor" stroke="none"/></marker></defs>';
  for(const node of item.nodes)for(const dep of node.deps) {
    const start=byId.get(dep)?.getBoundingClientRect(),end=byId.get(node.id)?.getBoundingClientRect();
    if(!start||!end)continue;
    const x1=start.x-root.x+start.width/2,y1=start.bottom-root.y,x2=end.x-root.x+end.width/2,y2=end.top-root.y;
    const offset=Math.max(7,(y2-y1)/2);
    lines+='<path class="'+(item.nodes.find(n=>n.id===dep)?.status==='passed'?'complete':'')+'" d="M '+x1+' '+y1+' C '+x1+' '+(y1+offset)+', '+x2+' '+(y2-offset)+', '+x2+' '+y2+'" />';
  }
  svg.innerHTML=lines;
}
function clearDraft(form) {for(const key of Object.keys(ui.drafts))if(key.startsWith(form+'.'))delete ui.drafts[key];}
app.addEventListener('input',event=>{
  const target=event.target,form=target.closest('form');
  if(form&&target.name&&!['serviceAccountJson','credentialPath'].includes(target.name))ui.drafts[form.id+'.'+target.name]=target.type==='checkbox'?target.checked:target.value;
});
app.addEventListener('change',event=>{
  const target=event.target;
  if(target.id==='run-select'){ui.runId=target.value;ui.nodeId=null;clearDraft('assignments');clearDraft('approval');render();}
  if(target.id==='actual-submission') {
    const fields=app.querySelector('#submission-fields');if(fields) fields.hidden=!target.checked;
    for(const field of app.querySelectorAll('#submission-fields input'))field.required=target.checked;
  }
});
app.addEventListener('click',async event=>{
  const target=event.target.closest('[data-action]');
  if(!target||target.disabled)return;
  const action=target.dataset.action;
  if(action==='tab'){ui.tab=target.dataset.tab;ui.error=null;render();try{await hydrateTab();render();}catch(err){ui.error=err.message;render();}return;}
  if(action==='select-node'){ui.nodeId=target.dataset.node;clearDraft('approval');render();return;}
  if(action==='open-run'){ui.runId=target.dataset.run;ui.tab='studio';ui.newRun=false;ui.nodeId=null;clearDraft('assignments');clearDraft('approval');render();return;}
  if(action==='new-run'){ui.newRun=true;ui.tab='studio';render();return;}
  if(action==='close-new'){ui.newRun=false;render();return;}
  if(action==='new-account'){clearDraft('account');ui.newAccount=true;ui.tab='play';render();return;}
  if(action==='close-account'){ui.newAccount=false;clearDraft('account');render();return;}
  if(action==='edit-account'){clearDraft('account');ui.newAccount=target.dataset.account;render();return;}
  if(action==='select-account'){ui.accountId=target.dataset.account;render();return;}
  if(action==='refresh'){await refresh();return;}
  target.disabled=true;
  try {
    const methods={'start-run':'runs.start','pause-run':'runs.pause','resume-run':'runs.resume','cancel-run':'runs.cancel','refresh-run':'runs.refresh'};
    if(methods[action]) {
      await request(methods[action],{runId:target.dataset.run});
      toast(action==='pause-run'?'새 단계 배정을 멈췄습니다.':action==='cancel-run'?'실행 취소 요청을 처리했습니다.':'작업 상태를 갱신했습니다.');
    } else if(action==='retry-node') {
      const selected=run()?.nodes?.find(n=>n.id===target.dataset.node);
      const acknowledgeUncertain=app.querySelector('#retry-ack')?.checked===true;
      if(selected?.launchUncertain&&!acknowledgeUncertain)throw new Error('Orca에서 이전 실행 상태를 확인한 후 체크해 주세요.');
      await request('nodes.retry',{runId:target.dataset.run,nodeId:target.dataset.node,acknowledgeUncertain,stopPrevious:app.querySelector('#retry-stop')?.checked===true});
    }
    else if(action==='archive-run'){await request('runs.archive',{runId:target.dataset.run});ui.runId=null;toast('기록을 보존하고 실행을 보관했습니다.');}
    else if(action==='open-workspace')await request('workspace.open',{workspaceId:target.dataset.workspace});
    else if(action==='focus-terminal')await request('terminals.focus',{terminalId:target.dataset.terminal});
    else if(action==='resume-note') {
      const picker=[...app.querySelectorAll('[data-note-agent]')].find(p=>p.dataset.noteAgent===target.dataset.workspace);
      const result=await request('today.resume',{workspaceId:target.dataset.workspace,agent:picker?.value??'codex'});
      toast(result.reused?(result.agentState==='done'?'이 인계의 작업은 이미 종료됐습니다. 새 인계 메모를 저장하면 새 작업을 시작할 수 있습니다.':'기존 이어하기 에이전트를 사용합니다.'):'저장한 맥락으로 이어하기를 시작했습니다.');
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
      const assignments=Object.fromEntries(Object.keys(nodeNames).map(id=>[id,{agent:values.agent,reviewer:values.reviewer}]));
      const data={goal:values.goal,projectId:values.projectId,assignments,maxConcurrency:Number(values.maxConcurrency),maxAttempts:Number(values.maxAttempts),maxRepairLoops:Number(values.maxRepairLoops)};
      if(values.baseBranch?.trim())data.baseBranch=values.baseBranch.trim();
      const created=await request('runs.create',data);
      ui.runId=created.id;ui.newRun=false;ui.nodeId=null;clearDraft('new-run');toast('앱 제작 그래프를 만들었습니다. 배정을 확인하고 시작하세요.');
    } else if(form.id==='assignments') {
      const item=run(),assignments=Object.fromEntries(item.nodes.filter(assignmentMutable).filter(n=>(values[n.id+'.agent']??n.agent)!==n.agent||(values[n.id+'.reviewer']??n.reviewer)!==n.reviewer).map(n=>[n.id,{agent:values[n.id+'.agent']??n.agent,reviewer:values[n.id+'.reviewer']??n.reviewer}]));
      if(!Object.keys(assignments).length){toast('변경된 팀 배정이 없습니다.');return;}
      await request('runs.updateAssignments',{runId:form.dataset.run,assignments});clearDraft('assignments');toast('팀 배정을 저장했습니다.');
    } else if(form.id==='approval') {
      const input={runId:form.dataset.run,nodeId:form.dataset.node,note:values.note};
      if(values.actualSubmission) {
        if(!values.packageName||!values.track||!Number.isInteger(Number(values.versionCode))||Number(values.versionCode)<1)throw new Error('제출할 패키지·트랙·버전 코드를 모두 입력해 주세요.');
        input.submission={packageName:values.packageName.trim(),track:values.track.trim(),versionCode:Number(values.versionCode)};
      }
      await request('runs.approve',input);clearDraft('approval');toast(input.submission?'지정한 제출 범위로 승인했습니다.':'준비·검토 단계의 범위를 승인했습니다.');
    } else if(form.id==='attach-workspace') {
      await request('runs.attachWorkspace',{runId:form.dataset.run,workspaceId:values.workspaceId});
      toast('작업 공간을 연결했습니다. 배정을 확인한 뒤 재개해 주세요.');
    } else if(form.id==='handoff') {
      await request('today.save',values);clearDraft('handoff');toast('다음에 이어갈 맥락을 저장했습니다.');
    } else if(form.id==='account') {
      const split=value=>String(value??'').split(/[\n,]/).map(s=>s.trim()).filter(Boolean);
      const input={name:values.name,packages:split(values.packages),tracks:split(values.tracks)};
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
    ui.state={...(ui.state??{}),...state};
    if(!document.activeElement?.matches('input,textarea,select'))render();
  });
  refresh();
} else {
  ui.error='Orca 연결이 없습니다. Orca에서 Toris Neon 패널을 열어 주세요.';
  render();
}
let resizeTimer;
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(drawGraph,80);});
