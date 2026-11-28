/** A valid brief "target" object (src/target.mjs): a sample app, no real names. */
export const sampleTarget = () => ({
  primaryUser: '출근 전 30분 안에 스트레칭과 물 마시기를 지키려는 3년 차 직장인. 지하철역까지 걸으며 한 손으로 체크하고, 지금은 메모 앱 체크리스트를 쓰다 사흘이면 잊는다.',
  notFor: ['습관 통계와 그래프를 분석하고 싶은 자기계발 애호가', '가족·팀과 기록을 공유하려는 사람'],
  job: '아침에 한 루틴을 걸으면서 한 손으로 5초 안에 기록하는 순간',
  promise: '아침 루틴, 걸으면서 한 번 눌러 끝낸다.',
  decisions: [
    '첫 화면이 오늘의 체크리스트다: 목표 설정 마법사와 온보딩을 넣지 않는다',
    '계정·동기화 없이 오프라인 저장만: 지하철에서도 바로 열려야 한다',
    '통계 화면 대신 연속 일수 한 줄: 분석보다 잊지 않는 것이 필요하다',
  ],
  voice: { tone: '짧은 존댓말, 과장된 칭찬 없이 사실만', examples: ['물 한 잔, 했어요.', '오늘 남은 건 스트레칭 하나예요.'] },
  look: { direction: '밝은 미색 바탕, 큰 체크 버튼, 낮은 정보 밀도, 굵은 산세리프 한 종류, 강조색 하나', why: '걸으면서 엄지로 누르므로 큰 터치 영역과 한눈에 읽히는 대비가 필요하다' },
  avoid: ['목표 설정 마법사로 시작하지 않는다', '온보딩 캐러셀을 넣지 않는다', '"생산성을 높여 보세요" 같은 어느 앱에나 맞는 문구를 쓰지 않는다'],
  signals: ['앱을 열고 첫 기록까지 10초 이내', '첫 화면의 버튼은 체크 외에 2개 이하'],
});

/** An existing app's current target as the identity stage infers it: only the required fields. */
export const inferredTarget = () => {
  const { primaryUser, promise, voice, look, avoid } = sampleTarget();
  return { primaryUser: primaryUser + ' (추정)', promise, voice, look, avoid };
};
