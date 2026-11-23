/** Shared HTML-string primitives for the panel renderers. Every value is escaped with e(). */
export const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const statusNames = {ready:'실행 준비',pending:'대기',running:'진행 중',review:'검토',passed:'통과',failed:'실패',blocked:'확인 필요',paused:'일시 정지',cancelled:'취소',completed:'완료','awaiting-approval':'승인 대기',waiting:'응답 대기',working:'작업 중',done:'에이전트 종료',fresh:'현재 코드와 일치',stale:'재확인 필요',unknown:'미확인',published:'게시됨',testing:'테스트 중',in_review:'심사 중',rejected:'거부됨',draft:'초안',approved_not_published:'승인 · 게시 전',no_release:'릴리스 없음'};
export const nodeNames = {research:'시장·앱 조사',brief:'제품 기획',architecture:'구조 설계',design:'화면·상호작용 설계',assets:'앱 에셋',build:'앱 구현',test:'테스트·수정 루프',policy:'Play 정책·권한 점검',listing:'스토어 자료 준비',internal:'내부 테스트 준비',release:'출시 검토'};
export const descriptions = {research:'사용자 문제, 유사 앱, 차별점과 확인한 근거를 정리합니다.',brief:'첫 버전의 범위와 수락 기준을 고정합니다.',architecture:'앱 구조, 데이터 흐름, 구현 책임을 나눕니다.',design:'실제 화면과 상태, 상호작용을 설계합니다.',assets:'앱에서 사용할 에셋과 출처를 정리합니다.',build:'설계와 에셋을 연결해 앱을 구현합니다.',test:'검증 결과와 결함을 기록합니다. 실패하면 구현 단계로 돌아갑니다.',policy:'구현한 코드의 권한, 개인정보와 스토어 정책 준비 상태를 검토합니다.',listing:'스토어 문구와 스크린샷 등 제출 자료를 준비합니다.',internal:'내부 테스트 자료를 준비합니다. 실제 제출은 계정과 대상을 확인한 명시 승인이 필요합니다.',release:'출시 준비 상태를 검토합니다. 실제 제출을 승인할 때 개발자 계정·패키지·트랙·버전을 지정합니다.'};
export const badge = status => '<span class="badge '+e(status)+'">'+e(statusNames[status]??status??'미확인')+'</span>';
export const timeFormat = new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false});
export const dateTimeFormat = new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
export const dayFormat = new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',weekday:'short'});
export const localDate = (value,short=false) => {
  if (value == null || value === '') return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : (short?timeFormat:dateTimeFormat).format(date);
};
export const todayDate = () => dayFormat.format(new Date());
export const title = node => nodeNames[node.id]??node.title;
export const button = (text,action,extra='',className='') => '<button type="button" class="button '+className+'" data-action="'+action+'" '+extra+'>'+text+'</button>';
export const options = (values,selected) => values.map(item => {
  const value=typeof item==='object'?item.value:item,label=typeof item==='object'?item.label:item;
  return '<option value="'+e(value)+'" '+(String(value)===String(selected)?'selected':'')+'>'+e(label)+'</option>';
}).join('');
const GOAL_TITLE_MAX = 160;
/**
 * A short label for a run: the first meaningful line of its goal without a leading
 * "/goal" command or markdown markers. Display only; the stored goal is unchanged.
 */
export const goalTitle = goal => {
  for (const raw of String(goal ?? '').split(/\r?\n/)) {
    const line = raw.trim()
      .replace(/^\/goal\b[:\s]*/i, '')
      .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s+)+/, '')
      .replace(/(\*\*|__|`+|~~)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim();
    if (!line || /^[-*_=]{3,}$/.test(line)) continue;
    return line.length > GOAL_TITLE_MAX ? line.slice(0, GOAL_TITLE_MAX - 1) + '…' : line;
  }
  return '이름 없는 앱 흐름';
};
