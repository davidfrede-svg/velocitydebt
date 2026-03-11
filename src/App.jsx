import { useState, useMemo, useRef, useEffect } from "react";
import { useLocalStorage } from "./hooks/useLocalStorage";

// ── Stripe Payment Links ─────────────────────────────────────────────────────
// After creating your Stripe account, add these to .env.local:
//   VITE_STRIPE_MONTHLY_URL=https://buy.stripe.com/...
//   VITE_STRIPE_YEARLY_URL=https://buy.stripe.com/...
const STRIPE_MONTHLY_URL = import.meta.env.VITE_STRIPE_MONTHLY_URL;
const STRIPE_YEARLY_URL  = import.meta.env.VITE_STRIPE_YEARLY_URL;

/* ── FONTS ─────────────────────────────────────────── */
(() => {
  if (document.getElementById("vd-fonts")) return;
  const l = document.createElement("link");
  l.id = "vd-fonts";
  l.rel = "stylesheet";
  l.href = "https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap";
  document.head.appendChild(l);
})();

/* ── THEME ─────────────────────────────────────────── */
const T = {
  bg:"#060710", surf:"#0B0C1E", surf2:"#0F1128",
  border:"#161830", border2:"#1E2040",
  text:"#F0F1FF", muted:"#3A3E6A", dim:"#6B7299",
  red:"#FF4D6D", orange:"#FF8C42", yellow:"#F5C518",
  green:"#22D3A0", blue:"#4DA6FF", purple:"#A855F7",
  teal:"#2DD4BF", gold:"#C9A84C", goldL:"#E8C87A",
};

/* ── HELPERS ───────────────────────────────────────── */
const $c = n => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(n||0);
const fmt = m => { if(!m||m<=0) return "—"; const y=Math.floor(m/12),mo=m%12; return y&&mo?`${y}yr ${mo}mo`:y?`${y}yr`:`${mo}mo`; };
const addMo = m => { const d=new Date(); d.setMonth(d.getMonth()+Math.round(m||0)); return d.toLocaleString("default",{month:"short",year:"numeric"}); };
const uid = () => Math.random().toString(36).slice(2,8);
const CARD_COLORS = [T.red,T.orange,T.yellow,T.green,T.blue,T.purple,T.teal,"#F472B6","#34D399","#60A5FA"];

/* ── DEBT ENGINES ──────────────────────────────────── */
function runAvalanche(debts, extraPm=0) {
  if(!debts.length) return {months:0,totalInt:0,snaps:[]};
  let ds=[...debts].sort((a,b)=>b.rate-a.rate).map(d=>({...d,rem:d.balance}));
  let month=0,totalInt=0;
  const snaps=[{month:0,total:ds.reduce((s,d)=>s+d.rem,0)}];
  while(month<480 && ds.some(d=>d.rem>0)){
    month++;
    ds=ds.map(d=>{
      if(d.rem<=0) return d;
      const i=d.rem*(d.rate/100/12); totalInt+=i;
      return {...d,rem:Math.max(0,d.rem+i-d.min)};
    });
    const focus=ds.find(d=>d.rem>0);
    if(focus&&extraPm>0) focus.rem=Math.max(0,focus.rem-extraPm);
    if(month%4===0) snaps.push({month,total:ds.reduce((s,d)=>s+d.rem,0)});
  }
  return {months:month,totalInt,snaps};
}

function runSnowball(debts, extraPm=0) {
  if(!debts.length) return {months:0,totalInt:0,snaps:[]};
  let ds=[...debts].sort((a,b)=>a.balance-b.balance).map(d=>({...d,rem:d.balance}));
  let month=0,totalInt=0,freed=0;
  const snaps=[{month:0,total:ds.reduce((s,d)=>s+d.rem,0)}];
  while(month<480 && ds.some(d=>d.rem>0)){
    month++;
    ds=ds.map(d=>{
      if(d.rem<=0) return d;
      const i=d.rem*(d.rate/100/12); totalInt+=i;
      return {...d,rem:Math.max(0,d.rem+i-d.min)};
    });
    const focus=ds.find(d=>d.rem>0);
    if(focus){
      const pmt=extraPm+freed;
      if(pmt>0){ const was=focus.rem; focus.rem=Math.max(0,focus.rem-pmt); if(focus.rem===0) freed+=focus.min; }
    }
    if(month%4===0) snaps.push({month,total:ds.reduce((s,d)=>s+d.rem,0)});
  }
  return {months:month,totalInt,snaps};
}

function runBaseline(debts) {
  return runAvalanche(debts,0);
}

function runVelocity({debts,income,livingExp,heloc}) {
  let ds=[...debts].sort((a,b)=>b.rate-a.rate).map(d=>({...d,rem:d.balance}));
  let hBal=heloc.balance||0;
  const hLimit=heloc.limit||15000;
  const hRate=heloc.rate/100/12;
  let month=0,totalInt=0,freed=0;
  const snaps=[];
  while(month<480 && ds.some(d=>d.rem>0)){
    month++;
    hBal=Math.max(-hLimit,hBal-income);
    hBal+=livingExp;
    ds=ds.map(d=>{
      if(d.rem<=0) return d;
      const i=d.rem*(d.rate/100/12); totalInt+=i;
      return {...d,rem:Math.max(0,d.rem+i-d.min)};
    });
    const helocInt=Math.abs(Math.min(0,hBal))*hRate;
    hBal+=helocInt; totalInt+=helocInt;
    if(month%6===0 && hBal<-4000){
      const chunk=Math.abs(hBal)*0.65;
      const focus=ds.find(d=>d.rem>0);
      if(focus){
        const actual=Math.min(chunk,focus.rem);
        focus.rem-=actual; hBal+=actual;
        if(focus.rem<=0) freed+=focus.min;
      }
    }
    hBal-=freed;
    if(month%3===0) snaps.push({month,total:ds.reduce((s,d)=>s+d.rem,0)});
    if(!ds.some(d=>d.rem>0)) break;
  }
  return {months:month,totalInt,snaps};
}

function buildIllustration(annualPremium=12000,years=40){
  return Array.from({length:years},(_,i)=>{
    const y=i+1;
    const cv=annualPremium*y*(0.72+y*0.012)*(1+y*0.008);
    const db=Math.max(cv*1.8,annualPremium*25);
    return {year:y,premium:annualPremium,cashValue:Math.round(cv),deathBenefit:Math.round(db),loanValue:Math.round(cv*0.92),surrenderValue:Math.round(cv*(y<3?0.2:0.75+Math.min(0.24,(y-3)*0.012)))};
  });
}

/* ── CSS ───────────────────────────────────────────── */
const CSS = `
*{box-sizing:border-box;margin:0;padding:0;}
html,body{background:#060710;-webkit-font-smoothing:antialiased;}
@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes glow{0%,100%{box-shadow:0 0 10px #22D3A033}50%{box-shadow:0 0 26px #22D3A066}}
@keyframes goldGlow{0%,100%{box-shadow:0 0 10px #C9A84C33}50%{box-shadow:0 0 26px #C9A84C66}}
@keyframes ticker{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
.fu{animation:fadeUp .38s ease both}
.fu1{animation:fadeUp .38s .06s ease both}
.fu2{animation:fadeUp .38s .12s ease both}
.fu3{animation:fadeUp .38s .18s ease both}
.spin{animation:spin 1s linear infinite;display:inline-block}
.glow{animation:glow 2s ease infinite}
.gold-glow{animation:goldGlow 2.5s ease infinite}
.pulse{animation:pulse 1.8s ease infinite}
.btn{border:none;cursor:pointer;font-family:'Syne',sans-serif;font-weight:700;transition:all .16s;}
.btn:active{transform:scale(.97);}
.hov{transition:all .16s;cursor:pointer}
.hov:hover{opacity:.88}
input,textarea,select{outline:none;font-family:'Syne',sans-serif;-webkit-appearance:none;}
input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none}
input[type=range]{-webkit-appearance:none;width:100%;height:4px;border-radius:2px;background:#1E2040;cursor:pointer}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:#22D3A0;cursor:pointer}
::-webkit-scrollbar{width:2px;height:2px}
::-webkit-scrollbar-track{background:#060710}
::-webkit-scrollbar-thumb{background:#1E2040;border-radius:2px}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:200;display:flex;align-items:flex-end;justify-content:center}
@media(min-width:600px){.modal-overlay{align-items:center}}
.modal-sheet{background:#0B0C1E;border-radius:20px 20px 0 0;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;padding:20px}
@media(min-width:600px){.modal-sheet{border-radius:20px;max-height:85vh}}
.tab-bar{display:flex;overflow-x:auto;scrollbar-width:none;-ms-overflow-style:none;}
.tab-bar::-webkit-scrollbar{display:none}
.bottom-nav{display:flex;background:#0B0C1E;border-top:1px solid #161830;position:fixed;bottom:0;left:0;right:0;z-index:90;padding:0 0 env(safe-area-inset-bottom)}
@media(min-width:768px){.bottom-nav{display:none}}
.desktop-tabs{display:none}
@media(min-width:768px){.desktop-tabs{display:flex}}
.page-content{padding:16px;padding-bottom:80px;max-width:760px;margin:0 auto;}
@media(min-width:768px){.page-content{padding:24px;padding-bottom:24px;}}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
@media(max-width:480px){.grid-3{grid-template-columns:1fr 1fr}}
.row{display:flex;gap:10px;align-items:center}
.col{display:flex;flex-direction:column;gap:10px}
`;

