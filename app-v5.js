(()=>{
  const $ = id => document.getElementById(id);
  const el = {
    status:$('status'), total:$('total'), minute:$('minute'), hour:$('hour'), hourNote:$('hourNote'),
    cycle:$('cycle'), runtime:$('runtime'), wakeText:$('wakeText'), currentDb:$('currentDb'),
    averageDb:$('averageDb'), peakDb:$('peakDb'), dbNote:$('dbNote'), levelText:$('levelText'),
    bar:$('bar'), mark:$('mark'), last:$('last'), secureWarning:$('secureWarning'),
    backgroundWarning:$('backgroundWarning'), mode:$('mode'), threshold:$('threshold'),
    thresholdValue:$('thresholdValue'), cooldown:$('cooldown'), cooldownValue:$('cooldownValue'),
    countMode:$('countMode'), pressSeconds:$('pressSeconds'), pressSecondsValue:$('pressSecondsValue'),
    dbCalibration:$('dbCalibration'), dbCalibrationValue:$('dbCalibrationValue'), keepAwake:$('keepAwake'),
    minus:$('minus'), plus:$('plus'), test:$('test'), export:$('export'), reset:$('reset'),
    start:$('start'), toast:$('toast'), recordTemplate:$('recordTemplate'), clearTemplate:$('clearTemplate'),
    templateStatus:$('templateStatus'), templateMeta:$('templateMeta'), matchScore:$('matchScore'),
    strictness:$('strictness'), strictnessValue:$('strictnessValue')
  };

  const DATA_KEY = 'heatpress-mobile-v1';
  const SET_KEY = 'heatpress-mobile-settings-v3';
  const OLD_SET_KEY = 'heatpress-mobile-settings-v2';
  const TEMPLATE_KEY = 'heatpress-sound-template-v1';

  let stream=null, ctx=null, analyser=null, timeData=null, freqData=null, raf=0;
  let listening=false, wakeLock=null, partial=0, count=0, times=[], activeMs=0, runStarted=0;
  let toastTimer=0, currentDb=null, smoothedDb=null, dbPeak=null, dbSum=0, dbSamples=0, lastDbSample=0;
  let soundTemplate=null, training=false, eventCapture=null, belowSince=0, noiseFloor=3;
  let lastCandidateAt=0, lastAcceptedAt=0, recentMatch=null;

  // 0 等第1遍压下；1 等第1遍抬起；2 等第2遍压下；3 等第2遍抬起。
  let smartStage=0, smartStageAt=0;

  function safeJson(key){
    try{return JSON.parse(localStorage.getItem(key)||'{}')}catch{return {}}
  }

  function loadSettings(){
    const s = Object.keys(safeJson(SET_KEY)).length ? safeJson(SET_KEY) : safeJson(OLD_SET_KEY);
    if(s.mode)el.mode.value=s.mode;
    if(Number.isFinite(s.threshold))el.threshold.value=s.threshold;
    if(Number.isFinite(s.cooldown))el.cooldown.value=s.cooldown;
    el.countMode.value=s.countMode||'smart2';
    if(Number.isFinite(s.pressSeconds))el.pressSeconds.value=s.pressSeconds;
    if(Number.isFinite(s.dbCalibration))el.dbCalibration.value=s.dbCalibration;
    if(Number.isFinite(s.strictness)&&el.strictness)el.strictness.value=s.strictness;
    if(typeof s.keepAwake==='boolean')el.keepAwake.checked=s.keepAwake;
    syncSettings();
  }

  function saveSettings(){
    localStorage.setItem(SET_KEY,JSON.stringify({
      mode:el.mode.value, threshold:+el.threshold.value, cooldown:+el.cooldown.value,
      countMode:el.countMode.value, pressSeconds:+el.pressSeconds.value,
      dbCalibration:+el.dbCalibration.value, strictness:+el.strictness.value,
      keepAwake:el.keepAwake.checked
    }));
  }

  function syncSettings(){
    el.thresholdValue.textContent=el.threshold.value;
    el.cooldownValue.textContent=el.cooldown.value+' ms';
    el.pressSecondsValue.textContent=el.pressSeconds.value+' 秒';
    el.dbCalibrationValue.textContent=el.dbCalibration.value;
    el.strictnessValue.textContent=el.strictness.value+'%';
    el.mark.style.left=el.threshold.value+'%';
    saveSettings();
  }

  function loadTemplate(){
    try{
      const t=JSON.parse(localStorage.getItem(TEMPLATE_KEY)||'null');
      if(t&&t.version===1&&Array.isArray(t.spectrum)&&t.spectrum.length===18)soundTemplate=t;
    }catch{}
    renderTemplate();
  }

  function saveTemplate(){
    if(soundTemplate)localStorage.setItem(TEMPLATE_KEY,JSON.stringify(soundTemplate));
    else localStorage.removeItem(TEMPLATE_KEY);
    renderTemplate();
  }

  function renderTemplate(){
    if(!el.templateStatus)return;
    if(training){
      el.templateStatus.textContent='正在等待目标声音…现在操作一次烫画机';
      el.templateStatus.className='template-status recording';
      el.recordTemplate.textContent='取消录制';
      return;
    }
    el.recordTemplate.textContent='录制目标声音';
    if(!soundTemplate){
      el.templateStatus.textContent='尚未录制，自动声音不会计数';
      el.templateStatus.className='template-status';
      el.templateMeta.textContent='录制一次压下或抬起的机器声音，之后只接受相似声音。';
      return;
    }
    const d=new Date(soundTemplate.recordedAt);
    el.templateStatus.textContent='声音模板已启用';
    el.templateStatus.className='template-status ready';
    const gap=soundTemplate.learnedIntervalMs?` · 已学习间隔 ${(soundTemplate.learnedIntervalMs/1000).toFixed(1)}秒`:' · 间隔将在使用中自动学习';
    el.templateMeta.textContent=`时长 ${Math.round(soundTemplate.duration)}ms · 主频 ${Math.round(soundTemplate.centroid)}Hz${gap} · ${d.toLocaleDateString('zh-CN')}`;
  }

  function saveData(){
    if(listening){activeMs+=Date.now()-runStarted;runStarted=Date.now()}
    localStorage.setItem(DATA_KEY,JSON.stringify({count,times,activeMs,dbPeak,dbSum,dbSamples}));
  }

  function loadData(){
    const d=safeJson(DATA_KEY);
    count=Number(d.count)||0;
    times=Array.isArray(d.times)?d.times.filter(Number.isFinite):[];
    activeMs=Number(d.activeMs)||0;
    dbPeak=Number.isFinite(d.dbPeak)?d.dbPeak:null;
    dbSum=Number(d.dbSum)||0;
    dbSamples=Number(d.dbSamples)||0;
    updateUI();
  }

  function activeElapsed(){return activeMs+(listening?Date.now()-runStarted:0)}
  function fmt(ms){
    let s=Math.floor(ms/1000);const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);s%=60;
    return (h?[h,m,s]:[m,s]).map(v=>String(v).padStart(2,'0')).join(':');
  }
  function recentIntervals(){
    const a=times.slice(-11),out=[];
    for(let i=1;i<a.length;i++){const d=a[i]-a[i-1];if(d>1000&&d<180000)out.push(d)}
    return out;
  }

  function updateUI(){
    checkSmartTimeout();
    const now=Date.now(),minute=times.filter(t=>now-t<=60000).length,ints=recentIntervals();
    el.total.textContent=count;el.minute.textContent=minute;el.runtime.textContent=fmt(activeElapsed());
    if(ints.length){
      const avg=ints.reduce((a,b)=>a+b,0)/ints.length;
      el.hour.textContent=Math.round(3600000/avg);el.cycle.textContent=(avg/1000).toFixed(1);
      el.hourNote.textContent='按最近 '+ints.length+' 个间隔估算';
    }else if(count&&activeElapsed()>10000){
      const avg=activeElapsed()/count;
      el.hour.textContent=Math.round(3600000/avg);el.cycle.textContent=(avg/1000).toFixed(1);
      el.hourNote.textContent='按本次整体平均估算';
    }else{el.hour.textContent='--';el.cycle.textContent='--';el.hourNote.textContent='完成 2 件后估算'}
    if(!listening&&currentDb==null)el.currentDb.innerHTML='--<small>dB</small>';
    el.averageDb.textContent=dbSamples?Math.round(dbSum/dbSamples)+' dB':'-- dB';
    el.peakDb.textContent=dbPeak==null?'-- dB':Math.round(dbPeak)+' dB';
    updateWakeText();
  }

  function flash(text){clearTimeout(toastTimer);el.toast.textContent=text;el.toast.classList.add('show');toastTimer=setTimeout(()=>el.toast.classList.remove('show'),900)}
  function addPiece(source='声音'){
    const now=Date.now();count++;times.push(now);el.last.textContent=source+'计数 · '+new Date(now).toLocaleTimeString('zh-CN',{hour12:false});
    navigator.vibrate?.(35);flash('＋1 件');saveData();updateUI();
  }
  function removePiece(){
    if(count<=0)return;count--;times.pop();partial=0;resetSmart();saveData();updateUI();flash('已减 1 件');
  }

  function resetSmart(message=''){smartStage=0;smartStageAt=0;if(message)el.last.textContent=message}
  function smartTiming(){
    const target=+el.pressSeconds.value*1000;
    return{target,minHold:Math.max(1800,target-2500),maxHold:target+4500,maxReposition:30000};
  }
  function checkSmartTimeout(){
    if(el.countMode.value!=='smart2'||smartStage===0||!smartStageAt)return;
    const elapsed=Date.now()-smartStageAt,t=smartTiming(),limit=smartStage===2?t.maxReposition:t.maxHold+4000;
    if(elapsed>limit)resetSmart('自动识别超时，已重新等待第1遍压下');
  }
  function registerSmartSound(source){
    const now=Date.now(),t=smartTiming();
    if(smartStage===0){smartStage=1;smartStageAt=now;el.last.textContent='第1遍已压下，等待约 '+el.pressSeconds.value+' 秒抬起';flash('第1遍压下');return}
    const elapsed=now-smartStageAt;
    if(smartStage===1){
      if(elapsed<t.minHold){el.last.textContent='声音匹配，但间隔过早；继续等待第1遍抬起';return}
      if(elapsed<=t.maxHold){smartStage=2;smartStageAt=now;el.last.textContent='第1遍完成，等待第2遍压下';flash('第1遍完成');return}
      smartStage=1;smartStageAt=now;el.last.textContent='间隔过长，当前匹配声改为新的第1遍压下';return;
    }
    if(smartStage===2){
      if(elapsed<300)return;
      if(elapsed<=t.maxReposition){smartStage=3;smartStageAt=now;el.last.textContent='第2遍已压下，等待约 '+el.pressSeconds.value+' 秒抬起';flash('第2遍压下');return}
      smartStage=1;smartStageAt=now;el.last.textContent='换位超时，当前匹配声改为新的第1遍压下';return;
    }
    if(smartStage===3){
      if(elapsed<t.minHold){el.last.textContent='声音匹配，但间隔过早；继续等待第2遍抬起';return}
      if(elapsed<=t.maxHold){resetSmart();addPiece(source+'两遍烫画');return}
      smartStage=1;smartStageAt=now;el.last.textContent='第2遍间隔过长，当前匹配声改为新的第1遍压下';
    }
  }
  function registerSound(source='声音'){
    if(el.countMode.value==='smart2'){registerSmartSound(source);return}
    partial++;const need=Number(el.countMode.value)||1;
    if(partial>=need){partial=0;addPiece(source)}else{el.last.textContent='已识别 '+partial+' / '+need+' 次目标声音';flash('已识别 '+partial+' / '+need)}
  }

  async function requestWake(){
    if(!listening||!el.keepAwake.checked||!('wakeLock'in navigator))return;
    try{wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',updateWakeText,{once:true})}catch{}
    updateWakeText();
  }
  async function releaseWake(){try{await wakeLock?.release()}catch{}wakeLock=null;updateWakeText()}
  function updateWakeText(){
    if(!('wakeLock'in navigator))el.wakeText.textContent='此浏览器不支持常亮';
    else if(wakeLock&&!wakeLock.released)el.wakeText.textContent='屏幕常亮已开启';
    else el.wakeText.textContent='屏幕常亮未启动';
  }

  async function ensureAudio(){
    if(listening)return true;
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){el.secureWarning.classList.add('show');alert('请通过 HTTPS 的 GitHub Pages 地址打开。');return false}
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1},video:false});
      ctx=new(window.AudioContext||window.webkitAudioContext)();await ctx.resume();
      const src=ctx.createMediaStreamSource(stream);analyser=ctx.createAnalyser();analyser.fftSize=2048;analyser.smoothingTimeConstant=.28;src.connect(analyser);
      timeData=new Float32Array(analyser.fftSize);freqData=new Uint8Array(analyser.frequencyBinCount);
      const settings=stream.getAudioTracks()[0]?.getSettings?.()||{};
      el.dbNote.textContent=settings.autoGainControl===true?'手机自动增益未能关闭，匹配会自动容忍音量变化。':'手机麦克风估算值；声音模板主要比较频谱、音量和持续时间。';
      listening=true;runStarted=Date.now();lastDbSample=0;partial=0;resetSmart();eventCapture=null;belowSince=0;noiseFloor=3;
      el.status.textContent='● 正在监听';el.status.classList.add('on');el.start.textContent='停止监听';el.start.classList.add('stop');
      el.last.textContent=soundTemplate?'正在等待与模板相似的烫画机声音':'请先录制目标声音模板';
      await requestWake();loop();return true;
    }catch(e){alert(e.name==='NotAllowedError'?'麦克风权限被拒绝，请在浏览器设置中允许。':'无法启动麦克风：'+e.message);return false}
  }

  async function start(){if(listening){stop();return}await ensureAudio()}
  function stop(){
    if(!listening)return;activeMs+=Date.now()-runStarted;listening=false;cancelAnimationFrame(raf);
    stream?.getTracks().forEach(t=>t.stop());stream=null;ctx?.close().catch(()=>{});ctx=null;analyser=null;timeData=null;freqData=null;
    currentDb=null;smoothedDb=null;partial=0;training=false;eventCapture=null;resetSmart();releaseWake();
    el.status.textContent='● 已停止';el.status.classList.remove('on');el.start.textContent='开始监听';el.start.classList.remove('stop');
    el.bar.style.width='0%';el.levelText.textContent='0 / 100';el.last.textContent='监听已停止';saveData();renderTemplate();updateUI();
  }

  function readRms(){
    if(!analyser||!timeData)return 0;
    analyser.getFloatTimeDomainData(timeData);let sum=0;for(const v of timeData)sum+=v*v;return Math.sqrt(sum/timeData.length);
  }
  function updateDb(rms,now){
    const dbfs=20*Math.log10(Math.max(rms,.00001)),estimated=Math.max(0,Math.min(140,dbfs+(+el.dbCalibration.value)));
    smoothedDb=smoothedDb==null?estimated:smoothedDb*.88+estimated*.12;currentDb=smoothedDb;el.currentDb.innerHTML=Math.round(currentDb)+'<small>dB</small>';
    if(now-lastDbSample>=250&&estimated>15){lastDbSample=now;dbSum+=estimated;dbSamples++;dbPeak=dbPeak==null?estimated:Math.max(dbPeak,estimated);el.averageDb.textContent=Math.round(dbSum/dbSamples)+' dB';el.peakDb.textContent=Math.round(dbPeak)+' dB'}
  }
  function getLevel(rms){
    const general=Math.min(100,rms*345);
    if(el.mode.value==='general')return general;
    analyser.getByteFrequencyData(freqData);const nyq=ctx.sampleRate/2,from=Math.floor(1400/nyq*freqData.length),to=Math.min(freqData.length-1,Math.floor(5200/nyq*freqData.length));
    let high=0;for(let i=from;i<=to;i++)high+=freqData[i];high=high/Math.max(1,to-from+1)/2.55;return Math.min(100,Math.max(high,general*.45));
  }

  function frameSpectrum(){
    analyser.getByteFrequencyData(freqData);
    const bands=18,out=new Array(bands).fill(0),nyq=ctx.sampleRate/2,minHz=90,maxHz=Math.min(7000,nyq);
    for(let b=0;b<bands;b++){
      const f1=minHz*Math.pow(maxHz/minHz,b/bands),f2=minHz*Math.pow(maxHz/minHz,(b+1)/bands);
      const i1=Math.max(1,Math.floor(f1/nyq*freqData.length)),i2=Math.min(freqData.length-1,Math.ceil(f2/nyq*freqData.length));
      let sum=0;for(let i=i1;i<=i2;i++){const v=freqData[i]/255;sum+=v*v}out[b]=Math.sqrt(sum/Math.max(1,i2-i1+1));
    }
    return out;
  }
  function spectralCentroid(){
    analyser.getByteFrequencyData(freqData);const nyq=ctx.sampleRate/2;let weighted=0,total=0;
    for(let i=1;i<freqData.length;i++){const f=i/freqData.length*nyq;if(f>8000)break;const m=freqData[i];weighted+=f*m;total+=m}
    return total?weighted/total:0;
  }
  function zeroCrossingRate(){
    let c=0;for(let i=1;i<timeData.length;i++)if((timeData[i-1]<0&&timeData[i]>=0)||(timeData[i-1]>=0&&timeData[i]<0))c++;
    return c/timeData.length;
  }
  function startEvent(now,level,rms){
    eventCapture={start:now,lastAbove:now,levels:[level],rms:[rms],spectra:[frameSpectrum()],centroids:[spectralCentroid()],zcr:[zeroCrossingRate()]};belowSince=0;
  }
  function collectEvent(now,level,rms,aboveRelease){
    const e=eventCapture;if(!e)return;e.levels.push(level);e.rms.push(rms);e.spectra.push(frameSpectrum());e.centroids.push(spectralCentroid());e.zcr.push(zeroCrossingRate());if(aboveRelease)e.lastAbove=now;
  }
  function median(a){const b=[...a].sort((x,y)=>x-y),m=Math.floor(b.length/2);return b.length%2?b[m]:(b[m-1]+b[m])/2}
  function normalize(v){const norm=Math.sqrt(v.reduce((s,x)=>s+x*x,0))||1;return v.map(x=>x/norm)}
  function finishEvent(now){
    const e=eventCapture;eventCapture=null;belowSince=0;if(!e)return;
    const duration=Math.max(60,e.lastAbove-e.start+80),peak=Math.max(...e.levels),loudness=median(e.rms),frames=e.spectra.length;
    if(peak<Math.max(4,+el.threshold.value*.72))return;
    const spectrum=new Array(18).fill(0);for(const f of e.spectra)for(let i=0;i<18;i++)spectrum[i]+=f[i];for(let i=0;i<18;i++)spectrum[i]/=frames;
    const features={version:1,recordedAt:Date.now(),duration,peak,loudness,spectrum:normalize(spectrum),centroid:median(e.centroids),zcr:median(e.zcr),sampleRate:ctx.sampleRate};
    lastCandidateAt=now;
    if(training){
      soundTemplate={...features,learnedIntervalMs:null,intervalSamples:0};training=false;saveTemplate();el.last.textContent='目标声音录制完成，现在只匹配相似声音';flash('模板录制成功');return;
    }
    if(!soundTemplate){el.last.textContent='检测到声音，但未录制模板，未计数';return}
    evaluateCandidate(features);
  }

  function cosine(a,b){let dot=0,aa=0,bb=0;for(let i=0;i<Math.min(a.length,b.length);i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i]}return dot/(Math.sqrt(aa*bb)||1)}
  function logSimilarity(a,b,tolerance){return Math.exp(-Math.abs(Math.log(Math.max(a,1e-6)/Math.max(b,1e-6)))/tolerance)}
  function intervalExpectation(){
    if(el.countMode.value==='smart2'&&(smartStage===1||smartStage===3))return +el.pressSeconds.value*1000;
    if(soundTemplate?.learnedIntervalMs)return soundTemplate.learnedIntervalMs;
    return null;
  }
  function intervalSimilarity(now){
    const expected=intervalExpectation();if(!expected||!lastAcceptedAt)return null;
    const gap=now-lastAcceptedAt;
    if(el.countMode.value==='smart2'&&smartStage===2)return gap<=30000?1:.15;
    return Math.exp(-Math.abs(gap-expected)/Math.max(900,expected*.38));
  }
  function updateLearnedInterval(now){
    if(!lastAcceptedAt||!soundTemplate)return;
    const gap=now-lastAcceptedAt;
    if(gap<350||gap>60000)return;
    // 智能两遍模式的换衣/换位间隔差异大，只学习接近烫压设定的压下→抬起间隔。
    if(el.countMode.value==='smart2'){
      const target=+el.pressSeconds.value*1000;if(Math.abs(gap-target)>Math.max(3500,target*.65))return;
    }
    const old=soundTemplate.learnedIntervalMs;
    soundTemplate.learnedIntervalMs=old?old*.82+gap*.18:gap;
    soundTemplate.intervalSamples=(soundTemplate.intervalSamples||0)+1;
    saveTemplate();
  }
  function evaluateCandidate(f){
    const freq=Math.max(0,Math.min(1,cosine(f.spectrum,soundTemplate.spectrum)));
    const loud=logSimilarity(f.loudness,soundTemplate.loudness,.62);
    const duration=logSimilarity(f.duration+50,soundTemplate.duration+50,.72);
    const centroid=logSimilarity(f.centroid+120,soundTemplate.centroid+120,.72);
    const zcr=logSimilarity(f.zcr+.005,soundTemplate.zcr+.005,.75);
    const intScore=intervalSimilarity(Date.now());
    let score=freq*.45+loud*.18+duration*.18+centroid*.07+zcr*.07;
    let weight=.95;
    if(intScore!=null){score+=intScore*.05;weight=1}
    score=Math.max(0,Math.min(1,score/weight));recentMatch=Math.round(score*100);el.matchScore.textContent=recentMatch+'%';
    const need=+el.strictness.value;
    if(recentMatch>=need){
      const now=Date.now();updateLearnedInterval(now);lastAcceptedAt=now;registerSound('模板匹配 ' + recentMatch + '% · ');
    }else{
      el.last.textContent=`声音相似度 ${recentMatch}%（需要 ${need}%），已忽略`;
    }
  }

  function loop(){
    if(!listening)return;const now=performance.now(),rms=readRms();updateDb(rms,now);const level=getLevel(rms),threshold=+el.threshold.value;
    noiseFloor=level<threshold?noiseFloor*.985+level*.015:noiseFloor;
    const onset=Math.max(threshold,noiseFloor+Math.max(4,threshold*.18)),release=Math.max(noiseFloor+2,onset*.48);
    el.bar.style.width=level.toFixed(1)+'%';el.levelText.textContent=Math.round(level)+' / 100';
    if(!eventCapture){
      if(level>=onset&&now-lastCandidateAt>=+el.cooldown.value){startEvent(now,level,rms)}
    }else{
      const aboveRelease=level>=release;collectEvent(now,level,rms,aboveRelease);
      if(aboveRelease)belowSince=0;else if(!belowSince)belowSince=now;
      const elapsed=now-eventCapture.start;
      if((belowSince&&now-belowSince>150)||elapsed>2600)finishEvent(now);
    }
    raf=requestAnimationFrame(loop);
  }

  async function recordTemplate(){
    if(training){training=false;eventCapture=null;renderTemplate();el.last.textContent='已取消录制目标声音';return}
    const ok=await ensureAudio();if(!ok)return;
    training=true;eventCapture=null;belowSince=0;partial=0;resetSmart();renderTemplate();el.last.textContent='请现在操作一次烫画机，系统会自动截取声音';
  }
  function clearTemplate(){
    if(!soundTemplate)return;
    if(confirm('确定清除已录制的目标声音吗？')){soundTemplate=null;lastAcceptedAt=0;recentMatch=null;el.matchScore.textContent='--';saveTemplate();el.last.textContent='声音模板已清除'}
  }

  function exportCsv(){
    if(!times.length){alert('还没有完成记录。');return}
    const rows=[['序号','完成时间','与上一件间隔(秒)']];
    times.forEach((t,i)=>rows.push([i+1,new Date(t).toLocaleString('zh-CN',{hour12:false}),i?((t-times[i-1])/1000).toFixed(1):'']));
    const csv='\ufeff'+rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');
    a.href=url;a.download='烫画机计数_'+new Date().toISOString().slice(0,10)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  el.start.addEventListener('click',start);el.plus.addEventListener('click',()=>addPiece('手动'));el.minus.addEventListener('click',removePiece);
  el.test.addEventListener('click',()=>registerSound('模拟'));el.export.addEventListener('click',exportCsv);
  el.recordTemplate.addEventListener('click',recordTemplate);el.clearTemplate.addEventListener('click',clearTemplate);
  el.reset.addEventListener('click',()=>{
    if(confirm('确定清空累计件数、分贝和全部记录吗？声音模板会保留。')){
      count=0;times=[];partial=0;resetSmart();activeMs=0;dbPeak=null;dbSum=0;dbSamples=0;currentDb=null;smoothedDb=null;
      if(listening)runStarted=Date.now();saveData();updateUI();el.last.textContent='生产数据已清空，声音模板已保留';
    }
  });
  [el.threshold,el.cooldown,el.pressSeconds,el.dbCalibration,el.strictness].forEach(x=>x.addEventListener('input',syncSettings));
  [el.mode,el.countMode,el.keepAwake].forEach(x=>x.addEventListener('change',async()=>{
    partial=0;resetSmart(el.countMode.value==='smart2'?'已切换：等待第1遍压下声音':'计数方式已切换');saveSettings();
    if(x===el.keepAwake){if(x.checked)await requestWake();else await releaseWake()}
  }));
  document.addEventListener('visibilitychange',async()=>{
    if(document.hidden&&listening)el.backgroundWarning.classList.add('show');
    if(!document.hidden&&listening){await ctx?.resume().catch(()=>{});await requestWake();flash('已回到前台，请检查计数')}
  });
  window.addEventListener('pagehide',saveData);
  if(!window.isSecureContext)el.secureWarning.classList.add('show');
  loadSettings();loadTemplate();loadData();updateUI();setInterval(updateUI,1000);
})();
