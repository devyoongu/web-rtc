# STT 인식률 개선 — 변경 사항 종합 정리

> 작성일: 2026-05-09
> 환경: 로컬 callbot (ext 2001) ← Asterisk 172.31.79.202 ← 브라우저 (ext 1003, ws+DTLS-SRTP)
> STT: Google Cloud Speech V2, model=`telephony`, language=`ko-KR`, 16kHz (callbot 이 8k→16k 업샘플)
> 측정 방법: SK쉴더스 사이버보안 FAQ 5개 질의를 자동 큐잉 후 callbot 측 STT 결과/이벤트 로그 비교

## 출발점

- 초기: STT 정확도 ~40% (loose match) plateau, "잘 들리지 않습니다" 빈번
- 사용자 말풍선과 callbot STT 결과의 시각적 mismatch
- 봇 답변이 다음 user 말풍선 아래에 표시되어 혼란

## 최종 결과 (TTS ON, retry 0회)

| Turn | First audio (reads) | STT 결과 | 매칭 |
|------|---------------------|----------|------|
| T0 | 5  | 중소기업도 인증이 꼭 필요한가요 | ✓ 전체 |
| T1 | 1014 | 제로트러스트 보안이란 무엇인가요 | ✓ 전체 |
| T2 | 476 | 랜섬웨어는 어떻게 유입되나요 | ✓ 전체 |
| T3 | 1050 | 보안 운영 서비스는 왜 필요한가요 | ✓ 전체 |
| T4 | 988 | 얼굴 인식기는 실도 철 | ✗ 부분 (STT 모델 한계) |

- **5턴 모두 retry 0회** ("잘 들리지 않습니다" 발화 없음)
- 4/5 완전 일치, 1/5 부분 인식 (얼굴인식기 후반부 — STT 모델 인식 한계)

## 핵심 변경 — repository 별

### web-rtc (브라우저 클라이언트)

| 커밋 | 설명 | 효과 |
|------|------|------|
| `c438ce1` | TTS 송출 체인을 8kHz 단일 레이트로 정렬 | 보간 단계 제거, baseline 설정 |
| `2b1a27d` | TTS 합성 결과 WAV 를 `wav/sent/` 에 자동 저장 | 진단 자료 |
| `96de240` | 채팅 UI 도입 — 송신 메시지 말풍선 + ▶ 재생 버튼 | UX |
| `7aebd61` | 콜봇 응답을 채팅 UI 좌측 말풍선으로 표시 | UX |
| `ba4da36` | SSE 에 `listening` 이벤트 추가 | 송신 타이밍 정렬 신호 |
| `7f4503d` | 사용자 말풍선 하위에 STT 인식 결과 annotation 표시 | 인식 결과 가시화 |
| `8182ab6` | **ConstantSourceNode keep-warm** | WebRTC 인코더 RTP cadence 50pps 안정화 |
| `fc8c66e` | **Listening-aligned auto-send + success-only STT consume** | annotation 시프트 0 |
| `fe9cfc9` | **Response-group 컨테이너** | 봇 답변을 해당 user wrap 의 group 으로 라우팅 |
| `cd28748` | STT annotation 에 latency 표시 | 진단 가시화 |
| `adfa3b0` | **TTS pre-fetch** — Send 즉시 fetch+decode background | listening 도착 시 즉시 src.start, fetch 지연 분리 |
| `db26a0c` | **Quiet-drain** — 마지막 봇 bubble 후 3초 대기 후 송신 | 봇 multi-chunk 응답 안전 종료 후 송신 |

### callbot (Python SIP-extension AI 콜봇)

| 커밋 | 설명 | 효과 |
|------|------|------|
| `a23187a` | audio_source: leading silence 를 STT 입력에서 제거 | leading silence padding 의 STT 음소 오매칭 차단 |
| `aaf6799` | `CALLBOT_TTS_DISABLED` 환경변수 추가 | STT 단독 검증 시 echo/RTP 잡음 제거 |
| `a279192` | **audio_source leading-silence drain sleep 10ms → 1ms** | 누적 silence 패킷 drain 9초 → 0.9초 |

### asterisk (PBX)

| 커밋 | 설명 | 효과 |
|------|------|------|
| `b8d2550f8` | ext 2001 dialplan 에 `JITTERBUFFER(adaptive)=200` | browser RTP burst 평탄화 (retry 1차 원인은 아님으로 검증) |

## STT 인식률을 높인 핵심 메커니즘

### 1. 8kHz 단일 레이트 체인 정렬 — `c438ce1` (web-rtc)
브라우저 AudioContext, server.py /tts, callbot RTP 모두 8kHz ulaw 로 통일. 중간 보간 단계 제거.

### 2. RTP cadence 안정화 — `8182ab6` (web-rtc)
브라우저의 micDest 에 항상 0 신호를 흘리는 ConstantSourceNode 를 부착. WebRTC 인코더가 무신호 구간에 throttle/idle 되어 RTP 가 ~60ms 간격으로 도착하던 것을 50pps 로 보정.

### 3. Listening-aligned auto-send — `fc8c66e` (web-rtc)
SSE 의 `listening` 이벤트를 listener 로 잡아, 사용자가 미리 입력한 메시지 큐에서 한 개씩 send. callbot 의 1st STT window 에 audio 가 정확히 도달해 retry 발생률 감소.

