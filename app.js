(()=>{
  const $ = (id) => document.getElementById(id);
  const el = {
    status: $('status'), total: $('total'), minute: $('minute'), hour: $('hour'),
    hourNote: $('hourNote'), cycle: $('cycle'), runtime: $('runtime'), wakeText: $('wakeText'),
    currentDb: $('currentDb'), averageDb: $('averageDb'), peakDb: $('peakDb'), dbNote: $('dbNote'),
    levelText: $('levelText'), bar: $('bar'), mark: $('mark'), last: $('last'),
    secureWarning: $('secureWarning'), backgroundWarning: $('backgroundWarning'),
    mode: $('mode'), threshold: $('threshold'), thresholdValue: $('thresholdValue'),
    cooldown: $('cooldown'), cooldownValue: $('cooldownValue'), countMode: $('countMode'),
    pressSeconds: $('pressSeconds'), pressSecondsValue: $('pressSecondsValue'),
    dbCalibration: $('dbCalibration'), dbCalibrationValue: $('dbCalibrationValue'),
    keepAwake: $('keepAwake'), minus: $('minus'), plus: $('plus'), test: $('test'),
    export: $('export'), reset: $('reset'), start: $('start'), toast: $('toast')
  };

  const DATA_KEY = 'heatpress-mobile-v1';
  const SET_KEY = 'heatpress-mobile-settings-v2';

  let stream = null;
  let ctx = null;
  let analyser = null;
  let timeData = null;
  let freqData = null;
  let raf = 0;
  let listening = false;
  let above = false;
  let belowSince = 0;
  let lastTrigger = 0;
  let wakeLock = null;
  let partial = 0;
  let count = 0;
  let times = [];
  let activeMs = 0;
  let runStarted = 0;
  let toastTimer = 0;
  let currentDb = null;
  let smoothedDb = null;
  let dbPeak = null;
  let dbSum = 0;
  let dbSamples = 0;
  let lastDbSample = 0;

  // 0 等第1遍压下；1 等第1遍抬起；2 等第2遍压下；3 等第2遍抬起。
  let smartStage = 0;
  let smartStageAt = 0;

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SET_KEY) || '{}');
      if (s.mode) el.mode.value = s.mode;
      if (Number.isFinite(s.threshold)) el.threshold.value = s.threshold;
      if (Number.isFinite(s.cooldown)) el.cooldown.value = s.cooldown;
      el.countMode.value = s.countMode || 'smart2';
      if (Number.isFinite(s.pressSeconds)) el.pressSeconds.value = s.pressSeconds;
      if (Number.isFinite(s.dbCalibration)) el.dbCalibration.value = s.dbCalibration;
      if (typeof s.keepAwake === 'boolean') el.keepAwake.checked = s.keepAwake;
    } catch {}
    syncSettings();
  }

  function saveSettings() {
    localStorage.setItem(SET_KEY, JSON.stringify({
      mode: el.mode.value,
      threshold: +el.threshold.value,
      cooldown: +el.cooldown.value,
      countMode: el.countMode.value,
      pressSeconds: +el.pressSeconds.value,
      dbCalibration: +el.dbCalibration.value,
      keepAwake: el.keepAwake.checked
    }));
  }

  function syncSettings() {
    el.thresholdValue.textContent = el.threshold.value;
    el.cooldownValue.textContent = el.cooldown.value + ' ms';
    el.pressSecondsValue.textContent = el.pressSeconds.value + ' 秒';
    el.dbCalibrationValue.textContent = el.dbCalibration.value;
    el.mark.style.left = el.threshold.value + '%';
    saveSettings();
  }

  function saveData() {
    if (listening) {
      activeMs += Date.now() - runStarted;
      runStarted = Date.now();
    }
    localStorage.setItem(DATA_KEY, JSON.stringify({ count, times, activeMs, dbPeak, dbSum, dbSamples }));
  }

  function loadData() {
    try {
      const d = JSON.parse(localStorage.getItem(DATA_KEY) || '{}');
      count = Number(d.count) || 0;
      times = Array.isArray(d.times) ? d.times.filter(Number.isFinite) : [];
      activeMs = Number(d.activeMs) || 0;
      dbPeak = Number.isFinite(d.dbPeak) ? d.dbPeak : null;
      dbSum = Number(d.dbSum) || 0;
      dbSamples = Number(d.dbSamples) || 0;
    } catch {}
    updateUI();
  }

  function activeElapsed() {
    return activeMs + (listening ? Date.now() - runStarted : 0);
  }

  function fmt(ms) {
    let s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    s %= 60;
    return (h ? [h, m, s] : [m, s]).map(v => String(v).padStart(2, '0')).join(':');
  }

  function recentIntervals() {
    const a = times.slice(-11);
    const out = [];
    for (let i = 1; i < a.length; i++) {
      const d = a[i] - a[i - 1];
      if (d > 1000 && d < 180000) out.push(d);
    }
    return out;
  }

  function updateUI() {
    checkSmartTimeout();
    const now = Date.now();
    const minute = times.filter(t => now - t <= 60000).length;
    const ints = recentIntervals();
    el.total.textContent = count;
    el.minute.textContent = minute;
    el.runtime.textContent = fmt(activeElapsed());

    if (ints.length) {
      const avg = ints.reduce((a, b) => a + b, 0) / ints.length;
      el.hour.textContent = Math.round(3600000 / avg);
      el.cycle.textContent = (avg / 1000).toFixed(1);
      el.hourNote.textContent = '按最近 ' + ints.length + ' 个间隔估算';
    } else if (count && activeElapsed() > 10000) {
      const avg = activeElapsed() / count;
      el.hour.textContent = Math.round(3600000 / avg);
      el.cycle.textContent = (avg / 1000).toFixed(1);
      el.hourNote.textContent = '按本次整体平均估算';
    } else {
      el.hour.textContent = '--';
      el.cycle.textContent = '--';
      el.hourNote.textContent = '完成 2 件后估算';
    }

    if (!listening && currentDb == null) el.currentDb.innerHTML = '--<small>dB</small>';
    el.averageDb.textContent = dbSamples ? Math.round(dbSum / dbSamples) + ' dB' : '-- dB';
    el.peakDb.textContent = dbPeak == null ? '-- dB' : Math.round(dbPeak) + ' dB';
    updateWakeText();
  }

  function flash(text) {
    clearTimeout(toastTimer);
    el.toast.textContent = text;
    el.toast.classList.add('show');
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 900);
  }

  function addPiece(source = '声音') {
    const now = Date.now();
    count++;
    times.push(now);
    el.last.textContent = source + '计数 · ' + new Date(now).toLocaleTimeString('zh-CN', { hour12: false });
    navigator.vibrate?.(35);
    flash('＋1 件');
    saveData();
    updateUI();
  }

  function resetSmart(message = '') {
    smartStage = 0;
    smartStageAt = 0;
    if (message) el.last.textContent = message;
  }

  function smartTiming() {
    const target = +el.pressSeconds.value * 1000;
    return {
      target,
      minHold: Math.max(1800, target - 2500),
      maxHold: target + 4500,
      maxReposition: 30000
    };
  }

  function checkSmartTimeout() {
    if (el.countMode.value !== 'smart2' || smartStage === 0 || !smartStageAt) return;
    const elapsed = Date.now() - smartStageAt;
    const timing = smartTiming();
    const limit = smartStage === 2 ? timing.maxReposition : timing.maxHold + 4000;
    if (elapsed > limit) resetSmart('自动识别超时，已重新等待第1遍压下');
  }

  function registerSmartSound(source) {
    const now = Date.now();
    const timing = smartTiming();

    if (smartStage === 0) {
      smartStage = 1;
      smartStageAt = now;
      el.last.textContent = '第1遍已压下，等待约 ' + el.pressSeconds.value + ' 秒抬起';
      flash('第1遍压下');
      return;
    }

    const elapsed = now - smartStageAt;

    if (smartStage === 1) {
      if (elapsed < timing.minHold) {
        el.last.textContent = '忽略过早声音，仍等待第1遍抬起';
        return;
      }
      if (elapsed <= timing.maxHold) {
        smartStage = 2;
        smartStageAt = now;
        el.last.textContent = '第1遍完成，等待第2遍压下';
        flash('第1遍完成');
        return;
      }
      smartStage = 1;
      smartStageAt = now;
      el.last.textContent = '间隔过长，当前声音改为新的第1遍压下';
      return;
    }

    if (smartStage === 2) {
      if (elapsed < 300) return;
      if (elapsed <= timing.maxReposition) {
        smartStage = 3;
        smartStageAt = now;
        el.last.textContent = '第2遍已压下，等待约 ' + el.pressSeconds.value + ' 秒抬起';
        flash('第2遍压下');
        return;
      }
      smartStage = 1;
      smartStageAt = now;
      el.last.textContent = '换位超时，当前声音改为新的第1遍压下';
      return;
    }

    if (smartStage === 3) {
      if (elapsed < timing.minHold) {
        el.last.textContent = '忽略过早声音，仍等待第2遍抬起';
        return;
      }
      if (elapsed <= timing.maxHold) {
        resetSmart();
        addPiece(source + '两遍烫画');
        return;
      }
      smartStage = 1;
      smartStageAt = now;
      el.last.textContent = '第2遍间隔过长，当前声音改为新的第1遍压下';
    }
  }

  function registerSound(source = '声音') {
    if (el.countMode.value === 'smart2') {
      registerSmartSound(source);
      return;
    }
    partial++;
    const need = Number(el.countMode.value) || 1;
    if (partial >= need) {
      partial = 0;
      addPiece(source);
    } else {
      el.last.textContent = '已识别 ' + partial + ' / ' + need + ' 次声音';
      flash('已识别 ' + partial + ' / ' + need);
    }
  }

  function removePiece() {
    if (count <= 0) return;
    count--;
    times.pop();
    partial = 0;
    resetSmart();
    saveData();
    updateUI();
    flash('已减 1 件');
  }

  async function requestWake() {
    if (!listening || !el.keepAwake.checked || !('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', updateWakeText, { once: true });
    } catch {}
    updateWakeText();
  }

  async function releaseWake() {
    try { await wakeLock?.release(); } catch {}
    wakeLock = null;
    updateWakeText();
  }

  function updateWakeText() {
    if (!('wakeLock' in navigator)) el.wakeText.textContent = '此浏览器不支持常亮';
    else if (wakeLock && !wakeLock.released) el.wakeText.textContent = '屏幕常亮已开启';
    else el.wakeText.textContent = '屏幕常亮未启动';
  }

  async function start() {
    if (listening) {
      stop();
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      el.secureWarning.classList.add('show');
      alert('请通过 HTTPS 的 GitHub Pages 地址打开。');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        video: false
      });
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = .62;
      src.connect(analyser);
      timeData = new Float32Array(analyser.fftSize);
      freqData = new Uint8Array(analyser.frequencyBinCount);
      const settings = stream.getAudioTracks()[0]?.getSettings?.() || {};
      el.dbNote.textContent = settings.autoGainControl === true
        ? '手机自动增益未能关闭，分贝误差会更大；计数仍可通过阈值调节。'
        : '手机麦克风估算值；校准后更接近真实分贝，但不能替代专业声级计。';
      listening = true;
      runStarted = Date.now();
      above = false;
      belowSince = 0;
      lastDbSample = 0;
      partial = 0;
      resetSmart();
      el.status.textContent = '● 正在监听';
      el.status.classList.add('on');
      el.start.textContent = '停止监听';
      el.start.classList.add('stop');
      el.last.textContent = el.countMode.value === 'smart2' ? '等待第1遍压下声音' : '正在等待烫画机声音';
      await requestWake();
      loop();
    } catch (e) {
      alert(e.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在浏览器设置中允许。' : '无法启动麦克风：' + e.message);
    }
  }

  function stop() {
    if (!listening) return;
    activeMs += Date.now() - runStarted;
    listening = false;
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
    ctx?.close().catch(() => {});
    ctx = null;
    analyser = null;
    timeData = null;
    freqData = null;
    currentDb = null;
    smoothedDb = null;
    partial = 0;
    resetSmart();
    releaseWake();
    el.status.textContent = '● 已停止';
    el.status.classList.remove('on');
    el.start.textContent = '开始监听';
    el.start.classList.remove('stop');
    el.bar.style.width = '0%';
    el.levelText.textContent = '0 / 100';
    el.last.textContent = '监听已停止';
    saveData();
    updateUI();
  }

  function readRms() {
    if (!analyser || !timeData) return 0;
    if (typeof analyser.getFloatTimeDomainData === 'function') {
      analyser.getFloatTimeDomainData(timeData);
    } else {
      const b = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(b);
      for (let i = 0; i < b.length; i++) timeData[i] = (b[i] - 128) / 128;
    }
    let sum = 0;
    for (const v of timeData) sum += v * v;
    return Math.sqrt(sum / timeData.length);
  }

  function updateDb(rms, now) {
    const dbfs = 20 * Math.log10(Math.max(rms, .00001));
    const estimated = Math.max(0, Math.min(140, dbfs + (+el.dbCalibration.value)));
    smoothedDb = smoothedDb == null ? estimated : smoothedDb * .88 + estimated * .12;
    currentDb = smoothedDb;
    el.currentDb.innerHTML = Math.round(currentDb) + '<small>dB</small>';
    if (now - lastDbSample >= 250 && estimated > 15) {
      lastDbSample = now;
      dbSum += estimated;
      dbSamples++;
      dbPeak = dbPeak == null ? estimated : Math.max(dbPeak, estimated);
      el.averageDb.textContent = Math.round(dbSum / dbSamples) + ' dB';
      el.peakDb.textContent = Math.round(dbPeak) + ' dB';
    }
  }

  function getLevel(rms) {
    const general = Math.min(100, rms * 345);
    if (el.mode.value === 'general') return general;
    analyser.getByteFrequencyData(freqData);
    const nyq = ctx.sampleRate / 2;
    const from = Math.floor(1400 / nyq * freqData.length);
    const to = Math.min(freqData.length - 1, Math.floor(5200 / nyq * freqData.length));
    let high = 0;
    for (let i = from; i <= to; i++) high += freqData[i];
    high = high / Math.max(1, to - from + 1) / 2.55;
    return Math.min(100, Math.max(high, general * .45));
  }

  function loop() {
    if (!listening) return;
    const now = performance.now();
    const rms = readRms();
    updateDb(rms, now);
    const level = getLevel(rms);
    const threshold = +el.threshold.value;
    const signal = level >= threshold;
    el.bar.style.width = level.toFixed(1) + '%';
    el.levelText.textContent = Math.round(level) + ' / 100';

    if (signal) {
      belowSince = 0;
      if (!above && now - lastTrigger >= +el.cooldown.value) {
        above = true;
        lastTrigger = now;
        registerSound('声音');
      }
    } else if (above) {
      if (!belowSince) belowSince = now;
      if (now - belowSince > 140) above = false;
    }
    raf = requestAnimationFrame(loop);
  }

  function exportCsv() {
    if (!times.length) {
      alert('还没有完成记录。');
      return;
    }
    const rows = [['序号', '完成时间', '与上一件间隔(秒)']];
    times.forEach((t, i) => rows.push([
      i + 1,
      new Date(t).toLocaleString('zh-CN', { hour12: false }),
      i ? ((t - times[i - 1]) / 1000).toFixed(1) : ''
    ]));
    const csv = '\ufeff' + rows.map(r => r.map(v => '"' + String(v).replaceAll('"', '""') + '"').join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = '烫画机计数_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  el.start.addEventListener('click', start);
  el.plus.addEventListener('click', () => addPiece('手动'));
  el.minus.addEventListener('click', removePiece);
  el.test.addEventListener('click', () => registerSound('模拟'));
  el.export.addEventListener('click', exportCsv);
  el.reset.addEventListener('click', () => {
    if (confirm('确定清空累计件数、分贝和全部记录吗？')) {
      count = 0;
      times = [];
      partial = 0;
      resetSmart();
      activeMs = 0;
      dbPeak = null;
      dbSum = 0;
      dbSamples = 0;
      currentDb = null;
      smoothedDb = null;
      if (listening) runStarted = Date.now();
      saveData();
      updateUI();
      el.last.textContent = '数据已清空';
    }
  });

  [el.threshold, el.cooldown, el.pressSeconds, el.dbCalibration].forEach(x => x.addEventListener('input', syncSettings));
  [el.mode, el.countMode, el.keepAwake].forEach(x => x.addEventListener('change', async () => {
    partial = 0;
    resetSmart(el.countMode.value === 'smart2' ? '已切换：等待第1遍压下声音' : '计数方式已切换');
    saveSettings();
    if (x === el.keepAwake) {
      if (x.checked) await requestWake();
      else await releaseWake();
    }
  }));

  document.addEventListener('visibilitychange', async () => {
    if (document.hidden && listening) el.backgroundWarning.classList.add('show');
    if (!document.hidden && listening) {
      await ctx?.resume().catch(() => {});
      await requestWake();
      flash('已回到前台，请检查计数');
    }
  });

  window.addEventListener('pagehide', saveData);
  if (!window.isSecureContext) el.secureWarning.classList.add('show');
  loadSettings();
  loadData();
  updateUI();
  setInterval(updateUI, 1000);
})();