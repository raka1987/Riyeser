// The home page's "Online connections" section: your website (booking form, enquiry form, order button, online shop)
// connected to every Riyeser program. A live demo (the real booking widget, widget/book.js, in demo mode inside a
// pretend salon website) books a time, and a drawn Riyeser Bookings window beside it shows the booking land.
// Everything in the demo happens in the visitor's browser: nothing is sent.
// Keep the words true to help.mjs (Online connections) and developers.mjs: no ready-made shop apps (Shopify, Wix...)
// exist; the widget is a line of code you paste into any website builder, and developers use the API.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ic = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  once: '<path d="M4 12.5l5 5L20 6.5"/><path d="M4 6.5h7M4 9.5h4"/>',
  live: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  paste: '<rect x="8" y="3.5" width="12" height="14" rx="2"/><path d="M16 20.5H6a2 2 0 0 1-2-2V7.5"/><path d="M11 9h6M11 12.5h4"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2.5"/>',
  trades: '<path d="M3 17.5h18"/><path d="M5 17.5a7 7 0 0 1 14 0"/><path d="M10 10.8V8a2 2 0 0 1 4 0v2.8"/><path d="M4 17.5v2h16v-2"/>',
  salon: '<circle cx="6.5" cy="17" r="3"/><circle cx="17.5" cy="17" r="3"/><path d="M8.6 14.9 19 3.5M15.4 14.9 5 3.5"/>',
  cafe: '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10.5h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3.5c0 1.5 1.5 1.5 1.5 3M12 3.5c0 1.5 1.5 1.5 1.5 3"/>',
  shop: '<path d="M3.5 9.5l1.5-5h14l1.5 5"/><path d="M3.5 9.5a2.2 2.2 0 0 0 4.3 0 2.2 2.2 0 0 0 4.2 0 2.2 2.2 0 0 0 4.2 0 2.2 2.2 0 0 0 4.3 0"/><path d="M5 11.5v9h14v-9"/><path d="M10 20.5v-5h4v5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
};
const ARR = '<svg class="arr" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>';

const BENEFITS = [
  ['once', 'No double entry', 'A booking, order or quote request is typed once, by your customer. Riyeser files it in the right place: the calendar, a sale or invoice, the customer\'s page and your Today screen.'],
  ['live', 'Free times & stock', 'Your website shows the times you really have free, your prices and what\'s in stock, kept up to date from Riyeser. A booked time is held at once, so nobody else can take it.'],
  ['paste', 'Works with any website', 'Copy one line of code into WordPress, Wix, Squarespace, Shopify or plain HTML. It takes your colours. Online shops and web developers connect with the Riyeser API.'],
  ['lock', 'Secure keys, full trail', 'A website key only works on the web addresses you list, and secret keys never go in a browser. Everything that comes in is in the Activity list, and tests never touch your books.'],
];
const TYPES = [
  ['trades', 'Trades & services', 'Quote requests', 'Your contact form sends quote requests straight in, with the customer\'s details and a reminder to call back. With the API, customers can accept a quote and pay an invoice online.', ['invoices', 'accounting-basics']],
  ['salon', 'Salons, clinics & studios', 'Online bookings', 'Clients pick a service, a person and a free time. It lands in your Bookings calendar for you to confirm, and on the client\'s page.', ['bookings']],
  ['cafe', 'Cafés & restaurants', 'Tables & orders', 'Take table bookings with the booking form, and pick-up or catering orders with an order button. Order requests wait for you to confirm.', ['bookings', 'pos']],
  ['shop', 'Shops & online stores', 'Orders & stock', 'Online shop orders become sales in Riyeser POS, or invoices in Accounting, and your shop shows your prices and what\'s in stock.', ['pos', 'accounting-basics']],
];
const APPNAME = { invoices: 'Riyeser Invoices', 'accounting-basics': 'Riyeser Accounting', bookings: 'Riyeser Bookings', pos: 'Riyeser POS' };

