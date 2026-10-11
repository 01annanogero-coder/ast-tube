#!/usr/bin/env bash
# Dev helper: measures scrolling smoothness of AST Tube's Home on a USB phone.
# Each run restarts the app, optionally injects test CSS, loads ~120
# cards, then does 12 real swipe flings while one recorder logs every frame.
# Needs: adb forward tcp:9222 to the WebView (see dev/cdp.mjs).
# Usage: dev/scrolltest.sh <adb-serial> ['<extra css>']
set -e
D="$1"; CSS="${2:-}"; cd "$(dirname "$0")/.."
# Fresh start every run: restart the app, wait for its server, reattach DevTools.
export MSYS_NO_PATHCONV=1
adb -s "$D" shell am force-stop com.annan.asttube
adb -s "$D" shell am start -n com.annan.asttube/.MainActivity >/dev/null 2>&1
until curl -s -m 3 http://127.0.0.1:8765/api/net >/dev/null; do adb -s "$D" shell sleep 2; done
adb -s "$D" shell sleep 10
PID=$(adb -s "$D" shell pidof com.annan.asttube | tr -d '')
adb -s "$D" forward --remove tcp:9222 2>/dev/null || true
adb -s "$D" forward tcp:9222 localabstract:webview_devtools_remote_$PID >/dev/null
CSSJS=$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$CSS")
node dev/cdp.mjs "await wait(0); if ('$DECODE') { const fix=(r)=>r.querySelectorAll('img').forEach(i=>i.decoding='async'); fix(document); new MutationObserver(()=>fix(document)).observe(document.body,{childList:true,subtree:true}); } if ($CSSJS) { const st=document.createElement('style'); st.textContent=$CSSJS; document.head.appendChild(st); } const s=current.el; for (let i=0;i<8 && s.querySelectorAll('.vcard').length<120;i++){ s.scrollTop=s.scrollHeight; await wait(4000); } s.scrollTop=0; await wait(2500); return {cards: s.querySelectorAll('.vcard, .post, .mcard').length, domNodes: document.getElementsByTagName('*').length, blur: getComputedStyle(document.querySelector('.topbar')).backdropFilter}" | sed -n 2p
node dev/cdp.mjs "await wait(0); const run = window._run = (window._run || 0) + 1; window._f=[]; window._lt=[]; let last=performance.now(); (function tick(t){ if (window._run !== run) return; window._f.push(t-last); last=t; requestAnimationFrame(tick); })(performance.now()); try{ new PerformanceObserver((l)=>l.getEntries().forEach(e=>window._lt.push(e.duration))).observe({type:'longtask', buffered:false}); }catch(e){} return 'recording'" >/dev/null
for i in $(seq 1 12); do adb -s "$D" shell input swipe 300 1100 300 350 120; adb -s "$D" shell sleep 0.6; done
node dev/cdp.mjs "await wait(0); window._run++; const f=window._f.slice(5).filter(x=>x<1000); const n=f.length, avg=f.reduce((a,b)=>a+b,0)/n; const jank=f.filter(x=>x>25).length, bad=f.filter(x=>x>50).length; f.sort((a,b)=>a-b); return {frames:n, avgFps: Math.round(1000/avg), p95ms: Math.round(f[Math.floor(n*0.95)]), over25ms: (100*jank/n).toFixed(1)+'%', over50ms: bad, longTasks: window._lt.length, longestTask: Math.round(Math.max(0,...window._lt)), scrolledTo: Math.round(current.el.scrollTop)}" | sed -n 2p
