# web-rtc — 브라우저 콜봇 클라이언트

브라우저에서 텍스트를 입력하면 Google TTS 로 합성된 음성이 WebRTC 를 통해 원격 Asterisk 로 전달되고, 콜봇의 음성 응답이 다시 브라우저에서 재생되는 SIP 클라이언트.

```
브라우저 (text input → Google TTS → MediaStream)
   │ SIP/WS  +  DTLS-SRTP
   ▼
Asterisk 172.31.79.202  (1003 → 2001 라우팅)
   │ ulaw, UDP
   ▼
로컬 callbot (pyVoIP, STT/LLM/TTS)
```

## 사전 요구사항

- 원격 Asterisk 서버 (`172.31.79.202`) 에 다음이 적용되어 있어야 함:
  - `pjsip.conf` 의 `[transport-ws]` 와 `1003` 엔드포인트 (이 저장소 `asterisk/conf/pjsip.conf` 참조)
  - `http.conf` 의 `enabled=yes`, `bindaddr=0.0.0.0`, `bindport=8088` (이 저장소 `asterisk/conf/http.conf` 참조)
- 로컬 callbot 이 가동 중 (별도 콘솔). 콜봇 가동 방식은 `../callbot/CLAUDE.md` 참조.
- `../callbot/crendential/` 에 GCP 서비스 계정 JSON 키가 1개 이상 존재.

## Asterisk 변경사항 적용

`asterisk/conf/` 의 두 파일 (`pjsip.conf`, `http.conf`) 을 원격 `/etc/asterisk/` 에 반영한다.
권장: 원격에서 `git pull` 후 `cp` (이미 동일 패턴으로 운영 중).

```bash
# 원격 서버에서
cd ~/asterisk && git pull
sudo cp conf/pjsip.conf /etc/asterisk/pjsip.conf
sudo cp conf/http.conf  /etc/asterisk/http.conf

sudo asterisk -rx "module reload res_http_websocket.so"
sudo asterisk -rx "pjsip reload"

# 검증
sudo asterisk -rx "http show status"          # "Server Enabled and Bound to 0.0.0.0:8088"
sudo asterisk -rx "pjsip show endpoint 1003"  # 1003 엔드포인트 출력
sudo ufw allow 8088/tcp                       # ufw 사용 시
```

## 로컬 실행

TTS 합성은 별도 `../tts-service` 가 담당하고, 이 서버는 콜봇 로그 tail (`/events`)
과 봇 응답 WAV 정적 서빙만 한다. **callbot venv 와 무관한 자체 venv 사용 가능.**

```bash
# 1) TTS 백엔드 (포트 8001) — 다른 콘솔
cd ../tts-service
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8001
# 자세한 옵션은 ../tts-service/README.md

# 2) 이벤트 브리지 (포트 8010 — config.js 의 eventsBackend/recvBase 와 일치해야 함)
cd ../web-rtc
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8010
# ※ 포트를 바꾸려면 config.js 의 eventsBackend/recvBase 도 같이 바꿀 것.
#   안 맞으면 SSE 타임라인·봇 응답 WAV 가 안 뜬다.
# TTS_SERVICE_URL 환경변수로 tts-service 주소 override 가능 (default http://localhost:8001)
# CALLBOT_LOG_PATH 로 콜봇 로그 경로 override 가능 (default /tmp/callbot.log)

# 3) 정적 파일 서버 (포트 3000) — 또 다른 콘솔
python -m http.server 3000
```

브라우저에서 <http://localhost:3000> 접속.

## 동작 검증 순서

1. **TTS 백엔드 단독**
   ```bash
   curl -X POST http://localhost:8001/tts \
        -H 'Content-Type: application/json' \
        -d '{"text":"안녕하세요"}' --output /tmp/tts.wav
   afplay /tmp/tts.wav
   ```
2. **SIP 등록** — 페이지를 열면 상태 배지가 `Disconnected → connecting → connected → Registered` 로 진행. 원격 서버에서 `asterisk -rx "pjsip show endpoint 1003"` 로 확인.
3. **통화** — `Call 2001` 클릭. 콜봇 인사말이 `<audio>` 에서 재생되어야 함.
4. **텍스트 발화** — 입력창에 "예약 변경하고 싶어요" 등 입력 → Send. 콜봇 콘솔의 STT 로그(`call_handler.py`)에 인식된 텍스트가 떠야 하고, LLM 응답이 다시 브라우저에서 재생됨.
5. **종료** — `Hang up`. 양쪽 BYE 정상 처리.

## 파일 구성