/* ── MICRO UI ──────────────────────────────────────── */
const Tag = ({label,color=T.green}) => (
  <span style={{background:`${color}18`,border:`1px solid ${color}33`,color,fontSize:9,fontWeight:800,padding:"2px 8px",borderRadius:100,letterSpacing:1.5,whiteSpace:"nowrap"}}>{label}</span>
);

const Card = ({children,accent,style={}}) => (
  <div style={{background:T.surf,border:`1px solid ${T.border}`,borderRadius:14,overflow:"hidden",position:"relative",...style}}>
    {accent&&<div style={{position:"absolute",top:0,left:0,right:0,height:2,background:`linear-gradient(90deg,${accent},${accent}55,transparent)`}}/>}
    {children}
  </div>
);

const Input = ({label,value,onChange,type="text",prefix,suffix,style={}}) => (
  <div style={{...style}}>
    {label&&<div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:1.5,marginBottom:5,textTransform:"uppercase"}}>{label}</div>}
    <div style={{display:"flex",alignItems:"center",background:T.surf2,border:`1px solid ${T.border2}`,borderRadius:9,overflow:"hidden"}}>
      {prefix&&<span style={{padding:"0 10px",color:T.dim,fontSize:13,borderRight:`1px solid ${T.border2}`,background:T.bg}}>{prefix}</span>}
      <input type={type} value={value} onChange={onChange}
        style={{flex:1,background:"transparent",color:T.text,padding:"10px 12px",fontSize:14,fontFamily:type==="number"?"'JetBrains Mono',monospace":"'Syne',sans-serif",fontWeight:600,minWidth:0}}/>
      {suffix&&<span style={{padding:"0 10px",color:T.dim,fontSize:11,borderLeft:`1px solid ${T.border2}`}}>{suffix}</span>}
    </div>
  </div>
);

const StatBox = ({label,value,sub,color=T.green,small=false}) => (
  <div style={{background:T.surf2,border:`1px solid ${T.border}`,borderRadius:12,padding:"12px 14px",flex:1,minWidth:0}}>
    <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:1.5,marginBottom:4,textTransform:"uppercase"}}>{label}</div>
    <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:small?18:22,color,letterSpacing:1,lineHeight:1.1}}>{value}</div>
    {sub&&<div style={{fontSize:10,color:T.dim,marginTop:3}}>{sub}</div>}
  </div>
);

/* ── SPARKLINE ─────────────────────────────────────── */
const Spark = ({snaps=[],color,h=80}) => {
  if(snaps.length<2) return <div style={{height:h,background:T.surf2,borderRadius:8}}/>;
  const W=400;
  const maxV=Math.max(...snaps.map(s=>s.total),1);
  const maxM=snaps[snaps.length-1]?.month||1;
  const pts=snaps.map(s=>`${(s.month/maxM)*W},${h-(s.total/maxV)*h}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${h}`} style={{width:"100%",overflow:"visible",display:"block"}}>
      <defs>
        <linearGradient id={`g${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity=".2"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${pts} ${W},${h}`} fill={`url(#g${color.replace("#","")})`}/>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
};

/* ── UPGRADE MODAL ─────────────────────────────────── */
const UpgradeModal = ({onClose, feature="", onSelectMonthly, onSelectYearly}) => (
  <div className="modal-overlay" onClick={onClose}>
    <div className="modal-sheet" onClick={e=>e.stopPropagation()}>
      <div style={{textAlign:"center",padding:"8px 0 20px"}}>
        <div style={{fontSize:48,marginBottom:12}}>⚡</div>
        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:28,color:T.gold,letterSpacing:2,marginBottom:8}}>UPGRADE TO PRO</div>
        <div style={{fontSize:13,color:T.dim,lineHeight:1.8,marginBottom:20}}>
          {feature||"This feature"} is part of VelocityDebt Pro — our AI-powered plan that reads your real financial data and builds your personalized debt mission automatically.
        </div>
        <div style={{background:T.surf2,border:`1px solid ${T.border}`,borderRadius:14,padding:"16px",marginBottom:20,textAlign:"left"}}>
          <div style={{fontSize:9,color:T.gold,fontWeight:800,letterSpacing:2,marginBottom:12}}>PRO INCLUDES EVERYTHING IN FREE, PLUS:</div>
          {[
            ["🤖","AI CSV/Excel Import","Upload your bank file — AI reads everything automatically"],
            ["⚡","Velocity Banking Engine","HELOC/LOC strategy with chunk payments"],
            ["🛡️","IUL / Whole Life Strategy","Policy illustration upload + retirement modeling"],
            ["🌴","Retirement Income Planner","Tax-free policy loan income projections"],
            ["⚖️","Scenario A vs B Comparison","Traditional vs velocity + IUL side by side"],
            ["📄","Carrier Illustration Upload","Real carrier CSV data drives the simulation"],
            ["🏢","White-Label Agent Branding","Your logo, colors, and agency name"],
          ].map(([icon,title,desc],i)=>(
            <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start",marginBottom:12}}>
              <span style={{fontSize:18,flexShrink:0}}>{icon}</span>
              <div>
                <div style={{fontWeight:700,fontSize:13,color:T.text}}>{title}</div>
                <div style={{fontSize:11,color:T.muted,marginTop:2}}>{desc}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{display:"flex",gap:4,justifyContent:"center",marginBottom:16}}>
          <button onClick={onSelectMonthly} className="btn hov"
            style={{background:`${T.gold}18`,border:`1px solid ${T.gold}33`,borderRadius:10,padding:"16px 24px",textAlign:"center",flex:1}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:36,color:T.gold,letterSpacing:1}}>$14</div>
            <div style={{fontSize:10,color:T.muted,fontWeight:800,letterSpacing:1}}>PER MONTH</div>
          </button>
          <button onClick={onSelectYearly} className="btn hov"
            style={{background:`${T.purple}18`,border:`1px solid ${T.purple}33`,borderRadius:10,padding:"16px 24px",textAlign:"center",flex:1}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:36,color:T.purple,letterSpacing:1}}>$99</div>
            <div style={{fontSize:10,color:T.muted,fontWeight:800,letterSpacing:1}}>PER YEAR · SAVE 41%</div>
          </button>
        </div>
        <button className="btn gold-glow" onClick={onSelectMonthly}
          style={{width:"100%",background:`linear-gradient(135deg,${T.gold},${T.goldL})`,color:"#05060F",padding:"16px",borderRadius:12,fontSize:15,letterSpacing:.5,marginBottom:12}}>
          Upgrade to Pro →
        </button>
        <button className="btn" onClick={onClose}
          style={{background:"transparent",color:T.muted,fontSize:12,padding:"8px",width:"100%"}}>
          Maybe later
        </button>
      </div>
    </div>
  </div>
);

/* ── ADD/EDIT DEBT MODAL ────────────────────────────── */
const DebtModal = ({debt,onSave,onClose,idx}) => {
  const [d,setD]=useState(debt||{id:uid(),name:"",type:"credit_card",balance:"",rate:"",min:"",color:CARD_COLORS[idx%CARD_COLORS.length]});
  const set = (k,v) => setD(p=>({...p,[k]:v}));
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-sheet" onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:T.text,letterSpacing:2}}>{debt?"EDIT DEBT":"ADD DEBT"}</div>
          <button className="btn" onClick={onClose} style={{background:T.border2,color:T.muted,width:32,height:32,borderRadius:8,fontSize:16}}>✕</button>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <Input label="Debt Name" value={d.name} onChange={e=>set("name",e.target.value)}/>
          <div>
            <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:1.5,marginBottom:5}}>DEBT TYPE</div>
            <select value={d.type} onChange={e=>set("type",e.target.value)}
              style={{width:"100%",background:T.surf2,border:`1px solid ${T.border2}`,borderRadius:9,color:T.text,padding:"10px 12px",fontSize:14,fontWeight:600}}>
              {[["credit_card","Credit Card"],["mortgage","Mortgage"],["auto","Auto Loan"],["personal","Personal Loan"],["student","Student Loan"],["heloc","HELOC / LOC"],["medical","Medical"],["other","Other"]].map(([v,l])=><option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="grid-2">
            <Input label="Current Balance" value={d.balance} onChange={e=>set("balance",e.target.value)} type="number" prefix="$"/>
            <Input label="Interest Rate" value={d.rate} onChange={e=>set("rate",e.target.value)} type="number" suffix="%"/>
          </div>
          <Input label="Minimum Payment" value={d.min} onChange={e=>set("min",e.target.value)} type="number" prefix="$"/>
          <div>
            <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:1.5,marginBottom:8}}>COLOR</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {CARD_COLORS.map(c=>(
                <div key={c} onClick={()=>set("color",c)} style={{width:28,height:28,borderRadius:"50%",background:c,border:`2px solid ${d.color===c?"#fff":"transparent"}`,cursor:"pointer",transition:"border .15s"}}/>
              ))}
            </div>
          </div>
          <button className="btn" onClick={()=>{if(d.name&&d.balance&&d.rate&&d.min){onSave({...d,balance:+d.balance,rate:+d.rate,min:+d.min});onClose();}}}
            style={{background:`linear-gradient(135deg,${T.green},${T.teal})`,color:T.bg,padding:"14px",borderRadius:12,fontSize:14,marginTop:4}}>
            {debt?"Save Changes":"Add Debt"}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ══════════════════════════════════════════════════════
   MAIN APP
