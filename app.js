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

  const addBotBubble = (text, audioUrl) => {
    const row = _makeBubbleRow('bot', text, audioUrl);
    if (_activeWrap && _activeWrap._responseGroup) {
      _activeWrap._responseGroup.appendChild(row);
    } else {
      // 통화 시작 직후 인사말 등 — 아직 user wrap 이 없으므로 chat top-level.
      els.chat.appendChild(row);
    }
    els.chat.scrollTop = els.chat.scrollHeight;
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

  const speakText = async (text) => {
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
    addUserBubble(text, audioUrl);

    const buffer = await audioCtx.decodeAudioData(bytes);
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
  const _sendQueue = [];
  let _autoSendArmed = false;
  let _draining = false;

  const drainOne = async () => {
    if (_draining) return;
    const text = _sendQueue.shift();
    if (!text) return;
    _draining = true;
    try {
      await speakText(text);
    } catch (e) {
      log('Auto-send TTS error', e.message);
    } finally {
      _draining = false;
    }
  };

  // 매 listening 이벤트마다 큐에서 한 개 송신. callbot 이 같은 turn 을 retry
  // 해서 listening 이 한 번 더 발화되어도 그냥 drain. 결과적으로 사용자 메시지
  // N 개에 대해 N+a 번의 listening 이 발화될 수 있음 (a = retry 횟수). 이 경우
  // 큐가 먼저 고갈되고 잔여 listening 들은 무동작 (audio_source 가 silence 만
  // 읽다가 timeout). FIFO 매칭은 attachStt 의 success-only consume 으로 보존.
  window.addEventListener('callbot:listening', () => {
    if (_sendQueue.length > 0) drainOne();
    else _autoSendArmed = true;
  });

  const send = () => {
    const text = els.textInput.value.trim();
    if (!text) return;
    els.textInput.value = '';
    _sendQueue.push(text);
    if (_autoSendArmed) {
      _autoSendArmed = false;
      drainOne();
    }
  };
  els.sendBtn.addEventListener('click', send);
  els.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });

  ua.start();
  log('UA started, target', wsUri);

  startEvents();
})();
