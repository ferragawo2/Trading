/* Accumulator Chart Engine — independent canvas charting core.
 * Data adapter is deliberately separate: setData accepts normalized {time, price} ticks.
 */
(() => {
 "use strict";
 const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 const fmtTime=t=>new Date(t*1000).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
 function aggregate(ticks,seconds){
   const out=[];let current=null;
   for(const tick of ticks||[]){
     const time=Number(tick.time),price=Number(tick.price);
     if(!Number.isFinite(time)||!Number.isFinite(price))continue;
     const bucket=Math.floor(time/seconds)*seconds;
     if(!current||current.time!==bucket){current={time:bucket,open:price,high:price,low:price,close:price};out.push(current);}
     else{current.high=Math.max(current.high,price);current.low=Math.min(current.low,price);current.close=price;}
   }
   return out;
 }
 function create(canvas){
   const ctx=canvas.getContext("2d");
   const view={scale:1,offset:0,crosshair:null,drag:null,data:[],meta:{},interval:60};
   let width=0,height=0,dpr=1;
   const colors={bg:"#080d14",grid:"#1d2938",text:"#91a0b3",up:"#20bd88",down:"#ee5969",last:"#e7b84b",cross:"#8ca0b8"};
   function resize(){
     const r=canvas.getBoundingClientRect();if(!r.width||!r.height)return;
     width=r.width;height=r.height;dpr=Math.min(devicePixelRatio||1,2);
     canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
     ctx.setTransform(dpr,0,0,dpr,0,0);draw();
   }
   function draw(){
     if(!width||!height)return;
     const left=12,right=78,top=15,bottom=28,pw=Math.max(1,width-left-right),ph=Math.max(1,height-top-bottom);
     ctx.clearRect(0,0,width,height);ctx.fillStyle=colors.bg;ctx.fillRect(0,0,width,height);
     const all=view.data,visible=Math.max(8,Math.floor(pw/(view.scale*9))),end=Math.max(0,all.length-view.offset),begin=Math.max(0,end-visible),bars=all.slice(begin,end);
     if(!bars.length)return;
     let low=Math.min(...bars.map(c=>c.low)),high=Math.max(...bars.map(c=>c.high));
     if(low===high){const d=Math.abs(low*.001)||1;low-=d;high+=d;}
     const pad=(high-low)*.08;low-=pad;high+=pad;
     const y=v=>top+(high-v)/(high-low)*ph,x=i=>left+(i+.5)*pw/bars.length;
     ctx.font="10px system-ui";ctx.textBaseline="middle";ctx.textAlign="right";
     for(let i=0;i<=5;i++){
       const value=high-(high-low)*i/5,yy=top+ph*i/5;
       ctx.strokeStyle=colors.grid;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(left+pw,yy);ctx.stroke();
       ctx.fillStyle=colors.text;ctx.fillText(value.toFixed(view.meta.precision??2),width-7,yy);
     }
     const candleWidth=Math.max(2,Math.min(14,pw/bars.length*.66));
     bars.forEach((c,i)=>{
       const xx=x(i),color=c.close>=c.open?colors.up:colors.down;
       ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=1;
       ctx.beginPath();ctx.moveTo(xx,y(c.high));ctx.lineTo(xx,y(c.low));ctx.stroke();
       const bodyTop=Math.min(y(c.open),y(c.close)),bodyHeight=Math.max(1,Math.abs(y(c.open)-y(c.close)));
       ctx.fillRect(xx-candleWidth/2,bodyTop,candleWidth,bodyHeight);
     });
     const last=bars[bars.length-1],lastY=y(last.close);
     ctx.strokeStyle=colors.last;ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(left,lastY);ctx.lineTo(left+pw,lastY);ctx.stroke();ctx.setLineDash([]);
     ctx.fillStyle=colors.last;ctx.fillRect(left+pw+3,lastY-9,right-9,18);ctx.fillStyle="#111";ctx.textAlign="center";ctx.fillText(last.close.toFixed(view.meta.precision??2),left+pw+(right-9)/2,lastY);
     ctx.textAlign="center";ctx.fillStyle=colors.text;
     for(let i=0;i<5;i++){const n=Math.min(bars.length-1,Math.floor(i*(bars.length-1)/4));ctx.fillText(fmtTime(bars[n].time),x(n),height-11);}
     if(view.crosshair){
       const {x:cx,y:cy}=view.crosshair;
       if(cx>=left&&cx<=left+pw&&cy>=top&&cy<=top+ph){
         ctx.strokeStyle=colors.cross;ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(cx,top);ctx.lineTo(cx,top+ph);ctx.moveTo(left,cy);ctx.lineTo(left+pw,cy);ctx.stroke();ctx.setLineDash([]);
       }
     }
   }
   function setData(ticks,interval,meta={}){
     view.interval=Number(interval)||60;view.meta=meta;view.data=aggregate(ticks,view.interval);
     view.offset=clamp(view.offset,0,Math.max(0,view.data.length-8));draw();
   }
   function reset(){view.scale=1;view.offset=0;draw();}
   canvas.style.touchAction="none";
   canvas.addEventListener("pointerdown",e=>{
     canvas.setPointerCapture(e.pointerId);view.drag={x:e.clientX,offset:view.offset};view.crosshair={x:e.offsetX,y:e.offsetY};
   });
   canvas.addEventListener("pointermove",e=>{
     view.crosshair={x:e.offsetX,y:e.offsetY};
     if(view.drag&&(e.buttons&1)){
       const visible=Math.max(8,Math.floor((width-90)/(view.scale*9)));
       const barsPerPixel=visible/Math.max(1,width-90);
       view.offset=clamp(view.drag.offset+Math.round((view.drag.x-e.clientX)*barsPerPixel),0,Math.max(0,view.data.length-8));
     }
     draw();
   });
   const release=()=>{view.drag=null;};canvas.addEventListener("pointerup",release);canvas.addEventListener("pointercancel",release);
   canvas.addEventListener("pointerleave",()=>{view.crosshair=null;draw();});
   canvas.addEventListener("wheel",e=>{
     e.preventDefault();const old=view.scale;view.scale=clamp(old*(e.deltaY<0?1.15:.87),.5,6);
     const ratio=view.scale/old;view.offset=clamp(Math.round(view.offset*ratio),0,Math.max(0,view.data.length-8));draw();
   },{passive:false});
   if(typeof ResizeObserver!=="undefined")new ResizeObserver(resize).observe(canvas.parentElement||canvas);
   resize();
   return {setData,reset,resize,state:()=>({candleCount:view.data.length,visibleCount:Math.min(view.data.length,Math.max(8,Math.floor((width-90)/(view.scale*9))))})};
 }
 window.AccumulatorChart={create,aggregateCandles:aggregate,version:"0.1.0"};
})();