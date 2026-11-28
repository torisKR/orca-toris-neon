/**
 * The approval form for a stage that waits for a person (moved out of panel/studio.mjs unchanged): the scope
 * note, and an actual Play submission only when an account is registered. Catalog stages use their own form.
 */
import { e, options } from './kit.mjs';
import { catalogApprovalForm } from './newflow.mjs';

export function stageApprovalForm(item, node, { accounts: submissionAccounts, draft, accountValue: playAccountValue }) {
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