══════════════════════════════════════════════════════ */
export default function App() {

  /* ── TIER ─────────────────────────────────────────── */
  const [isPro, setIsPro]           = useLocalStorage("vd_isPro", false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [upgradeFeature, setUpgradeFeature] = useState("");

  /* ── NAV ──────────────────────────────────────────── */
  const [tab, setTab] = useLocalStorage("vd_tab", "dashboard");

  /* ── FREE TIER STATE (persisted) ──────────────────── */
  const [debts, setDebts] = useLocalStorage("vd_debts", [
    {id:"d1",name:"BOA Visa",    type:"credit_card",balance:14200,rate:26.99,min:284,color:T.red},
    {id:"d2",name:"Chase Card",  type:"credit_card",balance:12800,rate:24.99,min:256,color:T.orange},
    {id:"d3",name:"Citi CC",     type:"credit_card",balance:11500,rate:22.99,min:230,color:T.yellow},
    {id:"d4",name:"Delta Amex",  type:"credit_card",balance:8600, rate:20.99,min:172,color:T.blue},
    {id:"d5",name:"Personal LOC",type:"personal",   balance:15000,rate:9.99, min:250,color:T.teal},
  ]);
  const [method,   setMethod]   = useLocalStorage("vd_method", "avalanche");
  const [extra,    setExtra]    = useLocalStorage("vd_extra",  500);
  const [income,   setIncome]   = useLocalStorage("vd_income", 14163);
  const [expenses, setExpenses] = useLocalStorage("vd_expenses", 8200);

  const [showDebtModal, setShowDebtModal] = useState(false);
  const [editDebt, setEditDebt]           = useState(null);

  /* ── PRO TIER STATE (persisted) ───────────────────── */
  const [heloc,   setHeloc]  = useLocalStorage("vd_heloc",   {limit:15000,balance:15000,rate:9.99});
  const [policy,  setPolicy] = useLocalStorage("vd_policy",  {type:"IUL",carrier:"National Life",annualPremium:12000});
  const [client,  setClient] = useLocalStorage("vd_client",  {age:42,retireAge:65,name:"My Client"});

  const [illustration] = useState(()=>buildIllustration(12000,40));
  const [aiResult,  setAiResult]  = useState(null);
  const [aiStage,   setAiStage]   = useState("idle");
  const [csvText,   setCsvText]   = useState("");
  const [creditScore,    setCreditScore]    = useState(null);
  const [creditProvider, setCreditProvider] = useState(null);
  const fileRef = useRef();

  /* ── SIMULATIONS ──────────────────────────────────── */
  const validDebts = useMemo(()=>debts.filter(d=>d.balance>0&&d.rate>0&&d.min>0),[debts]);
  const simAva  = useMemo(()=>runAvalanche(validDebts,extra),[validDebts,extra]);
  const simSnow = useMemo(()=>runSnowball(validDebts,extra),[validDebts,extra]);
  const simBase = useMemo(()=>runBaseline(validDebts),[validDebts]);
  const simVel  = useMemo(()=>isPro?runVelocity({debts:validDebts,income,livingExp:expenses,heloc}):simAva,[validDebts,income,expenses,heloc,isPro,simAva]);

  const activeSim = method==="snowball"?simSnow:simAva;
  const totalDebt = validDebts.reduce((s,d)=>s+d.balance,0);
  const totalMin  = validDebts.reduce((s,d)=>s+d.min,0);
  const intSaved  = simBase.totalInt - activeSim.totalInt;
  const moFaster  = simBase.months   - activeSim.months;

  const yearToRetire = client.retireAge-client.age;
  const cvAtRetire   = illustration[Math.min(yearToRetire-1,illustration.length-1)]?.cashValue||0;
  const dbAtRetire   = illustration[Math.min(yearToRetire-1,illustration.length-1)]?.deathBenefit||0;

  /* ── GATE PRO ─────────────────────────────────────── */
  const gate = (feature, fn) => {
    if(isPro) fn();
    else { setUpgradeFeature(feature); setShowUpgrade(true); }
  };

  /* ── STRIPE UPGRADE HANDLERS ─────────────────────── */
  const handleUpgradeMonthly = () => {
    if (STRIPE_MONTHLY_URL) {
      window.open(STRIPE_MONTHLY_URL, '_blank');
    } else {
      // Demo mode: activate Pro locally until Stripe is configured
      setIsPro(true);
      setShowUpgrade(false);
    }
  };

  const handleUpgradeYearly = () => {
    if (STRIPE_YEARLY_URL) {
      window.open(STRIPE_YEARLY_URL, '_blank');
    } else {
      setIsPro(true);
      setShowUpgrade(false);
    }
  };

  /* ── AI IMPORT — calls secure serverless function ─── */
  const runAI = async (text) => {
    setAiStage("analyzing");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 8000) }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json();
      const txt  = data.content?.map(c=>c.text||"").join("")||"";
      const clean = txt.replace(/```json|```/g,"").trim();
      const parsed = JSON.parse(clean);
      const newDebts = [
        ...(parsed.creditCards||[]).map((c,i)=>({id:uid(),name:c.name,type:"credit_card",balance:c.balance,rate:c.rate,min:c.min,color:CARD_COLORS[i%CARD_COLORS.length]})),
        ...(parsed.loans||[]).map((c,i)=>({id:uid(),name:c.name,type:"personal",balance:c.balance,rate:c.rate,min:c.min,color:CARD_COLORS[(i+5)%CARD_COLORS.length]})),
        ...(parsed.mortgage?[{id:uid(),name:"Mortgage",type:"mortgage",balance:parsed.mortgage.balance,rate:parsed.mortgage.rate,min:parsed.mortgage.payment,color:T.teal}]:[]),
      ];
      if(parsed.monthlyIncome) setIncome(parsed.monthlyIncome);
      if(newDebts.length>0) setDebts(newDebts);
      setAiResult(parsed);
      setAiStage("done");
      setTab("dashboard");
    } catch(e) {
      setAiStage("idle");
      alert("AI parsing failed. Check your data and try again.");
    }
  };

  /* ── BOTTOM NAV ITEMS ─────────────────────────────── */
  const NAV = [
    {id:"dashboard",icon:"📊",label:"Dashboard"},
    {id:"debts",    icon:"💳",label:"Debts"},
    {id:"strategy", icon:"⚡",label:"Strategy"},
    {id:"numbers",  icon:"🔢",label:"Numbers"},
    ...(isPro?[{id:"iul",icon:"🛡️",label:"IUL/WL"},{id:"retire",icon:"🌴",label:"Retire"}]:[]),
  ];
  const PRO_NAV = isPro?[
    {id:"import",icon:"🤖",label:"AI Import"},
    {id:"compare",icon:"⚖️",label:"Compare"},
  ]:[];
  const ALL_NAV = [...NAV,...PRO_NAV];

  /* ─────────────────────────────────────────────────────
     RENDERS
  ───────────────────────────────────────────────────── */

  /* ── DASHBOARD ────────────────────────────────────── */
  const renderDashboard = () => (
    <div className="fu">
      {/* Hero */}
      <Card accent={T.red} style={{padding:"20px 18px",marginBottom:12}}>
        <div style={{position:"absolute",top:-40,right:-30,width:180,height:180,background:`radial-gradient(circle,${T.red}0C,transparent 70%)`,pointerEvents:"none"}}/>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:9,color:T.red,fontWeight:800,letterSpacing:2,marginBottom:6}}>🎯 YOUR DEBT MISSION</div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:"clamp(38px,10vw,64px)",color:T.text,letterSpacing:1,lineHeight:.95}}>{$c(totalDebt)}</div>
            <div style={{fontSize:12,color:T.dim,marginTop:5}}>
              {validDebts.length} debts · {$c(totalMin)}/mo minimums
            </div>
          </div>
          <div style={{textAlign:"right",flexShrink:0}}>
            <div style={{fontSize:9,color:T.green,fontWeight:800,letterSpacing:1,marginBottom:3}}>DEBT-FREE</div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:T.green,letterSpacing:1}}>{addMo(activeSim.months)}</div>
            <div style={{fontSize:11,color:T.dim}}>{fmt(activeSim.months)}</div>
          </div>
        </div>

        {/* Method toggle */}
        <div style={{display:"flex",gap:6,background:T.bg,borderRadius:10,padding:4,marginTop:14}}>
          {[["avalanche","🔥 Avalanche"],["snowball","⛄ Snowball"]].map(([id,lbl])=>(
            <button key={id} onClick={()=>setMethod(id)} className="btn"
              style={{flex:1,padding:"9px",borderRadius:7,background:method===id?T.surf2:"transparent",color:method===id?T.text:T.muted,fontSize:12,fontWeight:method===id?800:600,transition:"all .2s"}}>
              {lbl}
            </button>
          ))}
          {isPro&&(
            <button onClick={()=>setTab("strategy")} className="btn"
              style={{flex:1,padding:"9px",borderRadius:7,background:T.surf2,color:T.gold,fontSize:12,fontWeight:800}}>
              ⚡ Velocity
            </button>
          )}
        </div>

        {/* Extra payment slider */}
        <div style={{marginTop:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
            <span style={{fontSize:11,color:T.dim}}>Extra monthly payment</span>
            <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:14,color:T.green,fontWeight:700}}>{$c(extra)}/mo</span>
          </div>
          <input type="range" min={0} max={3000} step={50} value={extra} onChange={e=>setExtra(+e.target.value)}
            style={{accentColor:T.green}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:T.muted,marginTop:3}}>
            <span>$0</span><span>$1,500</span><span>$3,000</span>
          </div>
        </div>
      </Card>

      {/* KPI row */}
      <div style={{display:"flex",gap:8,marginBottom:12,overflowX:"auto",paddingBottom:2}}>
        <StatBox label="Method" value={method==="avalanche"?"Avalanche":"Snowball"} color={method==="avalanche"?T.red:T.blue} small/>
        <StatBox label="Int Saved" value={$c(intSaved)} color={T.green} small/>
        <StatBox label="Months Faster" value={fmt(moFaster)} color={T.orange} small/>
      </div>

      {/* Trajectory */}
      <Card accent={T.green} style={{padding:"16px 16px 10px",marginBottom:12}}>
        <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:10}}>PAYOFF TRAJECTORY</div>
        <Spark snaps={activeSim.snaps} color={T.green} h={90}/>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:T.muted,marginTop:6}}>
          <span>Today</span>
          <span style={{color:T.green,fontWeight:800}}>{addMo(activeSim.months)} · {method==="avalanche"?"Avalanche":"Snowball"}</span>
        </div>
      </Card>

      {/* Attack order preview */}
      <Card accent={T.red} style={{padding:"16px",marginBottom:12}}>
        <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:10}}>
          {method==="avalanche"?"⚔️ ATTACK ORDER — HIGHEST RATE FIRST":"⛄ ATTACK ORDER — SMALLEST BALANCE FIRST"}
        </div>
        {[...validDebts].sort((a,b)=>method==="avalanche"?b.rate-a.rate:a.balance-b.balance).slice(0,4).map((d,i)=>(
          <div key={d.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:`1px solid ${T.border}`}}>
            <div style={{width:26,height:26,borderRadius:"50%",background:`${d.color}18`,border:`1px solid ${d.color}44`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue',sans-serif",fontSize:13,color:d.color,flexShrink:0}}>{i+1}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:13,color:i===0?T.text:T.dim,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.name}</div>
              <div style={{fontSize:10,color:T.muted}}>{d.rate}% APR · min {$c(d.min)}/mo</div>
            </div>
            <div style={{textAlign:"right",flexShrink:0}}>
              <div style={{fontFamily:"'JetBrains Mono',monospace",color:d.color,fontWeight:700,fontSize:14}}>{$c(d.balance)}</div>
              {i===0&&<Tag label="ATTACK" color={T.red}/>}
            </div>
          </div>
        ))}
        {validDebts.length>4&&<div style={{fontSize:11,color:T.muted,marginTop:8,textAlign:"center"}}>+{validDebts.length-4} more debts →</div>}
      </Card>

      {/* Pro upsell */}
      {!isPro&&(
        <button className="btn gold-glow" onClick={()=>setShowUpgrade(true)}
          style={{width:"100%",background:`linear-gradient(135deg,${T.gold}22,${T.goldL}11)`,border:`1px solid ${T.gold}44`,borderRadius:14,padding:"16px",display:"flex",alignItems:"center",gap:14,textAlign:"left",marginBottom:12}}>
          <div style={{fontSize:32,flexShrink:0}}>🚀</div>
          <div style={{flex:1}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:T.gold,letterSpacing:1,marginBottom:2}}>SUPERCHARGE WITH PRO</div>
            <div style={{fontSize:11,color:T.dim,lineHeight:1.5}}>AI CSV import · Velocity Banking · IUL strategy · Retirement planner</div>
          </div>
          <div style={{color:T.gold,fontSize:18,flexShrink:0}}>→</div>
        </button>
      )}

      {isPro&&aiResult&&(
        <Card accent={T.gold} style={{padding:"14px 16px",marginBottom:12}}>
          <div style={{fontSize:9,color:T.gold,fontWeight:800,letterSpacing:2,marginBottom:8}}>🤖 AI INSIGHTS</div>
          {aiResult.insights?.slice(0,3).map((ins,i)=>(
            <div key={i} style={{fontSize:12,color:T.dim,marginBottom:6,paddingLeft:8,borderLeft:`2px solid ${T.gold}44`}}>💡 {ins}</div>
          ))}
          {aiResult.opportunities?.slice(0,2).map((op,i)=>(
            <div key={i} style={{fontSize:12,color:T.green,marginBottom:4}}>✂️ {op}</div>
          ))}
        </Card>
      )}
    </div>
  );

  /* ── DEBTS TAB ─────────────────────────────────────── */
  const renderDebts = () => (
    <div className="fu">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div>
          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,color:T.text,letterSpacing:1}}>MY DEBTS</div>
          <div style={{fontSize:11,color:T.dim}}>{debts.length} accounts · {$c(totalDebt)} total</div>
        </div>
        <button className="btn" onClick={()=>{setEditDebt(null);setShowDebtModal(true);}}
          style={{background:`${T.green}18`,border:`1px solid ${T.green}33`,color:T.green,padding:"9px 16px",borderRadius:10,fontSize:13,display:"flex",alignItems:"center",gap:6}}>
          + Add
        </button>
      </div>

      {debts.map((d)=>{
        const monthly=d.balance*(d.rate/100/12);
        return (
          <Card key={d.id} accent={d.color} style={{padding:"14px 16px",marginBottom:8}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:40,height:40,borderRadius:11,background:`${d.color}18`,border:`1px solid ${d.color}33`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>
                {d.type==="credit_card"?"💳":d.type==="mortgage"?"🏡":d.type==="auto"?"🚗":"💰"}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:14,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.name}</div>
                <div style={{fontSize:10,color:T.muted}}>{d.type.replace("_"," ")} · {d.rate}% APR</div>
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                <div style={{fontFamily:"'JetBrains Mono',monospace",color:d.color,fontWeight:800,fontSize:16}}>{$c(d.balance)}</div>
                <div style={{fontSize:10,color:T.red}}>{$c(monthly)}/mo interest</div>
              </div>
            </div>
            <div style={{display:"flex",gap:8,marginTop:10,alignItems:"center"}}>
              <div style={{flex:1,height:4,background:T.border2,borderRadius:2}}>
                <div style={{width:`${Math.min(100,(d.balance/totalDebt)*100)}%`,height:"100%",background:d.color,borderRadius:2,opacity:.8}}/>
              </div>
              <span style={{fontSize:9,color:T.muted,flexShrink:0}}>min {$c(d.min)}/mo</span>
              <button className="btn hov" onClick={()=>{setEditDebt(d);setShowDebtModal(true);}}
                style={{background:T.border2,color:T.muted,padding:"4px 10px",borderRadius:6,fontSize:11}}>Edit</button>
              <button className="btn hov" onClick={()=>setDebts(ds=>ds.filter(x=>x.id!==d.id))}
                style={{background:`${T.red}18`,color:T.red,padding:"4px 10px",borderRadius:6,fontSize:11}}>✕</button>
            </div>
          </Card>
        );
      })}

      {/* CSV/AI import — Pro gated */}
      <div style={{marginTop:16}}>
        <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:10}}>IMPORT YOUR DATA</div>
        <button className="btn hov" onClick={()=>gate("AI CSV Import — Upload your bank or Monarch Money export and let AI read everything automatically","AI CSV/Excel Import")}
          style={{width:"100%",background:`${T.gold}10`,border:`2px dashed ${T.gold}44`,borderRadius:14,padding:"20px 16px",display:"flex",flexDirection:"column",alignItems:"center",gap:8,cursor:"pointer",marginBottom:8}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:28}}>🤖</span>
            <div style={{textAlign:"left"}}>
              <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:17,color:T.gold,letterSpacing:1}}>AI IMPORT — UPLOAD CSV OR EXCEL</div>
              <div style={{fontSize:11,color:T.dim}}>AI reads your file and loads everything automatically</div>
            </div>
            <Tag label="PRO" color={T.gold}/>
          </div>
        </button>
        <div style={{fontSize:11,color:T.muted,textAlign:"center"}}>Free plan: enter debts manually above ↑</div>
      </div>
    </div>
  );

  /* ── STRATEGY TAB ──────────────────────────────────── */
  const renderStrategy = () => (
    <div className="fu">
      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,color:T.text,letterSpacing:1,marginBottom:4}}>STRATEGY</div>
      <div style={{fontSize:12,color:T.dim,marginBottom:14}}>Compare debt payoff methods</div>

      <Card accent={T.blue} style={{padding:"16px",marginBottom:12}}>
        <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:10}}>PAYOFF METHOD</div>
        {[
          {id:"avalanche",icon:"🔥",title:"Debt Avalanche",desc:"Attack highest interest rate first. Saves the most money.",color:T.red,sim:simAva},
          {id:"snowball", icon:"⛄",title:"Debt Snowball", desc:"Attack smallest balance first. Fastest psychological wins.",color:T.blue,sim:simSnow},
        ].map(m=>(
          <div key={m.id} onClick={()=>setMethod(m.id)} className="hov"
            style={{background:method===m.id?`${m.color}12`:T.surf2,border:`1px solid ${method===m.id?m.color+"44":T.border}`,borderRadius:12,padding:"14px",marginBottom:8,cursor:"pointer",transition:"all .2s"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:method===m.id?10:0}}>
              <span style={{fontSize:22}}>{m.icon}</span>
              <div style={{flex:1}}>
                <div style={{fontWeight:800,fontSize:14,color:method===m.id?T.text:T.dim}}>{m.title}</div>
                <div style={{fontSize:11,color:T.muted,marginTop:2}}>{m.desc}</div>
              </div>
              {method===m.id&&<Tag label="ACTIVE" color={m.color}/>}
            </div>
            {method===m.id&&(
              <div style={{display:"flex",gap:8}}>
                <StatBox label="Debt Free" value={addMo(m.sim.months)} color={m.color} small/>
                <StatBox label="Total Interest" value={$c(m.sim.totalInt)} color={T.red} small/>
              </div>
            )}
          </div>
        ))}
      </Card>

      <Card accent={T.muted} style={{padding:"16px",marginBottom:12}}>
        <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:12}}>SIDE BY SIDE</div>
        <div className="grid-2" style={{marginBottom:10}}>
          {[
            {label:"🔥 Avalanche",months:simAva.months,int:simAva.totalInt,color:T.red},
            {label:"⛄ Snowball",  months:simSnow.months,int:simSnow.totalInt,color:T.blue},
          ].map((s,i)=>(
            <div key={i} style={{background:T.surf2,borderRadius:10,padding:"12px",border:`1px solid ${s.color}22`}}>
              <div style={{fontSize:11,color:s.color,fontWeight:800,marginBottom:8}}>{s.label}</div>
              <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:T.text}}>{fmt(s.months)}</div>
              <div style={{fontSize:10,color:T.dim}}>debt free</div>
              <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:13,color:T.red,marginTop:6}}>{$c(s.int)}</div>
              <div style={{fontSize:10,color:T.dim}}>total interest</div>
            </div>
          ))}
        </div>
        <Spark snaps={activeSim.snaps} color={method==="avalanche"?T.red:T.blue} h={70}/>
      </Card>

      <Card accent={T.gold} style={{padding:"16px",marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
          <div style={{flex:1}}>
            <div style={{fontSize:9,color:T.gold,fontWeight:800,letterSpacing:2,marginBottom:6}}>⚡ VELOCITY BANKING</div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:T.text,letterSpacing:1,marginBottom:6}}>USE YOUR INCOME AS A WEAPON</div>
            <div style={{fontSize:12,color:T.dim,lineHeight:1.7,marginBottom:10}}>
              Deposit every paycheck into your HELOC/LOC. Pay expenses from it. Then deploy chunk payments to annihilate principal. Every dollar you earn reduces interest every single day.
            </div>
            {isPro?(
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <StatBox label="Velocity Free" value={addMo(simVel.months)} color={T.gold} small/>
                <StatBox label="vs Baseline" value={fmt(simBase.months-simVel.months)+" faster"} color={T.green} small/>
              </div>
            ):(
              <button className="btn gold-glow" onClick={()=>setShowUpgrade(true)}
                style={{background:`linear-gradient(135deg,${T.gold},${T.goldL})`,color:"#05060F",padding:"12px 20px",borderRadius:10,fontSize:13}}>
                Unlock Velocity Banking →
              </button>
            )}
          </div>
        </div>
      </Card>

      <Card accent={T.green} style={{padding:"16px"}}>
        <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:12}}>CASH FLOW SETTINGS</div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <Input label="Monthly Income" value={income} onChange={e=>setIncome(+e.target.value||0)} type="number" prefix="$"/>
          <Input label="Monthly Expenses" value={expenses} onChange={e=>setExpenses(+e.target.value||0)} type="number" prefix="$"/>
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <span style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:1.5}}>EXTRA PAYMENT / MONTH</span>
              <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:14,color:T.green,fontWeight:700}}>{$c(extra)}/mo</span>
            </div>
            <input type="range" min={0} max={3000} step={50} value={extra} onChange={e=>setExtra(+e.target.value)}/>
          </div>
          <div style={{background:T.surf2,borderRadius:10,padding:"10px 12px",display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:12,color:T.dim}}>Net cashflow after minimums</span>
            <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:14,color:(income-expenses-totalMin)>=0?T.green:T.red,fontWeight:700}}>
              {$c(income-expenses-totalMin)}/mo
            </span>
          </div>
        </div>
      </Card>
    </div>
  );

  /* ── NUMBERS TAB ───────────────────────────────────── */
  const renderNumbers = () => {
    const dti = income>0?(totalMin/income)*100:0;
    const net  = income-expenses-totalMin;
    const dtiColor = dti<=36?T.green:dti<=43?T.yellow:T.red;
    return (
    <div className="fu">
      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,color:T.text,letterSpacing:1,marginBottom:4}}>KNOW YOUR NUMBERS</div>
      <div style={{fontSize:12,color:T.dim,marginBottom:14}}>Your complete financial picture</div>

      <Card accent={T.green} style={{padding:"16px",marginBottom:12}}>
        <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:12}}>💰 MONTHLY BUDGET</div>
        {[
          {label:"Monthly Income",value:$c(income),color:T.green,sign:"+"},
          {label:"Debt Minimums",value:$c(totalMin),color:T.red,sign:"-"},
          {label:"Living Expenses",value:$c(expenses),color:T.orange,sign:"-"},
        ].map((row,i)=>(
          <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:`1px solid ${T.border}`}}>
            <span style={{fontSize:13,color:T.dim}}>{row.label}</span>
            <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:15,fontWeight:700,color:row.color}}>{row.sign}{row.value}</span>
          </div>
        ))}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 0",marginTop:2}}>
          <span style={{fontWeight:800,fontSize:14,color:T.text}}>⚡ Net Cashflow</span>
          <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:20,fontWeight:800,color:net>=0?T.green:T.red}}>{net>=0?"+":""}{$c(net)}</span>
        </div>
        <div style={{display:"flex",height:8,borderRadius:4,overflow:"hidden",gap:1}}>
          <div style={{width:`${Math.min(100,income>0?(totalMin/income)*100:0)}%`,background:T.red,borderRadius:"4px 0 0 4px"}}/>
          <div style={{width:`${Math.min(100,income>0?(expenses/income)*100:0)}%`,background:T.orange}}/>
          <div style={{flex:1,background:T.green,borderRadius:"0 4px 4px 0"}}/>
        </div>
        <div style={{display:"flex",gap:12,marginTop:6,flexWrap:"wrap"}}>
          {[{c:T.red,l:"Debt"},{c:T.orange,l:"Expenses"},{c:T.green,l:"Available"}].map((x,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:10,height:10,borderRadius:2,background:x.c}}/><span style={{fontSize:10,color:T.muted}}>{x.l}</span></div>
          ))}
        </div>
      </Card>

      <Card accent={T.purple} style={{padding:"16px",marginBottom:12}}>
        <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:12}}>📐 DEBT-TO-INCOME RATIO</div>
        <div style={{display:"flex",gap:12,alignItems:"center",marginBottom:14,flexWrap:"wrap"}}>
          <div style={{textAlign:"center",minWidth:100}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:52,color:dtiColor,letterSpacing:2,lineHeight:1}}>{dti.toFixed(1)}%</div>
            <Tag label={dti<=36?"EXCELLENT":dti<=43?"MANAGEABLE":"HIGH RISK"} color={dtiColor}/>
          </div>
          <div style={{flex:1,minWidth:160}}>
            <div style={{height:12,borderRadius:6,overflow:"hidden",marginBottom:8,position:"relative"}}>
              <div style={{position:"absolute",inset:0,background:`linear-gradient(90deg,${T.green} 0%,${T.green} 36%,${T.yellow} 36%,${T.yellow} 43%,${T.orange} 43%,${T.orange} 50%,${T.red} 50%)`}}/>
              <div style={{position:"absolute",top:0,bottom:0,left:`${Math.min(98,dti*2)}%`,width:3,background:"#fff",boxShadow:"0 0 4px rgba(0,0,0,.8)"}}/>
            </div>
            {[{r:"< 36%",l:"Perfect",c:T.green,a:dti<36},{r:"36–41%",l:"Good",c:T.yellow,a:dti>=36&&dti<=41},{r:"42%+",l:"High Risk",c:T.red,a:dti>=42}].map((tier,i)=>(
              <div key={i} style={{display:"flex",gap:8,alignItems:"center",padding:"5px 0"}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:tier.c,flexShrink:0}}/>
                <span style={{fontSize:11,color:tier.a?T.text:T.muted,fontWeight:tier.a?700:400}}><strong style={{color:tier.c}}>{tier.r}</strong> — {tier.l}</span>
                {tier.a&&<Tag label="YOU" color={tier.c}/>}
              </div>
            ))}
          </div>
        </div>
        {dti>36&&(
          <div style={{background:"#080C1A",border:`1px solid ${T.blue}22`,borderRadius:10,padding:"12px"}}>
            <div style={{fontSize:11,color:T.dim,lineHeight:1.7}}>
              🎯 To reach perfect DTI (36%), reduce monthly debt payments from <strong style={{color:T.red}}>{$c(totalMin)}</strong> to <strong style={{color:T.green}}>{$c(income*0.36)}</strong> — eliminate <strong style={{color:T.yellow}}>{$c(totalMin-income*0.36)}/mo</strong> in payments.
            </div>
          </div>
        )}
      </Card>

      <Card accent={T.purple} style={{padding:"16px",marginBottom:12}}>
        <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:12}}>📊 CREDIT SCORE</div>
        {creditScore&&(
          <div style={{marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
              <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:52,lineHeight:1,color:creditScore>=740?T.green:creditScore>=670?T.yellow:T.red}}>{creditScore}</div>
              <div>
                <Tag label={creditScore>=800?"EXCEPTIONAL":creditScore>=740?"VERY GOOD":creditScore>=670?"GOOD":creditScore>=580?"FAIR":"POOR"} color={creditScore>=740?T.green:creditScore>=670?T.yellow:T.red}/>
                <div style={{fontSize:11,color:T.dim,marginTop:4}}>via {creditProvider}</div>
              </div>
            </div>
            <div style={{position:"relative",height:10,borderRadius:5,background:`linear-gradient(90deg,${T.red},${T.orange},${T.yellow},${T.green})`,marginBottom:4}}>
              <div style={{position:"absolute",top:-4,left:`${Math.min(95,((creditScore-300)/550)*100)}%`,width:18,height:18,borderRadius:"50%",background:"#fff",border:`3px solid ${creditScore>=740?T.green:T.yellow}`,transform:"translateX(-50%)",boxShadow:"0 2px 6px rgba(0,0,0,.5)"}}/>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:T.muted}}>
              <span>300</span><span>580</span><span>670</span><span>740</span><span>800+</span>
            </div>
          </div>
        )}
        <div className="grid-2">
          {[{name:"Credit Karma",icon:"💚",color:"#00D166",score:718,p:"Credit Karma"},{name:"Experian",icon:"🔵",color:T.blue,score:724,p:"Experian"},{name:"TransUnion",icon:"🟢",color:T.teal,score:711,p:"TransUnion"},{name:"Equifax",icon:"🟡",color:T.yellow,score:720,p:"Equifax"}].map(b=>(
            <button key={b.name} className="btn hov" onClick={()=>{setCreditScore(b.score);setCreditProvider(b.p);}}
              style={{background:creditProvider===b.p?`${b.color}18`:T.surf2,border:`1px solid ${creditProvider===b.p?b.color:T.border}`,borderRadius:10,padding:"12px",textAlign:"center",transition:"all .2s"}}>
              <div style={{fontSize:22,marginBottom:4}}>{b.icon}</div>
              <div style={{fontWeight:800,fontSize:11,color:creditProvider===b.p?b.color:T.text,marginBottom:2}}>{b.name}</div>
              <div style={{fontSize:10,color:creditProvider===b.p?b.color:T.muted}}>{creditProvider===b.p?b.score:"Connect →"}</div>
            </button>
          ))}
        </div>
      </Card>

      <HomeSim income={income} totalMin={totalMin}/>
    </div>
    );
  };

  /* ── IUL TAB (PRO) ─────────────────────────────────── */
  const renderIUL = () => (
    <div className="fu">
      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,color:T.gold,letterSpacing:1,marginBottom:4}}>IUL / WHOLE LIFE STRATEGY</div>
      <div style={{fontSize:12,color:T.dim,marginBottom:14}}>Your policy as a personal bank + wealth engine</div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
        {[
          {icon:"💀",title:"Death Protection",desc:`DB grows to ${$c(dbAtRetire)} by retirement`,color:T.blue},
          {icon:"🏦",title:"Personal Bank",desc:`Borrow ${$c(illustration[2]?.loanValue||0)} tax-free in Yr 3`,color:T.gold},
          {icon:"📈",title:"Tax-Free Growth",desc:`${$c(cvAtRetire)} cash value at age ${client.retireAge}`,color:T.green},
          {icon:"🌴",title:"Retirement Income",desc:`Policy loans = $0 income tax`,color:T.purple},
        ].map((p,i)=>(
          <div key={i} style={{background:T.surf2,border:`1px solid ${p.color}22`,borderRadius:12,padding:"14px 12px"}}>
            <div style={{fontSize:24,marginBottom:6}}>{p.icon}</div>
            <div style={{fontWeight:800,fontSize:12,color:p.color,marginBottom:4}}>{p.title}</div>
            <div style={{fontSize:11,color:T.muted,lineHeight:1.5}}>{p.desc}</div>
          </div>
        ))}
      </div>

      <Card accent={T.gold} style={{padding:"16px",marginBottom:12}}>
        <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:12}}>POLICY CONFIGURATION</div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div>
            <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:1.5,marginBottom:5}}>POLICY TYPE</div>
            <select value={policy.type} onChange={e=>setPolicy(p=>({...p,type:e.target.value}))}
              style={{width:"100%",background:T.surf2,border:`1px solid ${T.border2}`,borderRadius:9,color:T.gold,padding:"10px 12px",fontSize:14,fontWeight:700}}>
              {["IUL","Whole Life","VUL","CAUL"].map(o=><option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <Input label="Carrier" value={policy.carrier} onChange={e=>setPolicy(p=>({...p,carrier:e.target.value}))}/>
          <Input label="Annual Premium" value={policy.annualPremium} onChange={e=>setPolicy(p=>({...p,annualPremium:+e.target.value||0}))} type="number" prefix="$"/>
        </div>
      </Card>

      <Card accent={T.gold} style={{padding:"16px",marginBottom:12}}>
        <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:12}}>POLICY LOAN AVAILABILITY — YEAR BY YEAR</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(100px,1fr))",gap:6}}>
          {illustration.filter((_,i)=>i<12).map((row,i)=>(
            <div key={i} style={{background:T.bg,borderRadius:8,padding:"10px 8px",textAlign:"center",border:`1px solid ${T.border}`}}>
              <div style={{fontSize:9,color:T.muted,fontWeight:800}}>YR {row.year}</div>
              <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,color:T.gold,marginTop:3}}>{$c(row.loanValue)}</div>
              <div style={{fontSize:9,color:T.dim,marginTop:2}}>borrow</div>
            </div>
          ))}
        </div>
      </Card>

      <Card accent={T.green} style={{padding:"16px"}}>
        <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:10}}>CASH VALUE GROWTH</div>
        <Spark snaps={illustration.map(r=>({month:r.year*12,total:r.cashValue}))} color={T.gold} h={100}/>
        <div style={{display:"flex",gap:8,marginTop:10,flexWrap:"wrap"}}>
          <StatBox label="@ Age 55" value={$c(illustration[12]?.cashValue||0)} color={T.gold} small/>
          <StatBox label="@ Retire" value={$c(cvAtRetire)} color={T.green} small/>
          <StatBox label="Death Benefit" value={$c(dbAtRetire)} color={T.blue} small/>
        </div>
      </Card>
    </div>
  );

  /* ── RETIRE TAB (PRO) ──────────────────────────────── */
  const renderRetire = () => {
    const retireIncome = cvAtRetire*0.05;
    return (
    <div className="fu">
      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,color:T.green,letterSpacing:1,marginBottom:4}}>RETIREMENT INCOME</div>
      <div style={{fontSize:12,color:T.dim,marginBottom:14}}>Tax-free policy loan income for life</div>

      <Card accent={T.green} style={{padding:"18px 16px",marginBottom:12}}>
        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:14,color:T.muted,letterSpacing:2,marginBottom:4}}>STARTING AT AGE {client.retireAge}</div>
        <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:44,color:T.green,letterSpacing:1,lineHeight:1}}>{$c(retireIncome/12)}</div>
        <div style={{fontSize:12,color:T.dim}}>per month · tax-free · for life</div>
        <div style={{fontSize:12,color:T.dim,marginTop:3}}>{$c(retireIncome)}/year in policy loans</div>
        <div style={{background:`${T.green}12`,border:`1px solid ${T.green}22`,borderRadius:10,padding:"10px 12px",marginTop:12,fontSize:12,color:T.green}}>
          💡 Policy loans are NOT taxable income. The IRS treats them as debt, not earnings. Your money grows tax-deferred, and you retire tax-free.
        </div>
      </Card>

      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <StatBox label="Policy Value @ Retire" value={$c(cvAtRetire)} color={T.gold}/>
        <StatBox label="Death Benefit" value={$c(dbAtRetire)} color={T.blue}/>
      </div>

      <Card accent={T.gold} style={{padding:"16px",marginBottom:12}}>
        <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:12}}>RETIREMENT YEAR BY YEAR</div>
        {Array.from({length:10},(_,i)=>{
          const policyYr=yearToRetire+i;
          const cv=illustration[Math.min(policyYr,illustration.length-1)]?.cashValue||0;
          const loanBal=(retireIncome/0.95)*i*1.05;
          return (
            <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:`1px solid ${T.border}`}}>
              <div>
                <div style={{fontSize:12,fontWeight:700,color:T.text}}>Age {client.retireAge+i}</div>
                <div style={{fontSize:10,color:T.muted}}>Policy Yr {policyYr+1}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:13,color:T.green,fontWeight:700}}>{$c(retireIncome/12)}/mo</div>
                <div style={{fontSize:10,color:T.dim}}>CV: {$c(cv)}</div>
              </div>
            </div>
          );
        })}
      </Card>

      <Card accent={T.muted} style={{padding:"16px"}}>
        <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:12}}>CLIENT PROFILE</div>
        <div className="grid-2">
          <Input label="Current Age" value={client.age} onChange={e=>setClient(p=>({...p,age:+e.target.value||0}))} type="number"/>
          <Input label="Retire At Age" value={client.retireAge} onChange={e=>setClient(p=>({...p,retireAge:+e.target.value||0}))} type="number"/>
        </div>
      </Card>
    </div>
    );
  };

  /* ── AI IMPORT (PRO) ───────────────────────────────── */
  const renderImport = () => (
    <div className="fu">
      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,color:T.gold,letterSpacing:1,marginBottom:4}}>AI IMPORT</div>
      <div style={{fontSize:12,color:T.dim,marginBottom:14}}>Upload your bank file or paste CSV — AI does the rest</div>

      {aiStage==="analyzing"&&(
        <Card accent={T.green} style={{padding:"32px 16px",textAlign:"center",marginBottom:12}}>
          <div style={{fontSize:44,marginBottom:12}} className="spin">⚡</div>
          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:T.text,letterSpacing:2,marginBottom:8}}>AI IS READING YOUR DATA</div>
          <div style={{fontSize:12,color:T.dim}} className="pulse">Analyzing accounts, debts, income patterns...</div>
        </Card>
      )}

      {aiStage!=="analyzing"&&(
        <>
          <button className="btn" onClick={()=>fileRef.current.click()}
            style={{width:"100%",background:`${T.gold}10`,border:`2px dashed ${T.gold}44`,borderRadius:14,padding:"28px 16px",display:"flex",flexDirection:"column",alignItems:"center",gap:10,marginBottom:12,cursor:"pointer"}}>
            <input ref={fileRef} type="file" accept=".csv,.txt,.xlsx" style={{display:"none"}} onChange={async e=>{
              const f=e.target.files[0]; if(!f) return;
              const txt=await f.text(); runAI(txt);
            }}/>
            <div style={{fontSize:40}}>📁</div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:T.gold,letterSpacing:1}}>UPLOAD YOUR FILE</div>
            <div style={{fontSize:12,color:T.dim,textAlign:"center"}}>CSV · Excel · Monarch Money · Chase · Bank of America · Any bank export</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",justifyContent:"center"}}>
              {["Monarch","Chase","BOA","Mint","YNAB","Any Bank"].map(b=><Tag key={b} label={b} color={T.gold}/>)}
            </div>
          </button>

          <Card accent={T.blue} style={{padding:"16px",marginBottom:12}}>
            <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:10}}>OR PASTE CSV DATA</div>
            <textarea value={csvText} onChange={e=>setCsvText(e.target.value)}
              placeholder={"Paste your transaction data here...\n\nDate, Merchant, Amount\n2026-03-10, Chase Sapphire Payment, -284.00\n2026-03-01, Publix, -87.43\n..."}
              style={{width:"100%",height:140,background:T.surf2,border:`1px solid ${T.border2}`,borderRadius:10,color:T.text,padding:"12px",fontSize:12,lineHeight:1.6,fontFamily:"'JetBrains Mono',monospace",resize:"none"}}/>
            <button className="btn" onClick={()=>csvText.trim()&&runAI(csvText)} disabled={!csvText.trim()}
              style={{width:"100%",background:csvText.trim()?`linear-gradient(135deg,${T.green},${T.teal})`:T.border2,color:csvText.trim()?T.bg:T.muted,padding:"12px",borderRadius:10,fontSize:13,marginTop:10,opacity:csvText.trim()?1:.5}}>
              🤖 Analyze with AI →
            </button>
          </Card>

          <button className="btn glow" onClick={()=>runAI(`Date,Merchant,Category,Account,Amount\n2026-03-01,Chase Sapphire Payment,Credit Card Payment,Checking,-284.00\n2026-03-01,Bank of America CC Payment,Credit Card Payment,Checking,-256.00\n2026-03-15,Publix,Groceries,Checking,-127.43\n2026-03-10,AT&T,Phone,Checking,-161.00\n2026-03-05,Americo Life Insurance,Insurance,Checking,-450.00\n2026-02-15,Commission Payment,Income,Checking,14163.00\n2026-03-01,Mortgage Payment,Housing,Checking,-1850.00\n2026-03-01,Regions Bank Loan,Loan Payment,Checking,-500.00`)}
            style={{width:"100%",background:`linear-gradient(135deg,${T.green},${T.blue})`,color:T.bg,padding:"16px",borderRadius:12,fontSize:14,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
            <span>⚡</span>
            <span>Try Demo Data — No File Needed</span>
          </button>
        </>
      )}

      {aiResult&&aiStage==="done"&&(
        <Card accent={T.green} style={{padding:"16px",marginTop:12}}>
          <div style={{fontSize:9,color:T.green,fontWeight:800,letterSpacing:2,marginBottom:10}}>✓ AI IMPORT COMPLETE</div>
          <div style={{fontSize:13,color:T.dim,marginBottom:10}}>{aiResult.summary}</div>
          {aiResult.insights?.slice(0,3).map((ins,i)=>(
            <div key={i} style={{fontSize:12,color:T.dim,marginBottom:6,paddingLeft:8,borderLeft:`2px solid ${T.green}44`}}>💡 {ins}</div>
          ))}
          <button className="btn" onClick={()=>setTab("dashboard")}
            style={{width:"100%",background:`${T.green}18`,border:`1px solid ${T.green}33`,color:T.green,padding:"12px",borderRadius:10,fontSize:13,marginTop:8}}>
            View Dashboard →
          </button>
        </Card>
      )}
    </div>
  );

  /* ── COMPARE (PRO) ─────────────────────────────────── */
  const renderCompare = () => (
    <div className="fu">
      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,color:T.text,letterSpacing:1,marginBottom:4}}>SCENARIO COMPARISON</div>
      <div style={{fontSize:12,color:T.dim,marginBottom:14}}>Traditional vs Velocity + IUL</div>

      <div className="grid-2" style={{marginBottom:12}}>
        <Card accent={T.muted} style={{padding:"14px"}}>
          <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:1,marginBottom:8}}>SCENARIO A</div>
          <div style={{fontSize:11,color:T.dim,fontWeight:700,marginBottom:10}}>Minimum Payments + Savings</div>
          {[
            {l:"Debt-Free",v:addMo(simBase.months),c:T.red},
            {l:"Total Interest",v:$c(simBase.totalInt),c:T.red},
            {l:"Retirement",v:"Market-dependent",c:T.muted},
            {l:"Tax on Retire $",v:"Fully taxable",c:T.red},
          ].map((k,i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${T.border}`,flexWrap:"wrap",gap:4}}>
              <span style={{fontSize:11,color:T.muted}}>{k.l}</span>
              <span style={{fontFamily:"'JetBrains Mono',monospace",color:k.c,fontWeight:700,fontSize:11}}>{k.v}</span>
            </div>
          ))}
        </Card>
        <Card accent={T.gold} style={{padding:"14px"}}>
          <div style={{fontSize:9,color:T.gold,fontWeight:800,letterSpacing:1,marginBottom:8}}>SCENARIO B ⚡</div>
          <div style={{fontSize:11,color:T.dim,fontWeight:700,marginBottom:10}}>Velocity + IUL</div>
          {[
            {l:"Debt-Free",v:addMo(simVel.months),c:T.green},
            {l:"Total Interest",v:$c(simVel.totalInt),c:T.green},
            {l:"Retire Income",v:$c(cvAtRetire*0.05/12)+"/mo",c:T.gold},
            {l:"Tax on Retire $",v:"$0 — Tax-free",c:T.green},
          ].map((k,i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${T.border}`,flexWrap:"wrap",gap:4}}>
              <span style={{fontSize:11,color:T.dim}}>{k.l}</span>
              <span style={{fontFamily:"'JetBrains Mono',monospace",color:k.c,fontWeight:700,fontSize:11}}>{k.v}</span>
            </div>
          ))}
        </Card>
      </div>

      <Card accent={T.green} style={{padding:"16px",marginBottom:12}}>
        <div style={{fontSize:9,color:T.green,fontWeight:800,letterSpacing:2,marginBottom:12}}>🏆 SCENARIO B ADVANTAGE</div>
        <div className="grid-2">
          {[
            {l:"Time Saved",v:fmt(simBase.months-simVel.months),c:T.green},
            {l:"Interest Saved",v:$c(simBase.totalInt-simVel.totalInt),c:T.green},
            {l:"Policy Value",v:$c(cvAtRetire),c:T.gold},
            {l:"Death Benefit",v:$c(dbAtRetire),c:T.blue},
          ].map((k,i)=>(
            <StatBox key={i} label={k.l} value={k.v} color={k.c} small/>
          ))}
        </div>
      </Card>

      <Card accent={T.blue} style={{padding:"16px"}}>
        <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:10}}>TRAJECTORY COMPARISON</div>
        <Spark snaps={simVel.snaps} color={T.gold} h={80}/>
        <div style={{display:"flex",gap:10,marginTop:8,flexWrap:"wrap"}}>
          {[{c:T.gold,l:`B: Velocity (${fmt(simVel.months)})`},{c:T.red,l:`A: Baseline (${fmt(simBase.months)})`}].map((x,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:5}}><div style={{width:12,height:3,background:x.c,borderRadius:2}}/><span style={{fontSize:10,color:T.dim}}>{x.l}</span></div>
          ))}
        </div>
      </Card>
    </div>
  );

  /* ── RENDER PAGE ───────────────────────────────────── */
  const renderPage = () => {
    switch(tab){
      case "dashboard": return renderDashboard();
      case "debts":     return renderDebts();
      case "strategy":  return renderStrategy();
      case "numbers":   return renderNumbers();
      case "iul":       return isPro?renderIUL():<ProGate onUpgrade={()=>setShowUpgrade(true)}/>;
      case "retire":    return isPro?renderRetire():<ProGate onUpgrade={()=>setShowUpgrade(true)}/>;
      case "import":    return isPro?renderImport():<ProGate onUpgrade={()=>setShowUpgrade(true)}/>;
      case "compare":   return isPro?renderCompare():<ProGate onUpgrade={()=>setShowUpgrade(true)}/>;
      default:          return renderDashboard();
    }
  };

  return (
    <div style={{minHeight:"100vh",background:T.bg,fontFamily:"'Syne',sans-serif",color:T.text}}>
      <style>{CSS}</style>

      {/* ── TOP NAV ── */}
      <nav style={{background:T.surf,borderBottom:`1px solid ${T.border}`,padding:"0 16px",display:"flex",alignItems:"center",justifyContent:"space-between",height:52,position:"sticky",top:0,zIndex:91,gap:10}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,background:`linear-gradient(135deg,${T.red},${T.orange})`,borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>⚡</div>
          <div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,letterSpacing:2,lineHeight:1}}>VELOCITYDEBT</div>
            <div style={{fontSize:8,color:T.muted,letterSpacing:1}}>{isPro?"PRO":"FREE PLAN"}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {!isPro&&(
            <button className="btn gold-glow" onClick={()=>setShowUpgrade(true)}
              style={{background:`linear-gradient(135deg,${T.gold},${T.goldL})`,color:"#05060F",padding:"7px 14px",borderRadius:9,fontSize:11,fontWeight:800}}>
              Upgrade Pro
            </button>
          )}
          {isPro&&(
            <button className="btn" onClick={()=>setIsPro(false)}
              style={{background:`${T.gold}18`,border:`1px solid ${T.gold}33`,color:T.gold,padding:"7px 12px",borderRadius:9,fontSize:11}}>
              ✓ Pro
            </button>
          )}
        </div>
      </nav>

      {/* ── DESKTOP TABS ── */}
      <div className="desktop-tabs" style={{background:T.surf,borderBottom:`1px solid ${T.border}`,padding:"0 24px",overflowX:"auto"}}>
        {ALL_NAV.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} className="btn"
            style={{background:"transparent",padding:"11px 14px",color:tab===t.id?T.green:T.muted,fontSize:12,fontWeight:tab===t.id?800:500,borderBottom:`2px solid ${tab===t.id?T.green:"transparent"}`,whiteSpace:"nowrap",transition:"color .2s"}}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* ── PAGE CONTENT ── */}
      <div className="page-content">{renderPage()}</div>

      {/* ── BOTTOM NAV (mobile) ── */}
      <nav className="bottom-nav">
        {ALL_NAV.slice(0,5).map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} className="btn"
            style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3,padding:"8px 4px",background:"transparent",color:tab===t.id?T.green:T.muted,borderTop:`2px solid ${tab===t.id?T.green:"transparent"}`,fontSize:10,fontWeight:tab===t.id?800:500,transition:"color .2s",minWidth:0}}>
            <span style={{fontSize:18,lineHeight:1}}>{t.icon}</span>
            <span style={{fontSize:9,letterSpacing:.3}}>{t.label}</span>
          </button>
        ))}
        {ALL_NAV.length>5&&(
          <button className="btn" onClick={()=>setTab(ALL_NAV[5].id)}
            style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3,padding:"8px 4px",background:"transparent",color:T.muted,fontSize:10,fontWeight:500,minWidth:0}}>
            <span style={{fontSize:18,lineHeight:1}}>•••</span>
            <span style={{fontSize:9}}>More</span>
          </button>
        )}
      </nav>

      {/* ── MODALS ── */}
      {showUpgrade&&(
        <UpgradeModal
          feature={upgradeFeature}
          onClose={()=>setShowUpgrade(false)}
          onSelectMonthly={handleUpgradeMonthly}
          onSelectYearly={handleUpgradeYearly}
        />
      )}
      {showDebtModal&&<DebtModal debt={editDebt} idx={debts.length} onSave={d=>{
        if(editDebt) setDebts(ds=>ds.map(x=>x.id===d.id?d:x));
        else setDebts(ds=>[...ds,d]);
      }} onClose={()=>{setShowDebtModal(false);setEditDebt(null);}}/>}
    </div>
  );
}

