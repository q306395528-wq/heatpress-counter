(()=>{
  const DATA_KEY='heatpress-mobile-v1';
  const $=id=>document.getElementById(id);
  const el={
    date:$('recordDate'),summary:$('recordSummary'),dayTotal:$('dayTotal'),daySpeed:$('daySpeed'),
    hourly:$('hourlyRecords'),pieces:$('pieceRecords'),export:$('exportSelected'),today:$('jumpToday')
  };
  let lastRaw='';

  function pad(n){return String(n).padStart(2,'0')}
  function dateKey(ts){const d=new Date(ts);return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`}
  function todayKey(){return dateKey(Date.now())}
  function timeText(ts){const d=new Date(ts);return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`}
  function hourLabel(hour){return `${pad(hour)}:00–${pad(hour)}:59`}

  function readTimes(){
    try{
      const d=JSON.parse(localStorage.getItem(DATA_KEY)||'{}');
      return Array.isArray(d.times)?d.times.filter(Number.isFinite).sort((a,b)=>a-b):[];
    }catch{return []}
  }

  function speedFromTimes(stamps){
    if(stamps.length<2)return null;
    const gaps=[];
    for(let i=1;i<stamps.length;i++){
      const gap=stamps[i]-stamps[i-1];
      if(gap>=1000&&gap<=300000)gaps.push(gap);
    }
    if(!gaps.length)return null;
    const avg=gaps.reduce((a,b)=>a+b,0)/gaps.length;
    return Math.round(3600000/avg);
  }

  function groupByHour(stamps){
    const map=new Map();
    for(const ts of stamps){
      const hour=new Date(ts).getHours();
      if(!map.has(hour))map.set(hour,[]);
      map.get(hour).push(ts);
    }
    return [...map.entries()].sort((a,b)=>a[0]-b[0]);
  }

  function render(){
    const selectedDate=el.date.value||todayKey();
    const selected=readTimes().filter(ts=>dateKey(ts)===selectedDate);
    const groups=groupByHour(selected);
    const daySpeed=speedFromTimes(selected);
    const isToday=selectedDate===todayKey();
    const nowHour=new Date().getHours();

    el.summary.textContent=`${selectedDate} · 自动保存 ${selected.length} 件`;
    el.dayTotal.textContent=`${selected.length} 件`;
    el.daySpeed.textContent=daySpeed?`${daySpeed} 件/小时`:'--';

    if(!groups.length){
      el.hourly.innerHTML='<div class="empty-records">这一天还没有完成记录</div>';
    }else{
      el.hourly.innerHTML=groups.map(([hour,stamps])=>{
        const speed=speedFromTimes(stamps);
        const current=isToday&&hour===nowHour?' current':'';
        return `<div class="hour-row${current}">
          <div class="hour-time">${hourLabel(hour)}${current?' · 当前':''}</div>
          <div class="hour-qty">${stamps.length}件</div>
          <div class="hour-speed"><b>${speed?speed:'--'}</b>件/小时</div>
        </div>`;
      }).join('');
    }

    if(!selected.length){
      el.pieces.innerHTML='<div class="empty-records">暂无每件完成时间</div>';
    }else{
      const rows=selected.map((ts,i)=>{
        const gap=i?Math.round((ts-selected[i-1])/1000):null;
        return {index:i+1,ts,gap};
      }).reverse();
      el.pieces.innerHTML=rows.map(row=>`<div class="piece-row">
        <div class="piece-index">第${row.index}件</div>
        <div class="piece-time">${timeText(row.ts)}</div>
        <div class="piece-gap">${row.gap==null?'开始':`间隔 ${row.gap}秒`}</div>
      </div>`).join('');
    }
  }

  function csvCell(value){return `"${String(value).replaceAll('"','""')}"`}
  function exportSelected(){
    const selectedDate=el.date.value||todayKey();
    const selected=readTimes().filter(ts=>dateKey(ts)===selectedDate);
    if(!selected.length){alert('所选日期没有记录。');return}
    const groups=groupByHour(selected);
    const rows=[
      ['日期',selectedDate],
      ['当日总量',`${selected.length}件`],
      ['平均工作速度',speedFromTimes(selected)?`${speedFromTimes(selected)}件/小时`:'--'],
      [],
      ['小时','完成件数','工作速度(件/小时)']
    ];
    for(const [hour,stamps] of groups){rows.push([hourLabel(hour),stamps.length,speedFromTimes(stamps)||'--'])}
    rows.push([],['序号','完成时间','与上一件间隔(秒)']);
    selected.forEach((ts,i)=>rows.push([i+1,`${selectedDate} ${timeText(ts)}`,i?((ts-selected[i-1])/1000).toFixed(1):'']));
    const csv='\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');
    a.href=url;
    a.download=`烫画生产记录_${selectedDate}.csv`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  if(!el.date)return;
  el.date.value=todayKey();
  el.date.max=todayKey();
  el.date.addEventListener('change',render);
  el.export.addEventListener('click',exportSelected);
  el.today.addEventListener('click',()=>{el.date.value=todayKey();render()});
  lastRaw=localStorage.getItem(DATA_KEY)||'';
  render();
  setInterval(()=>{
    const raw=localStorage.getItem(DATA_KEY)||'';
    if(raw!==lastRaw){lastRaw=raw;render()}
  },1000);
})();