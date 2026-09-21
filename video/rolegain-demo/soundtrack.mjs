// Original, locally synthesized score and interface sounds. No sampled music.
import fs from 'node:fs/promises';
const rate=48000,seconds=20,n=rate*seconds,L=new Float64Array(n),R=new Float64Array(n);
const hz=midi=>440*2**((midi-69)/12);
function tone(at,duration,freq,level,{pan=0,attack=.015,decay=2,harm=.14}={}){
 for(let j=0;j<duration*rate;j++){const i=Math.round(at*rate)+j;if(i>=n)break;const t=j/rate,fade=Math.min(1,t/attack)*Math.min(1,(duration-t)/.09),env=fade*Math.exp(-t*decay),v=level*env*(Math.sin(2*Math.PI*freq*t)+harm*Math.sin(2*Math.PI*freq*2*t));L[i]+=v*(1-pan*.45);R[i]+=v*(1+pan*.45);}
}
const chords=[[48,55,59,62,64],[45,52,55,59,60],[41,48,52,55,57],[43,50,57,59,62]];
for(let c=0;c<4;c++){
 const at=c*4.8,notes=chords[c];
 notes.forEach((m,j)=>tone(at,5.0,hz(m),.014,{pan:(j-2)/3,attack:.45,decay:.22,harm:.09}));
 for(let k=0;k<16;k++){
   const m=notes[[1,3,4,2,3,1,4,2][k%8]]+12;
   tone(at+k*.3,.75,hz(m),k%4===0?.026:.018,{pan:k%2?.42:-.42,decay:5,harm:.19});
   tone(at+k*.3+.19,.6,hz(m),.004,{pan:k%2?-.55:.55,decay:5});
 }
 for(let k=0;k<8;k++)tone(at+k*.6,.48,hz(notes[0]-12),.045,{attack:.009,decay:7,harm:.22});
}
let seed=7301;function rand(){seed=(1664525*seed+1013904223)>>>0;return seed/4294967296*2-1;}
// Soft brushed ticks establish motion without fighting the interface.
for(let at=.3;at<17.4;at+=.6){let prev=0;for(let j=0;j<.045*rate;j++){const i=Math.round(at*rate)+j;if(i>=n)break;const noise=rand(),v=(noise-prev)*.007*Math.exp(-j/rate*90);prev=noise;L[i]+=v;R[i]+=v;}}
for(const at of [.5,1.3,2.5,4.85,7.65,11.55,13,17.8])tone(at,.08,820,.033,{attack:.001,decay:50,harm:.2});
for(let k=0;k<7;k++)tone(11.65+k*.1,.03,1100+k*22,.011,{attack:.001,decay:90,harm:.25});
[72,76,79].forEach((m,i)=>tone(17.97+i*.09,1.4,hz(m),.044,{pan:(i-1)*.2,decay:2.8,harm:.1}));
[48,55,60,64].forEach((m,i)=>tone(18.65,1.35,hz(m),.014,{pan:(i-1.5)*.2,attack:.2,decay:.45}));
const buf=Buffer.alloc(44+n*4);buf.write('RIFF',0);buf.writeUInt32LE(buf.length-8,4);buf.write('WAVEfmt ',8);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(2,22);buf.writeUInt32LE(rate,24);buf.writeUInt32LE(rate*4,28);buf.writeUInt16LE(4,32);buf.writeUInt16LE(16,34);buf.write('data',36);buf.writeUInt32LE(n*4,40);
for(let i=0;i<n;i++){const t=i/rate,fade=Math.min(1,t/.25)*Math.min(1,(20-t)/.8);for(let ch=0;ch<2;ch++){const v=(ch?R[i]:L[i])*fade;buf.writeInt16LE(Math.round(Math.max(-1,Math.min(1,v))*32767),44+i*4+ch*2);}}
await fs.writeFile('video/rolegain-demo/output/original-score-v2.wav',buf);
console.log('Original 20-second stereo soundtrack generated.');
