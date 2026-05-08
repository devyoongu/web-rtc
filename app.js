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
  // bot(좌측): 콜봇 응답 텍스트(/events SSE) + ▶ 버튼 (응답 WAV 재생)
  const addBubble = (kind, text, audioUrl) => {
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

    // user: [▶] [text]   bot: [text] [▶]
    if (kind === 'user') {
      row.appendChild(btn);
      row.appendChild(txt);
    } else {
      row.appendChild(txt);
      row.appendChild(btn);
    }
    els.chat.appendChild(row);
    els.chat.scrollTop = els.chat.scrollHeight;
  };

  const addUserBubble = (text, audioUrl) => addBubble('user', text, audioUrl);
  const addBotBubble = (text, audioUrl) => addBubble('bot', text, audioUrl);

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
        if (!data.text) return;
        const key = data.text + '|' + (data.url || '');
        if (key === _lastBotKey) return;
        _lastBotKey = key;
        const url = data.url ? cfg.recvBase + data.url : null;
        addBotBubble(data.text, url);
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

  const send = async () => {
    const text = els.textInput.value.trim();
    if (!text) return;
    els.sendBtn.disabled = true;
    try {
      await speakText(text);
      els.textInput.value = '';
    } catch (e) {
      log('TTS error', e.message);
    } finally {
      els.sendBtn.disabled = !activeSession;
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
