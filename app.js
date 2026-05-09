/* eslint-disable no-console */
(() => {
  const cfg = window.APP_CONFIG;

  const els = {
    badge: document.getElementById('statusBadge'),
    meta: document.getElementById('statusMeta'),
    callBtn: document.getElementById('callBtn'),
    hangupBtn: document.getElementById('hangupBtn'),
    textInput: document.getElementById('textInput'),
    sendBtn: document.getElementById('sendBtn'),
    remoteAudio: document.getElementById('remoteAudio'),
    chat: document.getElementById('chat'),
    log: document.getElementById('log'),
  };

  const log = (msg, ...rest) => {
    const ts = new Date().toLocaleTimeString();
    const line = `[${ts}] ${msg}` + (rest.length ? ' ' + rest.map((r) =>
      typeof r === 'string' ? r : JSON.stringify(r)).join(' ') : '');
    els.log.textContent += line + '\n';
    els.log.scrollTop = els.log.scrollHeight;
    console.log(msg, ...rest);
  };

  const setState = (state, meta = '') => {
    els.badge.dataset.state = state;
    els.badge.textContent = state;
    els.meta.textContent = meta;
  };

  // ── 채팅 말풍선 ─────────────────────────────────────────────────
  // user(우측): 사용자가 보낸 텍스트 + ▶ 버튼 (송신된 WAV 재생)
  //            전송 직후 wrap 을 _pendingUserBubbles 큐에 push.
  //            서버에서 STT 결과 이벤트가 오면 큐의 가장 오래된 wrap 에
  //            "🎙 <transcript>" annotation 을 하위에 붙임 (FIFO).
  // bot(좌측): 콜봇 응답 텍스트(/events SSE) + ▶ 버튼 (응답 WAV 재생)
  const _pendingUserBubbles = [];

  const _makeBubbleRow = (kind, text, audioUrl) => {
    const row = document.createElement('div');
    row.className = `bubble ${kind}`;

    const btn = document.createElement('button');
    btn.className = 'play-btn';
    btn.type = 'button';
    btn.textContent = '▶';
    btn.title = (kind === 'user' ? '송신된' : '응답된') + ' TTS 음성 재생';

    const audio = audioUrl ? new Audio(audioUrl) : null;
    if (audio) {
      audio.addEventListener('ended', () => { btn.classList.remove('playing'); btn.textContent = '▶'; });
    } else {
      btn.disabled = true;
      btn.title = '재생 불가 (WAV 미수신)';
    }
    btn.addEventListener('click', () => {
      if (!audio) return;
      if (!audio.paused) {
        audio.pause(); audio.currentTime = 0;
        btn.classList.remove('playing'); btn.textContent = '▶';
        return;
      }
      btn.classList.add('playing'); btn.textContent = '■';
      audio.play().catch((e) => {
        log('Play error', e.message);
        btn.classList.remove('playing'); btn.textContent = '▶';
      });
    });

    const txt = document.createElement('span');
    txt.className = 'text';
    txt.textContent = text;

    if (kind === 'user') { row.appendChild(btn); row.appendChild(txt); }
    else                 { row.appendChild(txt); row.appendChild(btn); }
    return row;
  };

  // 각 user wrap 바로 다음에 response-group 을 배치해 그 wrap 에 대한
  // 봇 답변을 모은다. RTP 타이밍/retry 가 어긋나서 callbot 응답이 새 user
  // wrap 추가 후에 도착하더라도, _activeWrap 를 통해 올바른 group 으로 라우팅.
  let _activeWrap = null;

  const addUserBubble = (text, audioUrl) => {
    const wrap = document.createElement('div');
    wrap.className = 'bubble-wrap user';
    wrap.appendChild(_makeBubbleRow('user', text, audioUrl));
    const grp = document.createElement('div');
    grp.className = 'response-group';
    wrap._responseGroup = grp;
    // STT 도착까지 걸린 시간을 annotation 에 표시하기 위해 송신 시각 기록.
    wrap._sentAt = Date.now();
    els.chat.appendChild(wrap);
    els.chat.appendChild(grp);
    els.chat.scrollTop = els.chat.scrollHeight;
    _pendingUserBubbles.push(wrap);
  };

  // 봇 응답 quiet period 추적 — 봇 chunk 가 multi-part 로 도착하므로,
  // 마지막 봇 bubble 후 N초 동안 신규 chunk 없으면 "응답 끝났다" 로 간주.
  let _lastBotBubbleAt = 0;

  const addBotBubble = (text, audioUrl) => {
    _lastBotBubbleAt = Date.now();
    // 봇이 새 chunk 를 보냈으므로 예약된 송신 timer 가 있다면 reset (재시작).
    if (_pendingDrainTimer) {
      clearTimeout(_pendingDrainTimer);
      _pendingDrainTimer = null;
    }
    const row = _makeBubbleRow('bot', text, audioUrl);
    if (_activeWrap && _activeWrap._responseGroup) {
      _activeWrap._responseGroup.appendChild(row);
    } else {
      // 통화 시작 직후 인사말 등 — 아직 user wrap 이 없으므로 chat top-level.
      els.chat.appendChild(row);
    }
    els.chat.scrollTop = els.chat.scrollHeight;
    // listening 이 미리 와서 armed 상태에서 봇 응답이 다시 온 경우, quiet
    // period 후 재시도하도록 timer 재예약.
    if (_listeningArmed && _sendQueue.length > 0) {
      _scheduleQuietDrain();
    }
  };

  const attachStt = (transcript, success) => {
    // success only consume — fail/non_voice/error 는 callbot 의 retry 로 인한
    // 부가 이벤트이므로 wrap 을 consume 하지 않는다 (FIFO 매칭 보존).
    // 다만 fail 시에도 _activeWrap 은 가장 오래된 pending wrap 으로 갱신해
    // 후속 fallback 봇 멘트("잘 들리지 않습니다")가 올바른 group 으로 가도록.
    const ok = success && transcript && transcript !== 'non_voice' && transcript !== 'error';
    if (!ok) {
      if (_pendingUserBubbles[0]) _activeWrap = _pendingUserBubbles[0];
      return;
    }
    const wrap = _pendingUserBubbles.shift();
    if (!wrap) return;
    _activeWrap = wrap;
    const annot = document.createElement('div');
    annot.className = 'stt-annot';
    // latency: 사용자 송신 (wrap 생성) 시점 → STT 결과 도착 시점.
    // retry 가 발생하면 그만큼 길어지므로, retry 영향을 사용자가 시각적으로 인지 가능.
    const latencyMs = wrap._sentAt ? Date.now() - wrap._sentAt : null;
    const latencyTag = latencyMs != null ? ` (${(latencyMs / 1000).toFixed(1)}s)` : '';
    annot.textContent = `🎙${latencyTag} ${transcript}`;
    wrap.appendChild(annot);
    els.chat.scrollTop = els.chat.scrollHeight;
  };

  // ── 콜봇 응답 SSE 구독 ─────────────────────────────────────────
  // 서버(/events) 가 callbot 로그의 'TTS enqueue:' 라인을 push.
  // 동일 텍스트가 짧은 시간에 중복 도착하는 경우 한 번만 표시.
  let _lastBotKey = '';
  const startEvents = () => {
    try {
      const es = new EventSource(cfg.eventsBackend);
      es.onmessage = (e) => {
        if (!e.data) return;
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        // (1) Listening 윈도우 시작 — 자동 송신 스케줄러가 이 시점을 신호로 사용.
        if (data.type === 'listening') {
          window.dispatchEvent(new CustomEvent('callbot:listening'));
          return;
        }
        // (2) STT 인식 결과 — 가장 최근 사용자 말풍선 하위에 annotation
        if (data.type === 'stt') {
          attachStt(data.transcript, data.success);
          return;
        }
        // (3) 봇 응답 텍스트
        const text = data.text;
        if (!text) return;
        const key = text + '|' + (data.url || '');
        if (key === _lastBotKey) return;
        _lastBotKey = key;
        const url = data.url ? cfg.recvBase + data.url : null;
        addBotBubble(text, url);
      };
      es.onerror = () => log('Events stream error (will auto-retry)');
    } catch (e) {
      log('Events init failed', e.message);
    }
  };

  // ── AudioContext / TTS-as-mic 파이프라인 ──────────────────────────
  // 단일 AudioContext + 단일 MediaStreamAudioDestinationNode 를 통화 수명 동안 유지.
  // TTS 합성된 음성을 BufferSource 로 destination 에 흘려보내면 그 stream 이
  // 통화의 마이크처럼 동작한다.
  let audioCtx = null;
  let micDest = null;

  const ensureAudioPipeline = async () => {
    if (!audioCtx) {
      // sampleRate: 8000 — ulaw 네이티브 레이트와 일치시켜 브라우저 내부 보간 단계 제거.
      // 서버가 8kHz WAV 를 내려주므로 decodeAudioData 도 리샘플링 없이 통과.
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 8000 });
      micDest = audioCtx.createMediaStreamDestination();
      // 인코더 keep-warm: 0 신호를 항상 흘려 RTP 송출이 50pps 로 유지되게 함.
      // (Send 사이 무신호 구간에 WebRTC 인코더가 throttle/idle 되어 callbot 측에
      //  RTP 가 ~60ms 간격으로 도착하던 것을 일정 cadence 로 보정.)
      const silence = audioCtx.createConstantSource();
      silence.offset.value = 0;
      silence.connect(micDest);
      silence.start();
    }
    if (audioCtx.state === 'suspended') {
      // 브라우저 자동재생 정책: 사용자 클릭 이후 resume.
      await audioCtx.resume();
    }
  };

  // user 가 Send 누른 즉시 background 에서 fetch + decodeAudioData 를 끝낸다.
  // 결과 (audioUrl, AudioBuffer) 를 _sendQueue 항목에 prefetchPromise 로 첨부.
  // listening event 도달 시 drainOne 은 prefetchPromise 만 await 하면 되므로
  // (이미 resolved 일 가능성 높음) 즉시 src.start() 가능 → fetch 지연이 listening
  // window 와 분리됨 → callbot 의 1st STT timeout 발생률 대폭 감소.
  const prefetchTTS = async (text) => {
    await ensureAudioPipeline();
    const res = await fetch(cfg.ttsBackend, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`TTS ${res.status}: ${err}`);
    }
    const bytes = await res.arrayBuffer();
    // decodeAudioData 가 ArrayBuffer 를 detach 시킬 수 있으므로,
    // blob 용 사본을 먼저 떠둔다.
    const blob = new Blob([bytes.slice(0)], { type: 'audio/wav' });
    const audioUrl = URL.createObjectURL(blob);
    const buffer = await audioCtx.decodeAudioData(bytes);
    return { text, audioUrl, buffer };
  };

  // 같은 text 를 다시 보낼 때 fetch/decode 를 반복하지 않는다.
  // AudioBuffer 는 createBufferSource 로 매번 새 source 를 만들면 재사용 가능,
  // blob URL 도 revoke 하지 않으면 여러 번 재생 가능. 따라서 prefetchTTS 결과를
  // 그대로 캐싱해 두 번째 송신부터는 즉시 src.start() 까지 갈 수 있다.
  const _ttsCache = new Map();  // text → Promise<{text, audioUrl, buffer}>

  const getOrPrefetchTTS = (text) => {
    const cached = _ttsCache.get(text);
    if (cached) {
      log(`TTS cache hit: ${text.slice(0, 30)}${text.length > 30 ? '…' : ''}`);
      return cached;
    }
    const promise = prefetchTTS(text).catch((e) => {
      log('Prefetch error', e.message);
      // 실패한 promise 가 캐시에 남으면 다음 호출도 같은 실패를 반환 — 제거.
      _ttsCache.delete(text);
      return null;
    });
    _ttsCache.set(text, promise);
    return promise;
  };

  const playPrefetched = async ({ text, audioUrl, buffer }) => {
    await ensureAudioPipeline();
    addUserBubble(text, audioUrl);
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(micDest);
    src.start();
    log(`TTS played: ${text.slice(0, 40)}${text.length > 40 ? '…' : ''} (${buffer.duration.toFixed(2)}s)`);
  };

  // ── JsSIP UA ──────────────────────────────────────────────────────
  const wsUri = `ws://${cfg.asteriskHost}:${cfg.asteriskWsPort}/ws`;
  const socket = new JsSIP.WebSocketInterface(wsUri);
  const ua = new JsSIP.UA({
    sockets: [socket],
    uri: `sip:${cfg.sipUser}@${cfg.asteriskHost}`,
    password: cfg.sipPassword,
    register: true,
    session_timers: false,
  });

  let activeSession = null;

  ua.on('connecting', () => setState('connecting', wsUri));
  ua.on('connected', () => setState('connected', wsUri));
  ua.on('disconnected', (e) => {
    setState('disconnected', e?.reason || '');
    log('UA disconnected', e?.reason || '');
  });
  ua.on('registered', () => {
    setState('registered', `as ${cfg.sipUser}@${cfg.asteriskHost}`);
    els.callBtn.disabled = false;
  });
  ua.on('unregistered', () => setState('unregistered'));
  ua.on('registrationFailed', (e) => {
    setState('register-failed', e?.cause || '');
    log('Register failed', e);
  });

  const onCallEnded = () => {
    activeSession = null;
    els.callBtn.disabled = false;
    els.hangupBtn.disabled = true;
    els.textInput.disabled = true;
    els.sendBtn.disabled = true;
    setState('registered', `as ${cfg.sipUser}@${cfg.asteriskHost}`);
  };

  els.callBtn.addEventListener('click', async () => {
    try {
      await ensureAudioPipeline();
    } catch (e) {
      log('AudioContext init failed', e.message);
      return;
    }

    const target = `sip:${cfg.callExtension}@${cfg.asteriskHost}`;
    log(`Calling ${target}`);

    activeSession = ua.call(target, {
      mediaStream: micDest.stream,                         // ★ TTS 출력 = 마이크
      mediaConstraints: { audio: false, video: false },
      pcConfig: { iceServers: cfg.iceServers },
    });

    els.callBtn.disabled = true;
    els.hangupBtn.disabled = false;

    activeSession.on('progress', () => log('progress'));
    activeSession.on('accepted', () => {
      setState('in-call', `with ${cfg.callExtension}`);
      els.textInput.disabled = false;
      els.sendBtn.disabled = false;
      _activeWrap = null;
      _lastBotBubbleAt = 0;
      _listeningArmed = false;
      if (_pendingDrainTimer) { clearTimeout(_pendingDrainTimer); _pendingDrainTimer = null; }
    });
    activeSession.on('confirmed', () => log('confirmed'));
    activeSession.on('ended', (e) => {
      log('ended', e?.cause || '');
      onCallEnded();
    });
    activeSession.on('failed', (e) => {
      log('failed', e?.cause || '');
      onCallEnded();
    });

    // 원격 트랙(콜봇 음성) → <audio>
    activeSession.connection.addEventListener('track', (e) => {
      log('remote track received');
      if (els.remoteAudio.srcObject !== e.streams[0]) {
        els.remoteAudio.srcObject = e.streams[0];
      }
    });
  });

  els.hangupBtn.addEventListener('click', () => {
    if (activeSession) {
      activeSession.terminate();
    }
  });

  // ── Auto-send: callbot listening window 에 정렬 ─────────────────
  // user audio 가 callbot 의 1st listening window 안에 도달하지 못하면
  // callbot 이 같은 turn 을 retry — fallback 멘트("잘 들리지 않습니다")
  // 가 끼어들어 응답이 ~10초 지연되고, retry 로 인한 추가 STT 이벤트가
  // FIFO 큐 매칭을 어긋나게 한다. listening 이벤트가 도착할 때만 한 개씩
  // 송신해 audio 가 항상 1st window 안에 도달하도록 한다.
  // 큐 항목 = { text, prefetchPromise }. prefetchPromise 는 send() 시 즉시
  // 시작되어 background 에서 TTS fetch + decode 를 끝내 둔다.
  const _sendQueue = [];
  let _draining = false;
  // listening 이벤트가 도착했지만 봇 응답이 아직 끝나지 않았을 수 있어 quiet
  // period (BOT_QUIET_MS) 만큼 마지막 봇 bubble 후 대기하고 drain. 봇 chunk
  // 가 multi-part 라 listening 직후 바로 송신하면 봇 후속 chunk 와 user audio
  // 가 SIP 채널에서 충돌하거나, callbot 측 RTP 큐의 누적 silence 가 다 빠지기
  // 전에 user audio 가 묻혀 STT 의 1st window 가 fail 하는 패턴 발생.
  let _listeningArmed = false;
  let _pendingDrainTimer = null;
  const BOT_QUIET_MS = 3000;

  const drainOne = async () => {
    if (_draining) return;
    const item = _sendQueue.shift();
    if (!item) return;
    _draining = true;
    try {
      const data = await item.prefetchPromise;
      if (!data) return;  // prefetch 실패
      await playPrefetched(data);
    } catch (e) {
      log('Auto-send error', e.message);
    } finally {
      _draining = false;
    }
  };

  const _scheduleQuietDrain = () => {
    if (_pendingDrainTimer) clearTimeout(_pendingDrainTimer);
    if (_sendQueue.length === 0) return;
    const elapsedSinceBot = _lastBotBubbleAt ? Date.now() - _lastBotBubbleAt : BOT_QUIET_MS;
    const waitMs = Math.max(0, BOT_QUIET_MS - elapsedSinceBot);
    _pendingDrainTimer = setTimeout(() => {
      _pendingDrainTimer = null;
      _listeningArmed = false;
      if (_sendQueue.length > 0 && !_draining) drainOne();
    }, waitMs);
  };

  // listening 이벤트가 오면 즉시 drain 하지 않고, 마지막 봇 응답으로부터 3초
  // 의 quiet period 가 보장될 때 drain. 그 사이에 봇이 새 chunk 를 보내면
  // addBotBubble 이 timer 를 reset.
  window.addEventListener('callbot:listening', () => {
    _listeningArmed = true;
    if (_sendQueue.length > 0) _scheduleQuietDrain();
  });

  const send = () => {
    const text = els.textInput.value.trim();
    if (!text) return;
    els.textInput.value = '';
    // getOrPrefetchTTS: 같은 text 면 캐시된 prefetch promise 그대로 사용.
    // 새 text 면 background 에서 fetch+decode 시작 (listening event 가 도달하기
    // 전에 끝나면 drainOne 은 즉시 src.start()).
    const prefetchPromise = getOrPrefetchTTS(text);
    _sendQueue.push({ text, prefetchPromise });
    // listening 이 이미 와 있으면 quiet drain 예약. 아직이면 listening 이벤트
    // 도착 시 자동 예약됨.
    if (_listeningArmed) _scheduleQuietDrain();
  };
  els.sendBtn.addEventListener('click', send);
  els.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });

  ua.start();
  log('UA started, target', wsUri);

  startEvents();
})();
