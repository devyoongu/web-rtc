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
    // 음원 볼륨 조절.
    volumeSlider: document.getElementById('volumeSlider'),
    muteBtn:      document.getElementById('muteBtn'),
    volumeValue:  document.getElementById('volumeValue'),
    // 끼어들기(barge-in) 테스트 패널.
    bargeText:       document.getElementById('bargeText'),
    bargeInjectBtn:  document.getElementById('bargeInjectBtn'),
    bargeDelay:      document.getElementById('bargeDelay'),
    bargeDelayValue: document.getElementById('bargeDelayValue'),
    bargeAutoBtn:    document.getElementById('bargeAutoBtn'),
    realMicToggle:   document.getElementById('realMicToggle'),
    bargeHint:       document.getElementById('bargeHint'),
  };

  // ── 음원 볼륨 조절 ─────────────────────────────────────────────
  // 로컬 재생 3경로 — ① 콜봇 실시간 음성(remoteAudio) ② 송신 WAV 자동재생
  // (AudioContext→스피커) ③ ▶ 버블 재생(<audio>) — 을 한 슬라이더로 제어.
  // SIP 아웃바운드(micDest→콜봇이 듣는 소리)는 건드리지 않는다: AudioContext
  // 로컬 경로는 outGain(GainNode)으로, <audio> 요소는 .volume 으로 반영.
  let _volume = 1.0;      // 0.0 ~ 1.0
  let _muted = false;
  let _lastVolume = 1.0;  // 뮤트/0 해제 시 복원할 값
  let outGain = null;     // ensureAudioPipeline 에서 생성
  const _bubbleAudios = new Set();  // ▶ 재생용 <audio> 요소들

  const _effectiveVolume = () => (_muted ? 0 : _volume);

  const applyVolume = () => {
    const v = _effectiveVolume();
    if (els.remoteAudio) els.remoteAudio.volume = v;
    if (outGain) outGain.gain.value = v;
    _bubbleAudios.forEach((a) => { a.volume = v; });
    if (els.volumeValue) els.volumeValue.textContent = `${Math.round(_volume * 100)}%`;
    if (els.muteBtn) els.muteBtn.textContent = (_muted || _volume === 0) ? '🔇' : '🔊';
    if (els.volumeSlider) els.volumeSlider.value = String(Math.round(_volume * 100));
  };

  const setVolume = (v) => {
    _volume = Math.min(1, Math.max(0, v));
    if (_volume > 0) { _muted = false; _lastVolume = _volume; }
    try { localStorage.setItem('callbot_volume', String(_volume)); } catch (_) { /* ignore */ }
    applyVolume();
  };

  // 저장된 볼륨 복원 후 UI/오디오에 반영.
  try {
    const saved = parseFloat(localStorage.getItem('callbot_volume'));
    if (!Number.isNaN(saved)) { _volume = Math.min(1, Math.max(0, saved)); _lastVolume = _volume || 1.0; }
  } catch (_) { /* ignore */ }
  applyVolume();

  els.volumeSlider?.addEventListener('input', (e) => {
    setVolume(parseInt(e.target.value, 10) / 100);
  });
  els.muteBtn?.addEventListener('click', () => {
    if (_muted || _volume === 0) {
      _muted = false;
      if (_volume === 0) _volume = _lastVolume || 1.0;
    } else {
      _muted = true;
    }
    applyVolume();
  });

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
      audio.volume = _effectiveVolume();     // 현재 볼륨 반영 (슬라이더/뮤트)
      _bubbleAudios.add(audio);              // 이후 볼륨 변경 시 일괄 적용 대상
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

  // 끼어들기(barge-in) 이벤트를 타임라인 가운데 배지로 표시.
  const renderBargeNote = (data) => {
    const stage = data.stage;
    let txt;
    if (stage === 'ducked')        txt = `🔉 덕킹${data.detail ? ` (${data.detail})` : ''}`;
    else if (stage === 'unducked') txt = `🔊 덕킹 해제${data.detail ? ` (${data.detail})` : ''}`;
    else if (stage === 'confirm')  txt = `⚡ 끼어들기 확정: "${data.text}"`;
    else if (stage === 'stop')     txt = `⛔ TTS 중단${typeof data.stop_ms === 'number' ? ` (${data.stop_ms}ms)` : ''}`;
    else if (stage === 'handoff')  txt = `↪ 다음 턴 인계: ${data.text}`;
    else                           txt = `barge: ${stage}`;
    const note = document.createElement('div');
    note.className = `system-note barge ${stage}`;
    note.textContent = txt;
    els.chat.appendChild(note);
    els.chat.scrollTop = els.chat.scrollHeight;
    log(`barge-in: ${txt}`);
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

  // STT 결과 ↔ 보낸 user TTS 매칭. multi-query 자동화에서 한 query 의 STT 가
  // deadline 으로 non_voice 처리 후 callbot 이 fallback ("잘 들리지 않습니다") 후
  // 새 listening 을 emit → web-rtc 가 다음 query 보내기 → wrap 큐가 어긋남.
  //
  // 1) transcript 가 non_voice / error / 빈문자열 이면 wrap 을 *소비하지 않고*
  //    null 반환 → 같은 wrap 이 다음 정상 STT 결과를 받도록 함.
  // 2) 정상 transcript 면 pending wrap 들 중 원문 (1−CER) 유사도가 가장 높은
  //    wrap 을 splice 로 채택. 모두 score < 0.3 이면 FIFO 폴백 (안전망).
  const _pickBestMatch = (transcript) => {
    if (!_pendingUserBubbles.length) return null;
    if (!transcript || transcript === 'non_voice' || transcript === 'error') {
      return null;
    }
    let bestIdx = 0;
    let bestScore = -1;
    _pendingUserBubbles.forEach((w, i) => {
      const expected = w.querySelector('.bubble.user .text')?.textContent || '';
      const score = expected ? 1 - _cer(expected, transcript) : 0;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    });
    if (bestScore < 0.3) {
      return _pendingUserBubbles.shift();
    }
    return _pendingUserBubbles.splice(bestIdx, 1)[0];
  };

  const attachStt = (transcript, success, eosToFinalMs) => {
    // 1 listening = 1 audio send = 1 STT result 1:1 매칭. fail/non_voice/error
    // 도 wrap 을 consume — callbot 은 fail turn 에 fallback 멘트 송출 후 새
    // listening 을 emit 하고 브라우저는 그때마다 새 audio 를 큐에서 빼서 send 함.
    // 큐가 비어 있으면 callbot listening timeout 같은 후행 결과로 보고 무시.
    const wrap = _pickBestMatch(transcript);
    if (!wrap) return;
    _activeWrap = wrap;
    const original = wrap.querySelector('.bubble.user .text')?.textContent || '';
    const ok = success && transcript && transcript !== 'non_voice' && transcript !== 'error';
    const recognized = ok ? transcript : '';
    const accuracy = original ? 1 - _cer(original, recognized) : null;
    if (_metrics) {
      _metrics.sttResults.push({
        original,
        recognized,
        latencyMs: typeof eosToFinalMs === 'number' ? eosToFinalMs : null,
      });
    }
    const annot = document.createElement('div');
    annot.className = 'stt-annot' + (ok ? '' : ' stt-fail');
    // (latency · 인식률) — latency 는 callbot 의 EOS→Final (server VAD SPEECH_END
    // 또는 client VAD flush → Google STT is_final). 인식률은 사용자 원문 vs 인식
    // transcript 의 1−CER (음절 단위). fail/non_voice 는 0% 로 표시.
    const tags = [];
    if (typeof eosToFinalMs === 'number') tags.push(`${eosToFinalMs}ms`);
    if (accuracy != null) tags.push(`${(accuracy * 100).toFixed(1)}%`);
    const tagStr = tags.length ? ` (${tags.join(' · ')})` : '';
    const display = ok ? transcript : `인식 실패 (${transcript || 'fail'})`;
    annot.textContent = `🎙${tagStr} ${display}`;
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
        // (2-2) 끼어들기(barge-in) 이벤트 — 타임라인에 배지.
        if (data.type === 'barge') {
          renderBargeNote(data);
          return;
        }
        // (2-1) TTS TTFA — 해당 봇 bubble 에 첫-chunk-도달 latency annotation 부착.
        if (data.type === 'tts_ttfa') {
          if (typeof data.ttfa_ms === 'number' && data.text) {
            attachTtfaLatency(data.text, data.ttfa_ms);
          }
          // 봇 발화 시작 신호 — 끼어들기 자동 주입(지연 슬라이더)의 트리거.
          window.dispatchEvent(new CustomEvent('callbot:botspeech'));
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
      // 로컬 스피커 출력용 볼륨 게인 — 슬라이더로 제어. micDest(SIP 아웃바운드)
      // 에는 연결하지 않으므로 볼륨 조절이 콜봇이 듣는 소리에는 영향 없음.
      outGain = audioCtx.createGain();
      outGain.gain.value = _effectiveVolume();
      outGain.connect(audioCtx.destination);
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
    src.connect(micDest);             // RTP outbound (콜봇 측에서 들리는 음성) — 볼륨 무관
    src.connect(outGain);             // 로컬 스피커 — 송신자도 함께 들음 (볼륨 슬라이더 적용)
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
    // 끼어들기 주입 컨트롤도 통화 중에만 활성. 단 실마이크 토글은 통화 전에
    // 골라야 하므로 반대로 — 통화 중엔 잠근다(아래 callBtn/onCallEnded).
    if (els.bargeText)      els.bargeText.disabled      = disabled;
    if (els.bargeInjectBtn) els.bargeInjectBtn.disabled = disabled;
    if (els.bargeAutoBtn)   els.bargeAutoBtn.disabled   = disabled;
  };

  const onCallEnded = () => {
    activeSession = null;
    _bargeAutoArmed = false;
    els.callBtn.disabled = false;
    els.hangupBtn.disabled = true;
    _setSayDisabled(true);
    if (els.realMicToggle) els.realMicToggle.disabled = false;  // 다음 통화 전 모드 선택 가능
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

    // 아웃바운드 스트림 선택:
    //  - 기본(합성): micDest.stream — 타이핑→TTS 주입 경로. 봇 목소리가 되돌지
    //    않아 끼어들기 기능 검증에 적합(self-barge 재현 불가).
    //  - 실마이크 모드: getUserMedia 실제 마이크 — self-barge(에코) 실측용.
    //    스피커 ON 상태에서 봇 음성이 마이크로 유입되는지 본다.
    let outboundStream = micDest.stream;
    if (els.realMicToggle?.checked) {
      try {
        outboundStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        log('🎤 실마이크 모드: getUserMedia 트랙 사용 (self-barge 실측). 합성 주입은 콜봇에 전달되지 않음.');
        if (els.bargeHint) els.bargeHint.textContent = '실마이크 모드 — 주입 대신 스피커 에코로 self-barge 관찰';
      } catch (e) {
        log('getUserMedia 실패 — 합성 마이크로 폴백', e.message);
      }
    }

    activeSession = ua.call(target, {
      mediaStream: outboundStream,                         // ★ 송신 오디오 소스
      mediaConstraints: { audio: false, video: false },
      pcConfig: { iceServers: cfg.iceServers },
    });

    els.callBtn.disabled = true;
    els.hangupBtn.disabled = false;
    if (els.realMicToggle) els.realMicToggle.disabled = true;  // 통화 중 모드 변경 금지

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

  // ── 끼어들기(barge-in) 테스트 주입 ───────────────────────────────
  // 기능 검증용. send()/멀티질의와 달리 _sendQueue·quiet 스케줄러를 거치지
  // 않고 playPrefetched() 를 직접 호출해 봇 발화 중에도 즉시 주입한다.
  // (합성 micDest 경로 전용 — 실마이크 모드에선 콜봇에 전달되지 않는다.)
  let _bargeAutoArmed = false;

  const _bargeDelayMs = () => {
    const v = parseInt(els.bargeDelay?.value ?? '1000', 10);
    return Number.isNaN(v) ? 1000 : v;
  };

  const injectBargeIn = async (text) => {
    if (!activeSession) { log('끼어들기 주입: 통화 중이 아님'); return; }
    const t = (text || '').trim();
    if (!t) { log('끼어들기 주입: 발화가 비어있음'); return; }
    if (els.realMicToggle?.checked) {
      log('⚠ 끼어들기 주입 무시: 실마이크 모드 — 합성 주입은 콜봇에 전달되지 않음');
      return;
    }
    log(`⚡ 끼어들기 주입: ${t}`);
    const data = await getOrPrefetchTTS(t);
    if (!data) { log('끼어들기 주입: prefetch 실패'); return; }
    await playPrefetched(data);   // 스케줄러 우회 — 즉시 src.start()
  };

  els.bargeDelay?.addEventListener('input', () => {
    if (els.bargeDelayValue) els.bargeDelayValue.textContent = `${(_bargeDelayMs() / 1000).toFixed(1)}s`;
  });

  els.bargeInjectBtn?.addEventListener('click', () => {
    if (els.bargeInjectBtn.disabled) return;
    injectBargeIn(els.bargeText?.value);
  });
  els.bargeText?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) injectBargeIn(els.bargeText.value);
  });

  // 자동 주입: 무장 후 다음 봇 발화 시작(callbot:botspeech) + 슬라이더 지연에
  // 1회 주입하고 해제. 타이밍 재현성을 위해 수동 클릭 대신 사용.
  els.bargeAutoBtn?.addEventListener('click', () => {
    if (els.bargeAutoBtn.disabled) return;
    _bargeAutoArmed = true;
    log(`끼어들기 자동 주입 무장 — 다음 봇 발화 ${(_bargeDelayMs() / 1000).toFixed(1)}s 후 1회`);
    if (els.bargeHint) els.bargeHint.textContent = '무장됨 — 다음 봇 발화 대기';
  });
  window.addEventListener('callbot:botspeech', () => {
    if (!_bargeAutoArmed) return;
    _bargeAutoArmed = false;
    const d = _bargeDelayMs();
    log(`봇 발화 감지 → ${d}ms 후 주입`);
    if (els.bargeHint) els.bargeHint.textContent = '';
    setTimeout(() => injectBargeIn(els.bargeText?.value), d);
  });

  // 통화 중 실마이크 토글 변경 경고(적용은 다음 통화부터).
  els.realMicToggle?.addEventListener('change', () => {
    if (activeSession) log('⚠ 실마이크 모드는 다음 통화부터 적용됩니다 (현재 통화는 그대로).');
  });

  ua.start();
  log('UA started, target', wsUri);

  startEvents();
})();