| 파일 | 역할 |
|------|------|
| `server.py` | FastAPI TTS 프록시. `../callbot/tts.py` 의 `GoogleTTS.synthesize` 를 그대로 호출해 24kHz WAV 반환 |
| `index.html` / `style.css` | UI |
| `config.js` | Asterisk/SIP 호스트, 비밀번호, TTS 엔드포인트 등 환경 값 |
| `app.js` | JsSIP UA + AudioContext 로 TTS-as-mic 파이프라인 구성 |
| `requirements.txt` | `fastapi`, `uvicorn[standard]` |

## 트러블슈팅

- **WS 연결 실패** (`UA started` 후 `connected` 가 안 옴) → 원격 `http.conf` 의 8088 포트 활성화 여부 확인. 방화벽에서 8088/tcp 열려 있어야 함.
- **REGISTER 실패** → 원격에서 `pjsip set logger on` 후 페이지 새로고침. 401 후 200 OK 흐름이 안 보이면 비밀번호 / `auth1003` 매칭 점검.
- **통화는 연결되나 음성이 안 들림** → ICE 협상 실패 가능성. DevTools Network → WS 프레임에서 SDP 확인. Asterisk 측 `rtp_symmetric` / NAT 설정 점검.
- **상대편이 내 음성을 못 들음** → AudioContext 가 `suspended` 상태일 수 있음. 페이지 클릭 후 다시 Send.
- **DTLS handshake 실패** → 운영 환경에서는 self-signed 임시 인증서로는 부족할 수 있음. `dtls_cert_file` / `dtls_ca_file` 명시 후 재시도.

## 끼어들기(barge-in) 실회선 테스트

콜봇의 barge-in(끼어들기) 기능을 실회선에서 검증하는 전용 패널이 UI 하단에 있다
("끼어들기(barge-in) 테스트"). `send()`/멀티질의와 달리 **겹침-방지 스케줄러를
우회**해 봇 발화 중에도 즉시 발화를 주입한다.

**콜봇 준비** (callbot/.env + 기동):

```bash
# callbot/.env: STT_PROVIDER=qwen3-asr (interim 필수), BARGE_IN_ENABLE=yes, BARGE_IN_PROBE_LOG=yes
cd ../callbot && source venv/bin/activate
LOG_LEVEL=DEBUG python main.py > /tmp/callbot.log 2>&1 &
# ※ probe(rms/va_cmax/thr)는 DEBUG 라서 LOG_LEVEL=DEBUG 여야 보인다(self-barge 실측 핵심).
```

**A군 — 기능 검증** (합성 주입, self-barge 없음): 통화 연결 → 봇에 개방형 질문으로
긴 답변을 유도 → 봇이 말하는 동안:

- **지금 주입**: 입력한 발화를 즉시 주입(수동 타이밍).
- **자동 주입 (봇 발화 후, 1회)**: 무장 후 다음 봇 발화 시작 + 슬라이더 지연(0~5s)에
  1회 자동 주입(타이밍 재현성).
- 기대: 타임라인에 `🔉 덕킹` → `⚡ 끼어들기 확정` → `⛔ TTS 중단` → `↪ 다음 턴 인계`
  배지, 봇이 끼어든 발화에 재응대. 추임새("네")는 `🔊 덕킹 해제`만 뜨고 중단 없음.

**B군 — self-barge 실측** (실마이크 경로): **"실마이크 모드" 체크** 후 통화 →
**스피커 ON**, 테스터는 침묵. 봇 음성이 마이크로 되잡혀 오검출되는지 관찰
(이 모드에선 합성 주입은 콜봇에 전달되지 않음 — 에코만 본다).

**로그 분석**: 수동 grep 대신 보조 스크립트 사용 —

```bash
cd ../callbot && python barge_in_logscan.py --probe /tmp/callbot.log
# 게이트 타임라인 + 확정→정지 지연 + probe rms/va_cmax/thr 통계(rms>=thr 비율)
```

상세 절차·판정 기준은 계획 문서(`docs-barge-in-handoff-*` 플랜) 참고.

## 알려진 한계

- WS 평문 전송. SIP 시그널링은 평문이지만 미디어는 DTLS-SRTP 로 암호화된다. 운영 단계에서는 WSS 로 전환 필요.
- 단일 사용자 가정. 멀티 탭/다중 사용자 부하 시나리오는 미검증.
- 콜봇이 말하는 도중 Send 를 누르면 음성이 겹친다 — 필요 시 재생 중에는 Send 비활성화 로직 추가 가능.
- **web-rtc 는 실마이크가 없어(합성 TTS 주입) self-barge(에코)를 재현 못 한다** — 그래서
  barge-in 패널의 "실마이크 모드"가 B군 전용으로 실제 마이크를 아웃바운드로 쓴다.
