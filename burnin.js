(()=>{
  const $=id=>document.getElementById(id);
  const KEY='heatpress-burnin-settings-v1';
  const el={
    overlay:$('burnInOverlay'),float:$('burnInFloat'),count:$('burnInCount'),status:$('status'),
    total:$('total'),enabled:$('burnInMode'),delay:$('burnInDelay'),delayValue:$('burnInDelayValue')
  };
  if(!el.overlay||!el.float||!el.count||!el.status||!el.total||!el.enabled||!el.delay)return;

  let idleTimer=0,moveTimer=0,active=false;

  function load(){
    let s={};
    try{s=JSON.parse(localStorage.getItem(KEY)||'{}')}catch{}
    el.enabled.checked=typeof s.enabled==='boolean'?s.enabled:true;
    el.delay.value=Number.isFinite(s.delay)?String(s.delay):'30';
    sync();
  }

  function save(){
    localStorage.setItem(KEY,JSON.stringify({enabled:el.enabled.checked,delay:+el.delay.value}));
  }

  function sync(){
    el.delayValue.textContent=el.delay.value+' 秒';
    save();
  }

  function listening(){return el.status.classList.contains('on')}

  function updateCount(){el.count.textContent=el.total.textContent||'0'}

  function move(){
    if(!active)return;
    const x=12+Math.random()*76;
    const y=15+Math.random()*70;
    el.float.style.left=x.toFixed(1)+'%';
    el.float.style.top=y.toFixed(1)+'%';
  }

  function hide(){
    active=false;
    clearInterval(moveTimer);moveTimer=0;
    el.overlay.classList.remove('show');
    el.overlay.setAttribute('aria-hidden','true');
    document.body.classList.remove('burnin-active');
  }

  function show(){
    if(!el.enabled.checked||!listening()||document.hidden)return;
    active=true;updateCount();move();
    el.overlay.classList.add('show');
    el.overlay.setAttribute('aria-hidden','false');
    document.body.classList.add('burnin-active');
    clearInterval(moveTimer);
    moveTimer=setInterval(move,18000);
  }

  function schedule(){
    clearTimeout(idleTimer);idleTimer=0;
    if(!el.enabled.checked||!listening()||document.hidden){hide();return}
    idleTimer=setTimeout(show,(+el.delay.value||30)*1000);
  }

  function wake(){
    if(active)hide();
    schedule();
  }

  el.overlay.addEventListener('pointerdown',wake,{passive:true});
  ['pointerdown','touchstart','keydown','input','change','scroll'].forEach(type=>{
    document.addEventListener(type,e=>{
      if(e.target===el.overlay||el.overlay.contains(e.target))return;
      wake();
    },{passive:true,capture:true});
  });

  el.enabled.addEventListener('change',()=>{sync();if(!el.enabled.checked)hide();schedule()});
  el.delay.addEventListener('input',()=>{sync();schedule()});

  new MutationObserver(()=>{
    updateCount();
    if(active)move();
  }).observe(el.total,{childList:true,characterData:true,subtree:true});

  new MutationObserver(()=>{
    if(listening())schedule();else hide();
  }).observe(el.status,{attributes:true,childList:true,characterData:true,subtree:true});

  document.addEventListener('visibilitychange',()=>{
    if(document.hidden)hide();else schedule();
  });

  window.addEventListener('pagehide',()=>{clearTimeout(idleTimer);clearInterval(moveTimer)});

  load();updateCount();schedule();
})();
