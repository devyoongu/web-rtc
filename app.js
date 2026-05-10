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
    // 멀티 질의 (행 기반) — index.html 의 .multi-say section.
    multiRows:   document.getElementById('multiRows'),
    addRowBtn:   document.getElementById('addRowBtn'),
    applyAllBtn: document.getElementById('applyAllBtn'),
    multiHint:   document.getElementById('multiHint'),
    metricsPanel: document.getElementById('metricsPanel'),
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

  // ── 통화 성능 메트릭 ──────────────────────────────────────────
  // accepted 시 reset, ended/failed 시 패널 렌더. 4개 지표:
  // STT 인식률 (1−CER), STT 평균 latency, TTS 평균 TTFA(>임계값), TTS 캐시 히트율.
  // 임계값 100ms — 그 이하는 디스크 캐시 히트로 간주해 평균 TTFA 에서 제외.
  const TTFA_CACHE_THRESHOLD_MS = 100;
  let _metrics = null;

  const _resetMetrics = () => {
    _metrics = { sttResults: [], ttsTtfa: [] };
  };

  // 문자(코드포인트) 단위 Levenshtein. 한글 음절은 Hangul Syllables 영역의 단일
  // 코드포인트라 [...str] split 으로 음절 단위 비교가 자연스럽다.
  const _cer = (ref, hyp) => {
    const a = [...(ref || '').trim()];
    const b = [...(hyp || '').trim()];
    if (!a.length && !b.length) return 0;
    if (!a.length || !b.length) return 1;
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = a[i-1] === b[j-1]
          ? dp[i-1][j-1]
          : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
      }
    }
    return dp[a.length][b.length] / Math.max(a.length, b.length);
  };

  const renderMetricsPanel = () => {
    if (!_metrics || !els.metricsPanel) return;
    const { sttResults, ttsTtfa } = _metrics;

    const sttN = sttResults.length;
    const accs = sttResults.map(r => 1 - _cer(r.original, r.recognized));
    const accAvg = sttN ? accs.reduce((a, b) => a + b, 0) / sttN : 0;
    const sttLatencies = sttResults.map(r => r.latencyMs).filter(v => typeof v === 'number');
    const sttLatAvg = sttLatencies.length
      ? sttLatencies.reduce((a, b) => a + b, 0) / sttLatencies.length
      : null;

    const ttsN = ttsTtfa.length;
    const cacheHits = ttsTtfa.filter(t => t.ttfaMs <= TTFA_CACHE_THRESHOLD_MS).length;
    const cacheRate = ttsN ? cacheHits / ttsN : 0;
    const nonCached = ttsTtfa.filter(t => t.ttfaMs > TTFA_CACHE_THRESHOLD_MS);
    const ttfaAvg = nonCached.length
      ? nonCached.reduce((a, t) => a + t.ttfaMs, 0) / nonCached.length
      : null;

    const fmtMs = (v) => v == null ? '—' : v >= 1000 ? `${(v/1000).toFixed(2)}s` : `${Math.round(v)}ms`;
    const fmtPct = (v) => `${(v * 100).toFixed(1)}%`;

    els.metricsPanel.hidden = false;
    els.metricsPanel.innerHTML = `
      <div class="metrics-title">통화 성능 리포트</div>
      <div class="metrics-grid">
        <div class="metric"><div class="metric-label">STT 인식률</div>
          <div class="metric-value">${sttN ? fmtPct(accAvg) : '—'}</div>
          <div class="metric-sub">n=${sttN} (avg CER ${sttN ? fmtPct(1 - accAvg) : '—'})</div></div>
        <div class="metric"><div class="metric-label">STT 평균 latency</div>
          <div class="metric-value">${fmtMs(sttLatAvg)}</div>
          <div class="metric-sub">n=${sttLatencies.length}</div></div>
        <div class="metric"><div class="metric-label">TTS 평균 TTFA</div>
          <div class="metric-value">${fmtMs(ttfaAvg)}</div>
          <div class="metric-sub">n=${nonCached.length} (캐시 ≤${TTFA_CACHE_THRESHOLD_MS}ms 제외)</div></div>
        <div class="metric"><div class="metric-label">TTS 캐시 히트율</div>
          <div class="metric-value">${ttsN ? fmtPct(cacheRate) : '—'}</div>
          <div class="metric-sub">${cacheHits}/${ttsN}</div></div>
      </div>
    `;
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
    els.chat.appendChild(wrap);
    els.chat.appendChild(grp);
    els.chat.scrollTop = els.chat.scrollHeight;
    _pendingUserBubbles.push(wrap);
  };

  // 봇 응답 quiet period 추적 — 봇 chunk 가 multi-part 로 도착하므로,
  // 마지막 봇 bubble 후 N초 동안 신규 chunk 없으면 "응답 끝났다" 로 간주.
  let _lastBotBubbleAt = 0;

  // 봇 오디오 실제 재생 종료 추정 시각 — 봇 bubble enqueue 시각만 보면
  // RTP 로 흘러가는 봇 음성이 끝나기 전에 질의 TTS 가 겹쳐 재생될 수 있다.
  // 봇 응답 wav (/wav/recv/...) duration 을 미리 읽어 enqueue+duration+safety
  // 까지 "봇이 말하는 중" 으로 표시 → drain 은 이 시각 후로 미룬다.
  let _botAudioBusyUntil = 0;
  const BOT_AUDIO_SAFETY_MS = 500;

  const _bumpBotAudioBusyUntil = (audioUrl, enqueuedAt) => {
    if (!audioUrl) return;
    const probe = new Audio();
    probe.preload = 'metadata';
    probe.addEventListener('loadedmetadata', () => {
      if (!isFinite(probe.duration)) return;
      const endsAt = enqueuedAt + probe.duration * 1000 + BOT_AUDIO_SAFETY_MS;
      if (endsAt > _botAudioBusyUntil) {
        _botAudioBusyUntil = endsAt;
        // drain 이 이미 timer 로 걸려 있으면 새 deadline 으로 갱신.
        if (_listeningArmed && _sendQueue.length > 0) _scheduleQuietDrain();
      }
    }, { once: true });
    probe.src = audioUrl;
  };

  // tts_ttfa 이벤트는 bot_text 이벤트 뒤에 한 번 더 도착하므로, 매 봇 bubble row 를
  // text 별 큐에 등록해 두고 TTFA 도착 시 FIFO 로 매칭 후 annotation 부착.
  // (max_workers=2 의 합성 시작 순서가 enqueue 순서와 어긋날 수 있지만, 같은 텍스트
  //  가 한 응답 내 중복 등장하는 케이스가 드물어 텍스트 기준 매칭으로 충분.)
  const _pendingTtfaBubbles = new Map();  // text → [row, …]

  const _registerTtfaPending = (text, row) => {
    if (!_pendingTtfaBubbles.has(text)) _pendingTtfaBubbles.set(text, []);
    _pendingTtfaBubbles.get(text).push(row);
  };

  const attachTtfaLatency = (text, ttfaMs) => {
    if (_metrics && typeof ttfaMs === 'number') _metrics.ttsTtfa.push({ ttfaMs });
    const arr = _pendingTtfaBubbles.get(text);
    if (!arr || !arr.length) return;
    const row = arr.shift();
    if (!arr.length) _pendingTtfaBubbles.delete(text);
    const annot = document.createElement('div');
    annot.className = 'bot-latency-annot ttfa';
    const ttfaTxt = ttfaMs >= 1000
      ? `${(ttfaMs / 1000).toFixed(2)}s`
      : `${ttfaMs}ms`;
    // TTFA = Time To First Audio chunk: callbot 이 합성 시작 → 첫 8kHz 8-bit
    // PCM chunk 가 재생 큐에 push 되기까지의 latency. 전체 합성 시간이 아닌
    // "첫 음성이 들리기 시작할 수 있는 시점" 까지의 시간.
    annot.textContent = `⚙ TTS TTFA ${ttfaTxt}`;
    // 해당 row 바로 아래(같은 문장에 속한 기존 annotation 다음)에 삽입.
    // row 직후에 이미 STT→bot latency 등 .bot-latency-annot 가 있으면 그 뒤로.
    let after = row;
    while (after.nextElementSibling &&
           after.nextElementSibling.classList.contains('bot-latency-annot')) {
      after = after.nextElementSibling;
    }
    after.insertAdjacentElement('afterend', annot);
    els.chat.scrollTop = els.chat.scrollHeight;
  };

  const addBotBubble = (text, audioUrl, sttToBotMs, kind) => {
    const enqueuedAt = Date.now();
    _lastBotBubbleAt = enqueuedAt;
    // 봇 오디오 실제 재생 종료 시각 갱신 — drain gate 에 사용.
    _bumpBotAudioBusyUntil(audioUrl, enqueuedAt);
    // 봇이 새 chunk 를 보냈으므로 예약된 송신 timer 가 있다면 reset (재시작).
    if (_pendingDrainTimer) {
      clearTimeout(_pendingDrainTimer);
      _pendingDrainTimer = null;
    }
    const row = _makeBubbleRow('bot', text, audioUrl);
    const container = (_activeWrap && _activeWrap._responseGroup)
      ? _activeWrap._responseGroup
      : els.chat;  // 통화 시작 직후 인사말 등 — 아직 user wrap 이 없을 때.
    container.appendChild(row);
    // 첫 안내멘트(meta_first) / 첫 본답변(reply_first) 의 STT→bot latency 표시.
    // callbot 이 turn 별 첫 emit 에만 stt_to_bot_ms 를 첨부 → 이후 chunk 는 미부여.
    if (typeof sttToBotMs === 'number' &&
        (kind === 'meta_first' || kind === 'reply_first')) {
      const annot = document.createElement('div');
      annot.className = 'bot-latency-annot';
      const label = kind === 'meta_first' ? '안내멘트' : '본답변';
      const latencyTxt = sttToBotMs >= 1000
        ? `${(sttToBotMs / 1000).toFixed(2)}s`
        : `${sttToBotMs}ms`;
      annot.textContent = `⏱ STT→${label} ${latencyTxt}`;
      container.appendChild(annot);
    }
    // 모든 bot bubble 은 TTFA latency 가 따로 도착하므로 row 를 큐에 등록 →
    // tts_ttfa 시 row 직후에 annotation 삽입.
    _registerTtfaPending(text, row);
    els.chat.scrollTop = els.chat.scrollHeight;
    // listening 이 미리 와서 armed 상태에서 봇 응답이 다시 온 경우, quiet
    // period 후 재시도하도록 timer 재예약.
    if (_listeningArmed && _sendQueue.length > 0) {
      _scheduleQuietDrain();
    }
  };

  const attachStt = (transcript, success, eosToFinalMs) => {
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
    // 메트릭 — 사용자가 보낸 원문 vs STT 인식 결과 + latency.
    if (_metrics) {
      const original = wrap.querySelector('.bubble.user .text')?.textContent || '';
      _metrics.sttResults.push({
        original,
        recognized: transcript,
        latencyMs: typeof eosToFinalMs === 'number' ? eosToFinalMs : null,
      });
    }
    const annot = document.createElement('div');
    annot.className = 'stt-annot';
    // latency: callbot 의 EOS→Final 측정값 (server VAD 의 SPEECH_END 또는 client
    // VAD flush 완료 → Google STT is_final 도착). Google STT 응답 시간 자체를
    // 직접 보여줌. SSE 에 eos_to_final_ms 가 없는 경우 (구버전 호환) 만 latency 미표시.
    const latencyTag = (typeof eosToFinalMs === 'number')
      ? ` (${eosToFinalMs}ms)`
      : '';
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
          attachStt(data.transcript, data.success, data.eos_to_final_ms);
          return;
        }
        // (2-1) TTS TTFA — 해당 봇 bubble 에 첫-chunk-도달 latency annotation 부착.
        if (data.type === 'tts_ttfa') {
          if (typeof data.ttfa_ms === 'number' && data.text) {
            attachTtfaLatency(data.text, data.ttfa_ms);
          }
          return;
        }
        // (3) 봇 응답 텍스트
        const text = data.text;
        if (!text) return;
        const key = text + '|' + (data.url || '');
        if (key === _lastBotKey) return;
        _lastBotKey = key;
        const url = data.url ? cfg.recvBase + data.url : null;
        addBotBubble(text, url, data.stt_to_bot_ms, data.kind);
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
    src.connect(micDest);             // RTP outbound (콜봇 측에서 들리는 음성)
    src.connect(audioCtx.destination); // 로컬 스피커 — 송신자도 함께 들음
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

  // 통화 lifecycle 에 따라 input/button enable/disable 일괄 토글.
  // single-line input/Send + 멀티 질의 행 input/+/적용 모두 한꺼번에.
  const _setSayDisabled = (disabled) => {
    els.textInput.disabled = disabled;
    els.sendBtn.disabled = disabled;
    if (els.addRowBtn)   els.addRowBtn.disabled   = disabled;
    if (els.applyAllBtn) els.applyAllBtn.disabled = disabled;
    if (els.multiRows) {
      els.multiRows.querySelectorAll('input').forEach(i => i.disabled = disabled);
      els.multiRows.querySelectorAll('.delete-row-btn').forEach(b => b.disabled = disabled);
    }
  };

  const onCallEnded = () => {
    activeSession = null;
    els.callBtn.disabled = false;
    els.hangupBtn.disabled = true;
    _setSayDisabled(true);
    setState('registered', `as ${cfg.sipUser}@${cfg.asteriskHost}`);
    renderMetricsPanel();
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
      _setSayDisabled(false);
      _activeWrap = null;
      _lastBotBubbleAt = 0;
      _botAudioBusyUntil = 0;
      _listeningArmed = false;
      if (_pendingDrainTimer) { clearTimeout(_pendingDrainTimer); _pendingDrainTimer = null; }
      // 새 통화 시작 — 이전 통화 메트릭/패널 클리어.
      _resetMetrics();
      if (els.metricsPanel) {
        els.metricsPanel.hidden = true;
        els.metricsPanel.innerHTML = '';
      }
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
    const now = Date.now();
    const elapsedSinceBot = _lastBotBubbleAt ? now - _lastBotBubbleAt : BOT_QUIET_MS;
    const quietWaitMs = Math.max(0, BOT_QUIET_MS - elapsedSinceBot);
    // 봇이 아직 말하는 중이면 그 끝까지 기다림 — 질의 TTS 가 봇 음성에 겹치지 않게.
    const audioWaitMs = Math.max(0, _botAudioBusyUntil - now);
    const waitMs = Math.max(quietWaitMs, audioWaitMs);
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
  // 한글/일본어 IME 조합 중 Enter: keydown 의 send() 가 입력값을 clear 한 직후
  // compositionend 가 마지막 글자를 다시 input 에 넣어 다음 turn 에 의도치 않게
  // 송신되는 버그가 있었다. isComposing 또는 keyCode 229 (IME) 를 제외.
  els.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) send();
  });

  // ── 멀티 질의 (행 기반) ──────────────────────────────────────────
  // 페이지 로드 시 DEFAULT_QUERIES 5개로 초기 행 채움. 사용자는 + 로 행 추가,
  // ✕ 로 행 제거, 적용 클릭 시 비어있지 않은 모든 행을 _sendQueue 에 push →
  // 기존 listening + bot audio busy 정렬로 한 줄씩 순차 송신.
  const _renumberRows = () => {
    if (!els.multiRows) return;
    Array.from(els.multiRows.children).forEach((row, idx) => {
      const num = row.querySelector('.row-num');
      if (num) num.textContent = `${idx + 1}.`;
    });
  };
  const _addRow = (value = '', focusIt = false) => {
    if (!els.multiRows) return null;
    const row = document.createElement('div');
    row.className = 'multi-row';
    const num = document.createElement('span');
    num.className = 'row-num';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.placeholder = '질의 입력';
    input.disabled = els.textInput.disabled;
    // Enter 키로 같은 행에서 즉시 적용하지 않고 다음 행으로 focus (편집 흐름).
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        const next = row.nextElementSibling?.querySelector('input');
        if (next) next.focus();
      }
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'delete-row-btn';
    del.textContent = '✕';
    del.title = '행 삭제';
    del.disabled = els.textInput.disabled;
    del.addEventListener('click', () => {
      row.remove();
      _renumberRows();
    });
    row.appendChild(num);
    row.appendChild(input);
    row.appendChild(del);
    els.multiRows.appendChild(row);
    _renumberRows();
    if (focusIt) input.focus();
    return input;
  };

  // 초기 행 — DEFAULT_QUERIES (samples.js).
  if (els.multiRows && Array.isArray(window.DEFAULT_QUERIES)) {
    window.DEFAULT_QUERIES.forEach(q => _addRow(q));
  }

  els.addRowBtn?.addEventListener('click', () => {
    if (els.addRowBtn.disabled) return;
    _addRow('', true);
  });

  els.applyAllBtn?.addEventListener('click', () => {
    if (els.applyAllBtn.disabled || !els.multiRows) return;
    const inputs = els.multiRows.querySelectorAll('input');
    const queries = Array.from(inputs).map(i => i.value.trim()).filter(Boolean);
    if (!queries.length) {
      if (els.multiHint) els.multiHint.textContent = '비어있지 않은 행이 없습니다';
      return;
    }
    for (const q of queries) {
      // send() 가 els.textInput 에서 값을 읽고 clear 하므로 줄마다 주입 후 호출.
      els.textInput.value = q;
      send();
    }
    if (els.multiHint) els.multiHint.textContent = `${queries.length}건 큐잉`;
    log(`Multi-apply: ${queries.length} queries queued`);
  });

  ua.start();
  log('UA started, target', wsUri);

  startEvents();
})();