/* ── HOME PURCHASE SIMULATOR (sub-component) ──── */
function HomeSim({income,totalMin}) {
  const [hp,setHp]=useState(350000);
  const [dp,setDp]=useState(35000);
  const [mr,setMr]=useState(6.75);
  const loan=hp-dp;
  const r=mr/100/12;
  const n=360;
  const pmt=loan>0?loan*(r*Math.pow(1+r,n))/(Math.pow(1+r,n)-1):0;
  const dti=income>0?((totalMin+pmt)/income)*100:0;
  const dtiColor=dti<=36?T.green:dti<=43?T.yellow:T.red;
  return (
    <Card accent={T.blue} style={{padding:"16px"}}>
      <div style={{fontSize:9,color:T.muted,fontWeight:800,letterSpacing:2,marginBottom:12}}>🏠 HOME PURCHASE READINESS</div>
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:14}}>
        <Input label="Home Price" value={hp} onChange={e=>setHp(+e.target.value||0)} type="number" prefix="$"/>
        <div className="grid-2">
          <Input label="Down Payment" value={dp} onChange={e=>setDp(+e.target.value||0)} type="number" prefix="$"/>
          <Input label="Rate %" value={mr} onChange={e=>setMr(+e.target.value||0)} type="number" suffix="%"/>
        </div>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
        <StatBox label="Est. Mortgage Pmt" value={$c(pmt)+"/mo"} color={T.blue} small/>
        <StatBox label="DTI With Mortgage" value={dti.toFixed(1)+"%"} color={dtiColor} small/>
        <StatBox label="Status" value={dti<=36?"✅ Perfect":dti<=43?"⚠️ Marginal":"🚨 Too High"} color={dtiColor} small/>
      </div>
      {dti>36&&<div style={{background:"#080C1A",border:`1px solid ${T.blue}22`,borderRadius:10,padding:"10px 12px",fontSize:12,color:T.dim,lineHeight:1.6}}>
        To qualify with perfect DTI, pay down <strong style={{color:T.red}}>{$c((totalMin+pmt-income*0.36)*50)}</strong> in card balances before applying.
      </div>}
      {dti<=36&&<div style={{background:"#071A0E",border:`1px solid ${T.green}22`,borderRadius:10,padding:"10px 12px",fontSize:12,color:T.green}}>✅ You qualify for this home with a perfect DTI!</div>}
    </Card>
  );
}

/* ── PRO GATE PLACEHOLDER ──────────────────────── */
function ProGate({onUpgrade}) {
  return (
    <div className="fu" style={{textAlign:"center",padding:"40px 20px"}}>
      <div style={{fontSize:56,marginBottom:16}}>🔒</div>
      <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:28,color:T.gold,letterSpacing:2,marginBottom:8}}>PRO FEATURE</div>
      <div style={{fontSize:13,color:T.dim,lineHeight:1.8,marginBottom:24,maxWidth:320,margin:"0 auto 24px"}}>This feature is available on VelocityDebt Pro. Upgrade to unlock AI import, IUL strategy, retirement planner, and more.</div>
      <button className="btn gold-glow" onClick={onUpgrade}
        style={{background:`linear-gradient(135deg,${T.gold},${T.goldL})`,color:"#05060F",padding:"16px 32px",borderRadius:12,fontSize:15,fontWeight:800}}>
        Upgrade to Pro — $14/mo →
      </button>
    </div>
  );
}