### 4. STT 매칭 success-only consume — `fc8c66e` (web-rtc)
callbot 의 같은-Turn-내 retry 패턴 (fail STT + retry success STT) 으로 1 user audio 가 2 STT 이벤트를 발생시키는 경우, success 만 wrap 을 consume 해 FIFO 매칭 정렬 유지.

### 5. Response-group 시각 그룹화 — `fe9cfc9` (web-rtc)
각 user wrap 직후에 `response-group` 컨테이너를 sibling 으로 배치. `_activeWrap` 으로 봇 답변을 해당 wrap 의 group 에 라우팅. 봇 답변이 다음 wrap 아래에 잘못 표시되던 시각적 mismatch 해결.

### 6. TTS pre-fetch — `adfa3b0` (web-rtc)
사용자가 Send 누른 즉시 background 에서 `fetch(/tts) + decodeAudioData` 를 시작. listening event 도착 시 prefetchPromise 만 await (이미 resolved) 하여 즉시 `src.start()`. fetch 변동성 (캐시 miss 1-3초+) 을 listening window 와 분리.

### 7. Quiet-drain — `db26a0c` (web-rtc, 사용자 제안)
봇 응답이 multi-chunk 로 도착하므로 listening 이벤트 직후 즉시 송신 시 봇 후속 chunk 와 SIP 채널 충돌 가능. `_lastBotBubbleAt` 추적하여 마지막 봇 bubble 후 3초 quiet period 보장 후 drain. 그 사이에 봇이 새 chunk 보내면 timer reset.

### 8. Leading silence drain 가속 — `a279192` (callbot)
`audio_source` 의 pre-started 단계에서 `time.sleep(0.01)` → `time.sleep(0.001)`. 봇 TTS 응답 동안 누적된 keep-warm silence 패킷 (turn당 18s × 50pps = ~900) 을 1초 안에 비워 first audio 도달 시간 단축.

### 9. callbot retry 동작 자체 보존 — 의도적 비변경
callbot 의 `pipeline.wait_drained()` + `dialog_count` 미증가 + `continue` 패턴은 정상적인 무음 처리 로직. 사용자가 침묵하는 정상 케이스 (실제 통화) 에서 작동해야 함. 변경하지 않음.

### 10. JITTERBUFFER 가설 검증 — 원복 (asterisk)
`JITTERBUFFER(adaptive)=200` 이 retry 의 1차 원인일 것으로 가설 → 제거하여 검증 → 일부 turn 의 first-audio reads 6배 단축됐으나 retry 발생 자체는 동일하게 2회 → 가설 부분 기각, 원복.

## 진단/검증에 도움이 된 보조 변경

- **STT latency 표시** (`cd28748`): annotation 에 송신부터 STT 결과 도착까지의 시간 표기 — retry 영향 즉시 가시화.
- **CALLBOT_TTS_DISABLED** (`aaf6799`): 봇 TTS RTP 송출 OFF 모드. STT 단독으로 검증 가능 → "잘 들리지 않습니다" 가 callbot retry 메커니즘 (browser 측 fail 이 아님) 임을 분리 입증.
- **`[AudioSource] First audio received after N reads`** 로그: pyVoIP 큐 누적 vs RTP 도달 시간을 직관적으로 측정.
- **`[AudioSource] Done: N/M reads had audio`** 로그: STT가 처리한 실 audio 비율 — 0/M 이면 buffer 누적으로 audio 도달 못 함.

## 측정 진행 (시점별)

| 시점 | 변경 | retry 횟수 (5-FAQ) | 비고 |
|------|------|--------------------|------|
| 초기 | baseline (8kHz 정렬만) | 다수, 정확도 ~40% loose | "잘 들리지 않습니다" 빈번 |
| ConstantSourceNode 추가 | `8182ab6` | TTS OFF: 0회 / TTS ON: 2-3회 | RTP cadence 안정화 |
| Auto-send + success consume | `fc8c66e` | TTS ON: 2회, 시프트 0 | annotation 시프트 해결 |
| Response-group | `fe9cfc9` | TTS ON: 2회 | 시각 mismatch 해결 |
| TTS prefetch | `adfa3b0` | TTS OFF: 0회 / TTS ON: 2회 | first audio 빠름 (5 reads) |
| Quiet-drain + drain 가속 | `db26a0c` + `a279192` | **TTS ON: 0회** | 최종 |

## 알려진 잔존 이슈

- T4 ("얼굴인식기는 실외에도 설치 가능한가요") 의 후반부가 일관되게 부분 인식 — STT 모델/도메인 어휘 한계로 추정. retry/timing 과 무관. 별도 phrase hints 도입 등으로 개선 가능.
- T0 의 first audio 도달이 일정하지 않음 (5 reads ~ 763 reads). 통화 시작 직후 WebRTC 핸드셰이크 변동성. 사용자 인지 영향 미미.

## 비목표 / 이번 작업 범위 밖

- callbot Athena LLM 응답 품질 / 도메인 매칭
- STT phrase hints / 도메인 어휘 사전
- pyVoIP RTP 처리 아키텍처 (always-on read thread 등)
- 다중 동시 통화 부하 시 동작
