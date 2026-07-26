/** 单文件控制台页面(内嵌构建,不引前端框架) */
export const UI_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>aihub-auto 控制台</title>
<style>
:root{--bg:#fff;--fg:#1a1a2e;--muted:#667;--card:#f6f7fb;--accent:#4f6df5;--ok:#18a058;--warn:#d97706;--err:#dc2626;--border:#e3e6ef}
@media(prefers-color-scheme:dark){:root{--bg:#101218;--fg:#e8eaf2;--muted:#99a;--card:#1a1e2a;--accent:#7c94ff;--ok:#3dd68c;--warn:#f5a623;--err:#ff6b6b;--border:#2a2f3f}}
*{box-sizing:border-box}body{margin:0;font:14px/1.6 system-ui,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);padding:20px;max-width:1080px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));margin-top:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px}
.card.wide{grid-column:1/-1}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--border);white-space:nowrap}
th{color:var(--muted);font-weight:500}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;background:var(--accent);color:#fff}
.badge.ok{background:var(--ok)}.badge.warn{background:var(--warn)}.badge.err{background:var(--err)}
button,select,input{font:inherit;padding:6px 12px;border-radius:7px;border:1px solid var(--border);background:var(--bg);color:var(--fg)}
button{cursor:pointer;background:var(--accent);color:#fff;border:none}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}
.muted{color:var(--muted);font-size:12px}
#toast{position:fixed;bottom:20px;right:20px;background:var(--fg);color:var(--bg);padding:10px 16px;border-radius:8px;opacity:0;transition:.3s}
#toast.show{opacity:1}
dialog{border:1px solid var(--border);border-radius:12px;background:var(--card);color:var(--fg);max-width:400px}
dialog::backdrop{background:#0008}
.kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:13px}
.kv dt{color:var(--muted)}.kv dd{margin:0}
</style>
</head>
<body>
<h1>aihub-auto <span class="muted">最优分组自动路由</span></h1>
<div class="muted" id="version"></div>

<div class="grid">
  <div class="card">
    <h2>状态</h2>
    <dl class="kv">
      <dt>当前分组</dt><dd id="curGroup">-</dd>
      <dt>策略</dt><dd id="curMode">-</dd>
      <dt>Key 模式</dt><dd id="curKeyMode">-</dd>
      <dt>登录</dt><dd id="authState">-</dd>
      <dt>近 5 分钟请求</dt><dd id="reqCount">-</dd>
      <dt>数据</dt><dd id="staleState">-</dd>
    </dl>
  </div>

  <div class="card">
    <h2>策略</h2>
    <div class="row">
      <select id="mode">
        <option value="economy">省钱优先</option>
        <option value="balanced">均衡</option>
        <option value="speed">速度优先</option>
      </select>
      <select id="keyMode">
        <option value="single">单 Key 切组</option>
        <option value="pool">Key 池(推荐)</option>
      </select>
      <button id="saveCfg">保存</button>
    </div>
    <div class="row">
      <label>倍率区间 <input id="priceMin" type="number" step="0.01" style="width:70px"> ~ <input id="priceMax" type="number" step="0.01" style="width:70px"></label>
    </div>
    <div class="row">
      <button class="ghost" id="routeOnce">立即路由</button>
      <button class="ghost" id="dryRun">模拟(dry-run)</button>
    </div>
    <div class="muted" id="lastDecision"></div>
  </div>

  <div class="card">
    <h2>登录 AIHub</h2>
    <div class="row"><input id="email" type="email" placeholder="邮箱" style="flex:1"></div>
    <div class="row"><input id="password" type="password" placeholder="密码" style="flex:1"></div>
    <div class="row"><button id="login">登录</button><span class="muted">或</span></div>
    <div class="row"><input id="token" type="password" placeholder="直接粘贴 access token" style="flex:1"><button class="ghost" id="saveToken">保存</button></div>
    <div class="muted">凭据仅存本机配置目录,不上传任何第三方。</div>
  </div>

  <div class="card wide">
    <h2>候选分组 <span class="muted">(含被排除项与原因,完全可解释)</span></h2>
    <div style="overflow-x:auto"><table id="candTable">
      <thead><tr><th>#</th><th>分组</th><th>倍率</th><th>TTFT</th><th>保守延迟</th><th>置信度</th><th>得分</th><th>状态</th><th>黑名单</th></tr></thead>
      <tbody></tbody>
    </table></div>
  </div>
</div>

<div id="toast"></div>

<script>
const $=s=>document.querySelector(s);
let uiPass=localStorage.getItem("aihub-auto-pass")||"";
function hdrs(){const h={"Content-Type":"application/json"};if(uiPass)h["x-ui-password"]=uiPass;return h}
function toast(msg){const t=$("#toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2600)}
async function api(path,opts){
  const res=await fetch(path,Object.assign({headers:hdrs()},opts));
  if(res.status===401){const p=prompt("控制台口令:");if(p!=null){uiPass=p;localStorage.setItem("aihub-auto-pass",p);return api(path,opts)}throw new Error("需要口令")}
  const j=await res.json();
  if(!res.ok)throw new Error(j.error||res.status);
  return j;
}
function fmtScore(s){return s==null?"-":(typeof s==="number"?s.toFixed(3):s)}
async function refresh(){
  try{
    const s=await api("/ctl/status");
    $("#curGroup").innerHTML=s.currentGroupId!=null?\`<span class="badge ok">#\${s.currentGroupId}\${s.currentCode?" "+s.currentCode:""}</span>\`:"未路由";
    $("#curMode").textContent={economy:"省钱优先",balanced:"均衡",speed:"速度优先"}[s.config.mode];
    $("#curKeyMode").textContent=s.config.keyMode==="pool"?\`Key 池(\${Object.keys(s.pool||{}).length} 组)\`:"单 Key 切组";
    $("#authState").innerHTML=s.needsReauth?'<span class="badge err">token 失效,请重新登录</span>':(s.hasToken?'<span class="badge ok">已登录</span>':'<span class="badge warn">未登录</span>');
    $("#reqCount").textContent=s.traffic.requestsLast5m+(s.traffic.activeStreams?\`(\${s.traffic.activeStreams} 在飞)\`:"");
    $("#staleState").innerHTML=s.stale?'<span class="badge warn">上游统计过期(用缓存)</span>':'<span class="badge ok">新鲜</span>';
    $("#mode").value=s.config.mode;$("#keyMode").value=s.config.keyMode;
    if(document.activeElement?.id!=="priceMin")$("#priceMin").value=s.config.priceBand.min;
    if(document.activeElement?.id!=="priceMax")$("#priceMax").value=s.config.priceBand.max;
    const tb=$("#candTable tbody");tb.innerHTML="";
    let i=0;
    for(const c of s.candidates){
      const tr=document.createElement("tr");
      const cur=c.groupId===s.currentGroupId;
      tr.innerHTML=\`<td>\${c.excluded?"":++i}</td><td>\${c.code}(#\${c.groupId})\${cur?' <span class="badge ok">当前</span>':""}\${c.breaker&&c.breaker!=="closed"?' <span class="badge err">熔断:'+c.breaker+"</span>":""}</td><td>\${c.rate}x</td><td>\${c.ttft??"-"} ms</td><td>\${c.conservative??"-"} ms</td><td>\${c.confidence??"-"}</td><td>\${fmtScore(c.score)}</td><td>\${c.excluded?'<span class="badge warn">'+c.excludeReason+"</span>":'<span class="badge ok">候选</span>'}</td><td><input type="checkbox" data-gid="\${c.groupId}" \${s.config.blacklist.includes(c.groupId)?"checked":""}></td>\`;
      tb.appendChild(tr);
    }
    tb.querySelectorAll("input[type=checkbox]").forEach(cb=>cb.addEventListener("change",async e=>{
      const gid=Number(e.target.dataset.gid);
      const bl=new Set(s.config.blacklist);
      e.target.checked?bl.add(gid):bl.delete(gid);
      await api("/ctl/config",{method:"POST",body:JSON.stringify({blacklist:[...bl]})});
      toast("黑名单已更新");refresh();
    }));
  }catch(e){toast("状态获取失败:"+e.message)}
}
$("#saveCfg").addEventListener("click",async()=>{
  await api("/ctl/config",{method:"POST",body:JSON.stringify({
    mode:$("#mode").value,keyMode:$("#keyMode").value,
    priceBand:{min:Number($("#priceMin").value),max:Number($("#priceMax").value)}
  })});toast("配置已保存,热生效");refresh();
});
$("#routeOnce").addEventListener("click",async()=>{
  const r=await api("/ctl/route-once",{method:"POST",body:JSON.stringify({dryRun:false})});
  $("#lastDecision").textContent=\`决策:\${r.reason}\${r.targetGroupId!=null?" → #"+r.targetGroupId:""}(优势 \${fmtScore(r.advantage)} / 门槛 \${fmtScore(r.effectiveThreshold)})\`;
  toast(r.shouldSwitch?"已切换到 #"+r.targetGroupId:"保持当前分组");refresh();
});
$("#dryRun").addEventListener("click",async()=>{
  const r=await api("/ctl/route-once",{method:"POST",body:JSON.stringify({dryRun:true})});
  $("#lastDecision").textContent=\`模拟:\${r.reason}\${r.targetGroupId!=null?" → #"+r.targetGroupId:""}(优势 \${fmtScore(r.advantage)} / 门槛 \${fmtScore(r.effectiveThreshold)});未执行\`;
});
$("#login").addEventListener("click",async()=>{
  try{
    await api("/ctl/login",{method:"POST",body:JSON.stringify({email:$("#email").value,password:$("#password").value})});
    $("#password").value="";toast("登录成功");refresh();
  }catch(e){toast("登录失败:"+e.message)}
});
$("#saveToken").addEventListener("click",async()=>{
  try{
    await api("/ctl/login",{method:"POST",body:JSON.stringify({token:$("#token").value})});
    $("#token").value="";toast("token 已保存");refresh();
  }catch(e){toast("保存失败:"+e.message)}
});
refresh();setInterval(refresh,5000);
</script>
</body>
</html>`;
