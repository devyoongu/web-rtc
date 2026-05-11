// 사용 환경에 맞춰 수정. 비밀번호가 들어 있으므로 커밋 시 주의.
window.APP_CONFIG = {
  asteriskHost: '172.31.79.202',
  asteriskWsPort: 8088,        // pjsip transport-ws bind port
  sipUser: '1003',
  sipPassword: 'secret1003',
  callExtension: '2001',
  ttsBackend: 'http://localhost:8001/tts',
  eventsBackend: 'http://localhost:8000/events',
  recvBase: 'http://localhost:8000',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
