/** A valid research "findings" object (src/research.mjs): sample names and example.com addresses only. */
export const competitor = (name, checked = true) => ({ name, url: 'https://example.com/' + encodeURIComponent(name), takeaway: name + '는 첫 화면에서 바로 기록한다', checked });
export const sampleFindings = () => ({
  decision: '하루 5분 루틴을 기록하는 오프라인 습관 앱으로 v1을 만든다. 계정과 소셜 기능은 뺀다.',
  targetUser: '아침 루틴을 만들고 싶은 직장인',
  problem: '루틴 앱이 설정이 길어 첫 주에 그만둔다',
  competitors: [competitor('샘플 앱 A'), competitor('샘플 앱 B'), competitor('샘플 앱 C', false)],
  differentiators: ['설정 없이 첫 기록', '오프라인 전용'],
  monetization: { hypothesis: '광고 없는 평생 이용권 일회성 결제(추정)', basis: '비슷한 앱 두 곳이 일회성 결제를 쓴다' },
  openQuestions: ['가격대는 내부 테스트 반응으로 정한다'],
  sources: { opened: 6, searchOnly: 4 },
});

