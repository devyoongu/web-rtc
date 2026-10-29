// 사용 환경에 맞춰 수정. 비밀번호가 들어 있으므로 커밋 시 주의.
window.APP_CONFIG = {
  asteriskHost: '172.31.79.202',
  asteriskWsPort: 8088,        // pjsip transport-ws bind port
  sipUser: '1003',
  sipPassword: 'secret1003',
  callExtension: '2001',
  // 127.0.0.1 로 고정 — 로컬 서비스가 IPv4(127.0.0.1)에만 바인딩되는데,
  // 브라우저는 'localhost' 를 IPv6(::1)로 먼저 해석한다. ::1 포트를 다른
  // 프로세스(예: Docker 가 [::]:8010 점유)가 받으면 폴백 없이 연결이
  // 엉뚱한 곳으로 가 EventSource/fetch 가 실패하므로 명시적으로 IPv4 사용.
  //
  // 브리지는 문서상 포트 8000 을 쓴다. 8010 은 ../llm-wrapper Docker 백엔드가
  // 점유하므로(callbot 의 LLM_WRAPPER_URL 대상) 브리지와 분리한다.
  ttsBackend: 'http://127.0.0.1:8001/tts',
  eventsBackend: 'http://127.0.0.1:8000/events',
  recvBase: 'http://127.0.0.1:8000',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