// The flow, drawn twice: wide (left to right) and narrow (top to bottom, for phones). Colours come from the page's tokens.
function flowWide(up) {
  const box = (x, w, title, lines, cls = '') => `<rect class="fn${cls}" x="${x}" y="40" width="${w}" height="150" rx="16"/><text class="ft" x="${x + w / 2}" y="76">${esc(title)}</text>${lines.map((l, i) => `<text class="fs" x="${x + w / 2}" y="${104 + i * 22}">${esc(l)}</text>`).join('')}`;
  const apps = ['bookings', 'pos', 'invoices', 'accounting-basics'].map((a, i) => `<image href="${up}assets/apps/${a}.png" x="${772 + i * 40}" y="150" width="30" height="30"/>`).join('');
  return `<svg class="cn-flow wide" viewBox="0 0 1000 250" role="img" aria-labelledby="cnf-t"><title id="cnf-t">Your website sends bookings, orders, quote requests and payments to Riyeser Online. Riyeser Central on your PC collects them every minute and files them in your programs. Free times, prices, stock and confirmations go back to your website.</title>
<defs><marker id="cnfa" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="fh"/></marker><marker id="cnfb" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="fhb"/></marker></defs>
${box(5, 290, 'Your website', ['Booking form · Enquiry form', 'Order button · Online shop', 'Your developer (API)'])}
${box(355, 290, 'Riyeser Online', ['A secure post box for your business', 'Waits safely if every PC is off'], ' mid')}
${box(705, 290, 'Your Riyeser programs', ['Bookings · POS · Invoices', 'Accounting · Customers · Today'])}${apps}
<path class="fl" d="M297 92H351" marker-end="url(#cnfa)"/><path class="fl" d="M647 92H701" marker-end="url(#cnfa)"/><path class="fl back" d="M703 150H651" marker-end="url(#cnfb)"/><path class="fl back" d="M353 150H301" marker-end="url(#cnfb)"/>
<text class="fa" x="500" y="24">bookings · orders · quote requests · payments →</text><text class="fa back" x="500" y="232">← free times · prices · stock · “confirmed” and “ready”</text></svg>`;
}
function flowTall(up) {
  const box = (y, h, title, lines, cls = '') => `<rect class="fn${cls}" x="40" y="${y}" width="280" height="${h}" rx="16"/><text class="ft" x="180" y="${y + 32}">${esc(title)}</text>${lines.map((l, i) => `<text class="fs" x="180" y="${y + 58 + i * 21}">${esc(l)}</text>`).join('')}`;
  const apps = ['bookings', 'pos', 'invoices', 'accounting-basics'].map((a, i) => `<image href="${up}assets/apps/${a}.png" x="${112 + i * 36}" y="476" width="28" height="28"/>`).join('');
  return `<svg class="cn-flow tall" viewBox="0 0 360 530" role="img" aria-labelledby="cnf-t2"><title id="cnf-t2">Your website sends bookings, orders, quote requests and payments to Riyeser Online. Riyeser Central on your PC collects them every minute and files them in your programs. Free times, prices, stock and confirmations go back to your website.</title>
${box(10, 112, 'Your website', ['Booking form · Enquiry form', 'Order button · Online shop'])}
${box(200, 104, 'Riyeser Online', ['A secure post box', 'Waits safely if every PC is off'], ' mid')}
${box(382, 136, 'Your Riyeser programs', ['Bookings · POS · Invoices', 'Accounting · Customers · Today'])}${apps}
<defs><marker id="cnfc" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="fh"/></marker><marker id="cnfd" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="fhb"/></marker></defs>
<path class="fl" d="M160 124V196" marker-end="url(#cnfc)"/><path class="fl" d="M160 306V378" marker-end="url(#cnfc)"/><path class="fl back" d="M200 378V310" marker-end="url(#cnfd)"/><path class="fl back" d="M200 196V128" marker-end="url(#cnfd)"/>
<text class="fa l" x="150" y="156">bookings,</text><text class="fa l" x="150" y="174">orders,</text><text class="fa l" x="150" y="192">quotes</text><text class="fa back r" x="210" y="156">free times,</text><text class="fa back r" x="210" y="174">prices,</text><text class="fa back r" x="210" y="192">stock</text></svg>`;
}

// The pretend Riyeser Bookings window: a day with two staff columns; the script fills it in.
const bookingsMock = (up) => `<div class="cn-app" aria-label="Riyeser Bookings (a drawn sample)">
  <div class="cn-bar"><i></i><i></i><i></i><span><img src="${up}assets/apps/bookings.png" alt="" width="18" height="18">Riyeser Bookings</span></div>
  <div class="cn-tool"><b class="cn-day">Today</b><span class="cn-cnt" hidden></span></div>
  <div class="cn-cal"><div class="cn-heads"><span></span><span>Amy</span><span>Sam</span></div>
    <div class="cn-grid"><div class="cn-hrs"></div><div class="cn-col" data-staff="amy"></div><div class="cn-col" data-staff="sam"></div></div></div>
  <div class="cn-act"><small>Activity</small><p class="cn-log">Checked: nothing new</p></div>
  <div class="cn-toast" hidden role="status"><img src="${up}assets/apps/bookings.png" alt="" width="34" height="34"><div><small>New online booking</small><b class="cn-tw"></b><span class="cn-ts">From your website · waiting for you to confirm</span></div><button type="button" class="btn p sm cn-ok">Confirm</button></div>
</div>`;

export function connectSection(up) {
  return `<section class="conn" id="connect" aria-labelledby="cn-h">
<div class="cn-band"><div class="c">
  <div class="shead"><span class="eyebrow">Online connections</span><h2 class="h2" id="cn-h">Your website, connected to your whole business</h2>
    <p class="sub">The one-stop shop for running your business: bookings, sales, quotes and payments from your website land straight in Riyeser. No copying, no double entry.</p></div>
  <div class="cn-stage">
    <div class="cn-site" aria-label="A sample salon website with the Riyeser booking form">
      <div class="cn-bar"><i></i><i></i><i></i><span class="cn-url"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>harbourhair.example/book</span></div>
      <div class="cn-view">
        <div class="cn-shead"><span class="cn-logo">H</span><b>Harbour Hair Studio</b><span class="cn-nav"><span>Services</span><span>Team</span><span class="on">Book</span></span></div>
        <div class="cn-hero"><b>Book your next visit</b><span>Choose a service and a time that suits you.</span></div>
        <div class="cn-w" id="cn-widget"><p class="cn-wait">Loading the booking form…</p></div>
        <p class="cn-down" hidden>It landed in Riyeser Bookings, just below ↓</p>
      </div>
    </div>
    <div class="cn-link" aria-hidden="true"><span class="cn-line"></span><span class="cn-pkt"></span></div>
    ${bookingsMock(up)}
  </div>
  <p class="cn-note"><span class="cn-live">Live demo</span><span class="cn-say" aria-live="polite">Book a time on the sample website and watch it land in Riyeser Bookings.</span></p>
  <p class="cn-fine">A made-up salon. Nothing is sent. On your website the same form shows your own services, staff and free times.</p>
</div></div>
<div class="c cn-more">
  <div class="cn-flowbox">${flowWide(up)}${flowTall(up)}
    <p class="cn-cap">Riyeser Central on your office PC collects new items every minute and files them in the right program. Nothing on the internet can reach your PC or your books.</p></div>
  <div class="cn-bens">${BENEFITS.map(([k, h, p]) => `<div class="cn-ben"><span class="cn-ic">${ic(I[k])}</span><h3>${esc(h)}</h3><p>${esc(p)}</p></div>`).join('')}</div>
  <h3 class="cn-th">Made for the way you sell</h3>
  <div class="cn-types">${TYPES.map(([k, who, what, p, apps]) => `<div class="cn-type"><div class="cn-tt"><span class="cn-ic">${ic(I[k])}</span><div><small>${esc(who)}</small><b>${esc(what)}</b></div></div><p>${esc(p)}</p>
    <div class="cn-into"><span>Lands in</span>${apps.map((a) => `<img src="${up}assets/apps/${a}.png" alt="${esc(APPNAME[a])}" title="${esc(APPNAME[a])}" width="26" height="26" loading="lazy">`).join('')}</div></div>`).join('')}</div>
  <div class="cn-cta"><div><b>Connect your website in five steps</b><span>Online bookings need Riyeser Bookings; online orders and stock need Riyeser POS or Accounting. Every new business gets 90 days of each, free.</span></div>
    <div class="cn-btns"><a class="btn p" href="${up}help/online.html#setup">Connect your website ${ARR}</a><a class="btn s" href="${up}developers/">See the developer guide</a><a class="btn s" href="/link/?signup">Start free</a></div></div>
</div>
</section>
<script>(function(){var R=document.getElementById('connect');if(!R)return;
var still=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches,app=R.querySelector('.cn-app'),say=R.querySelector('.cn-say'),toast=R.querySelector('.cn-toast'),cnt=R.querySelector('.cn-cnt'),log=R.querySelector('.cn-log'),dayEl=R.querySelector('.cn-day');
var pad=function(n){return(n<10?'0':'')+n},iso=function(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())};
var lbl=function(day,o){var p=day.split('-');try{return new Date(Date.UTC(+p[0],p[1]-1,+p[2])).toLocaleDateString(undefined,Object.assign({timeZone:'UTC'},o))}catch(e){return day}};
var tm=function(h,m){try{return new Date(Date.UTC(2000,0,1,h,m)).toLocaleTimeString(undefined,{timeZone:'UTC',hour:'numeric',minute:'2-digit'})}catch(e){return h+':'+pad(m)}};
var T0=iso(new Date()),diff=function(day){var a=T0.split('-'),b=day.split('-');return Math.round((Date.UTC(+b[0],b[1]-1,+b[2])-Date.UTC(+a[0],a[1]-1,+a[2]))/864e5)};
var NAMES=['Mia R.','Leo T.','Ana K.','Sione F.','Priya S.','Tom W.','Grace L.','Ken M.','Lena P.','Raj D.'],JOBS=['Colour and style','Haircut','Trim','Blow-dry'],landed=[],seq=1043;
/* the times the sample form does not offer are the ones already booked here (the widget's demo: (h*7+m+i*3)%5==0) */
function busy(i){var out=[];for(var h=9;h<17;h++)for(var m=0;m<60;m+=30)if(!((h*7+m+i*3)%5))out.push((h-9)*2+m/30);return out}
function block(col,row,len,html,cls){var b=document.createElement('div');b.className='cn-bk'+(len<2?' one':'')+(cls?' '+cls:'');b.style.top='calc(var(--r) * '+row+')';b.style.height='calc(var(--r) * '+len+' - 3px)';b.innerHTML=html;R.querySelector('.cn-col[data-staff='+col+']').appendChild(b);return b}
function show(day){var i=diff(day),wd=new Date(day+'T12:00').getDay();dayEl.textContent=i===0?'Today, '+lbl(day,{day:'numeric',month:'short'}):lbl(day,{weekday:'long',day:'numeric',month:'short'});
[].forEach.call(R.querySelectorAll('.cn-col'),function(c){c.innerHTML=''});if(wd===0){block('amy',6,3,'<b>Closed on Sundays</b>','off');return}
var mine=landed.filter(function(x){return x.day===day});
var free=function(s,r){return !mine.some(function(x){return x.staff===s&&r>=x.row&&r<x.row+x.len})};
busy(i).forEach(function(r,n){['amy','sam'].forEach(function(s,k){if(!free(s,r))return;var j=(i*5+n*2+k)%NAMES.length;
block(s,r,1,'<b>'+NAMES[j]+'</b><span>'+JOBS[(j+k)%JOBS.length]+'</span>')})});
[['amy',7],['sam',8]].forEach(function(l){if(free(l[0],l[1])&&busy(i).indexOf(l[1])<0)block(l[0],l[1],1,'<b>Lunch</b>','off')});
mine.forEach(function(x){x.el=block(x.staff,x.row,x.len,'<b>'+x.who+'</b><span>'+x.what+' · '+x.at+'</span><em>'+(x.ok?'Confirmed':'Online · to confirm')+'</em>','web'+(x.ok?' ok':'')+(x.fresh?' fresh':''));x.fresh=false})}
var hrs=R.querySelector('.cn-hrs');for(var h=9;h<17;h++){var s=document.createElement('span');s.style.top='calc(var(--r) * '+(h-9)*2+')';s.textContent=tm(h,0);hrs.appendChild(s)}
var first=T0;if(new Date(first+'T12:00').getDay()===0){var d=new Date(first+'T12:00');d.setDate(d.getDate()+1);first=iso(d)}show(first);
var who=null;
function land(S){var sv=(S.avail.services||[]).filter(function(x){return x.sku===S.service})[0]||{name:S.service,duration_minutes:30};var st=S.staff==='sam'?'sam':'amy';
var p=/T(\\d\\d):(\\d\\d)/.exec(S.slot.local_start),hh=+p[1],mm=+p[2],day=S.slot.local_start.slice(0,10);
var x={day:day,staff:st,row:(hh-9)*2+mm/30,len:Math.max(1,Math.ceil((sv.duration_minutes||30)/30)),who:((S.form.name||'').trim()||'Your customer').slice(0,40).replace(/[<>&"]/g,''),what:sv.name,at:tm(hh,mm),ref:'BK-'+(seq++),fresh:true};
x.len=Math.min(x.len,16-x.row);landed.push(x);who=x;
app.classList.remove('landed');R.classList.add('sending');
setTimeout(function(){R.classList.remove('sending');show(day);app.classList.add('landed');
cnt.hidden=false;R.querySelector('.cn-down').hidden=false;cnt.textContent=landed.length+' online';
R.querySelector('.cn-tw').textContent=x.who+' · '+x.what+', '+lbl(day,{weekday:'short',day:'numeric',month:'short'})+' at '+x.at;R.querySelector('.cn-ts').textContent='From your website · waiting for you to confirm';
var b=R.querySelector('.cn-ok');b.hidden=false;toast.hidden=false;
log.textContent='Just now · Booking form on harbourhair.example · Filed as booking '+x.ref;
say.textContent='It landed: '+x.who+', '+x.what+', '+lbl(day,{weekday:'long',day:'numeric',month:'long'})+' at '+x.at+', in Riyeser Bookings, waiting for you to confirm.'},still?0:900)}
R.querySelector('.cn-ok').addEventListener('click',function(){if(!who)return;who.ok=true;show(who.day);this.hidden=true;R.querySelector('.cn-ts').textContent='Confirmed. On your real website, the form tells your customer.';
log.textContent='Just now · '+who.ref+' confirmed · the website was told';say.textContent='Confirmed. On your real website, the booking form now tells your customer it is confirmed.';setTimeout(function(){toast.hidden=true},still?2500:3200)});
function mount(){var box=document.getElementById('cn-widget');if(!window.RiyeserWidget||!box)return;
var host=RiyeserWidget.mount(box,{demo:true,accent:'#0f766e',theme:'light'}),done={};
var check=function(){var S=host.riyeser&&host.riyeser.state;if(S&&S.step==='done'&&S.done&&S.slot&&!done[S.done.id]){done[S.done.id]=1;land(S)}};
if(host.shadowRoot&&window.MutationObserver)new MutationObserver(check).observe(host.shadowRoot,{childList:true,subtree:true});else setInterval(check,500)}
function load(){if(window.RiyeserWidget)return mount();var s=document.createElement('script');s.src='${up}widget/book.js';s.async=true;s.onload=mount;document.head.appendChild(s)}
if('IntersectionObserver' in window){var io=new IntersectionObserver(function(es){if(es[0].isIntersecting){io.disconnect();load()}},{rootMargin:'900px 0px'});io.observe(R)}else load();
})();</script>`;
}

/** The one-line pointer to the section, under "Find your program". */
export const connectTeaser = () => `<a class="cn-teaser" href="#connect"><span class="cn-ic">${ic(I.globe)}</span><span><b>Have a website?</b> Bookings, orders and quote requests from it land straight in Riyeser.</span><span class="more">See how ${ARR}</span></a>`;
