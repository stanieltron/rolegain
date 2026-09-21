import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

const out=path.resolve('video/rolegain-demo/output');
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1});
const blocked=[],errors=[];
await context.route('**/*',route=>{
 const u=new URL(route.request().url());
 if(['127.0.0.1','localhost'].includes(u.hostname)||['data:','blob:'].includes(u.protocol))return route.continue();
 blocked.push(u.origin);return route.abort();
});
const page=await context.newPage();page.setDefaultTimeout(8000);
page.on('pageerror',e=>errors.push(e.message));
const encoder=spawn('ffmpeg',['-y','-loglevel','error','-f','image2pipe','-framerate','30','-vcodec','mjpeg','-i','pipe:0','-an','-c:v','libx264','-preset','medium','-crf','16','-pix_fmt','yuv420p','-movflags','+faststart','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',path.join(out,'rolegain-how-it-works-v2-silent.mp4')],{stdio:['pipe','inherit','inherit']});
let frame=0,cursor={x:1050,y:810};
const log=[];
async function capture(){
 await page.evaluate(t=>window.film.time(t),frame/30);
 const buf=await page.screenshot({type:'jpeg',quality:96,animations:'disabled'});
 if(!encoder.stdin.write(buf))await once(encoder.stdin,'drain');
 frame++;
}
async function until(seconds,fn){const target=Math.round(seconds*30),start=frame,n=target-start;for(let i=0;frame<target;i++){if(fn)await fn(n<=1?1:i/(n-1));await capture();}}
async function hold(seconds,fn){await until(frame/30+seconds,fn);}
async function mark(label){log.push({time:frame/30,label});console.log(`${(frame/30).toFixed(2)}s ${label}`);await page.screenshot({path:path.join(out,`shot-${String(log.length).padStart(2,'0')}.png`)});}
async function heading(title,step,label){await page.evaluate(({title,step,label})=>{window.film.heading(title,step,label);window.film.hideCallout()},{title,step,label});}
async function mode(name){await ui.evaluate(name=>window.demo.mode(name),name);}
async function stage(name){await ui.evaluate(name=>window.demo.stage(name),name);await page.waitForTimeout(70);}
async function mouseAt(x,y){cursor={x,y};await page.mouse.move(x,y);await page.evaluate(({x,y})=>window.film.cursor(x,y),cursor);}
async function moveTo(locator,seconds=.3){const box=await locator.boundingBox();if(!box)throw Error('Missing cursor target');if(box.y<180||box.y+box.height>979)throw Error(`Cursor target outside footage: ${JSON.stringify(box)}`);const to={x:box.x+box.width*.6,y:box.y+box.height*.55},from={...cursor};await hold(seconds,async u=>{const e=u*u*(3-2*u);await mouseAt(from.x+(to.x-from.x)*e,from.y+(to.y-from.y)*e)});}
async function click(locator,seconds=.12){await locator.click();await hold(seconds,async u=>page.evaluate(({x,y,u})=>window.film.cursor(x,y,u+.01),{...cursor,u}));}
async function scroll(to,seconds=.45,scope=ui){const from=await scope.evaluate(()=>window.scrollY);await page.evaluate(()=>window.film.hideCursor());await hold(seconds,async u=>{const e=u*u*(3-2*u);await scope.evaluate(y=>window.scrollTo(0,y),from+(to-from)*e)});}
async function callout(n,unit,detail){await page.evaluate(({n,unit,detail})=>window.film.callout(n,unit,detail),{n,unit,detail});}
let ui;
try {
 await page.goto('http://127.0.0.1:5186/video/rolegain-demo/film.html');
 ui=page.frame({url:/ui.html/});await ui.locator('.dropzone').waitFor();
 await page.waitForTimeout(150);
 // 0–2.8: upload CV, explore GitHub and stage supplementary evidence.
 await mode('upload');await mark('CV upload');await until(.2);
 await moveTo(ui.locator('.dropzone'),.3);
 const pdf=await PDFDocument.create();const pdfPage=pdf.addPage();const font=await pdf.embedFont(StandardFonts.Helvetica);
 pdfPage.drawText('Alex Morgan | Fictional demo candidate',{x:48,y:760,size:19,font});
 pdfPage.drawText('Full-stack engineer. React, TypeScript, Node.js, PostgreSQL.',{x:48,y:725,size:12,font});
 const cv=Buffer.from(await pdf.save());
 await ui.locator('.dropzone input').setInputFiles({name:'Alex_Morgan_CV.pdf',mimeType:'application/pdf',buffer:cv});
 await ui.getByText('CV evidence ready',{exact:true}).waitFor();await ui.evaluate(()=>window.scrollTo(0,0));await until(1.1);
 await stage('sources');await mode('sources');await ui.evaluate(()=>window.scrollTo(0,0));
 await heading('More than a CV. <em>Your whole story.</em>',1,'CV · GITHUB · ARTICLES · CERTIFICATES');
 await moveTo(ui.getByRole('button',{name:'Explore for evidence'}).first(),.2);
 await click(ui.getByRole('button',{name:'Explore for evidence'}).first(),.1);await until(1.5);
 await ui.locator('#experience-evidence').fill('https://alex-morgan.example/articles');
 await ui.getByRole('button',{name:'Add text or page',exact:true}).click();await until(1.7);
 await ui.locator('.certificate-action input').setInputFiles({name:'Cloud_Architecture_Certificate.pdf',mimeType:'application/pdf',buffer:cv});
 await page.waitForTimeout(70);await mark('GitHub, article and certificate staged');await until(2.25);
 await moveTo(ui.getByRole('button',{name:/Analyze batch/}),.25);await click(ui.getByRole('button',{name:/Analyze batch/}),.1);await until(2.8);
 // 2.8–4.65: evidence grows across all four sources.
 await mode('evidence');await stage('evidence-1');await ui.evaluate(()=>window.scrollTo(0,0));
 await heading('A richer profile. <em>Backed by evidence.</em>',1,'BUILD YOUR EVIDENCE');await page.evaluate(()=>window.film.hideCursor());
 await callout(32,'evidence points','CV experience, grounded in its source.');await until(3.1);
 await stage('evidence-2');await callout(78,'evidence points','GitHub work adds depth.');await until(3.4);
 await stage('evidence-3');await callout(104,'evidence points','Articles add context.');await until(3.7);
 await stage('evidence-4');await callout(126,'evidence points','4 sources. One richer profile.');await scroll(165,.5);await mark('Evidence built');await until(4.65);
 // 4.65–7.75: search, exclude unsuitable roles, match, shortlist.
 await heading('Find the possibilities. <em>Filter the noise.</em>',2,'DISCOVER & VERIFY');
 await stage('search-1');await mode('search');await ui.evaluate(()=>window.scrollTo(0,0));
 await moveTo(ui.getByRole('button',{name:'Discovery',exact:true}),.2);await click(ui.getByRole('button',{name:'Discovery',exact:true}),.1);await page.evaluate(()=>window.film.hideCursor());
 await until(5.15);await stage('search-3');await until(5.35);await stage('search-5');await until(5.55);await stage('search-8');await until(5.75);
 await stage('matching');await callout('8 → 6','live roles','Closed or incompatible roles filtered out.');await mark('Unsuitable jobs excluded');await until(6.35);
 await heading('Match your skills. <em>Shortlist your next move.</em>',3,'MATCH & RANK');await stage('matched');await mark('Evidence match scores');await until(7);
 await stage('selected');await callout(3,'applications prepared','Best matches, ready for your review.');await mark('Three jobs reach Applications');await until(7.45);
 await moveTo(ui.getByRole('button',{name:'Applications',exact:true}),.2);await click(ui.getByRole('button',{name:'Applications',exact:true}),.1);
 // 7.75–9.8: cover letter writes itself beside the attached CV.
 await heading('Cover letter, written for you. <em>CV attached.</em>',4,'EVIDENCE-BASED AUTOFILL');await until(8);
 await ui.evaluate(()=>window.demo.writeCover(0));await page.waitForTimeout(70);
 await ui.getByRole('button',{name:'Open application',exact:true}).first().click();await mode('form');
 await ui.evaluate(()=>{window.scrollTo(0,0);document.body.dataset.writing='true'});await page.evaluate(()=>window.film.hideCursor());await until(8.15);
 await until(9.05,async u=>{await ui.evaluate(fraction=>window.demo.writeCover(fraction),u);});
 await ui.evaluate(()=>{window.demo.writeCover(1);document.body.dataset.writing='false'});await page.waitForTimeout(70);
 const written=await ui.getByRole('textbox',{name:'Cover Letter',exact:true}).inputValue();
 if(written.length<400)throw Error('Cover letter generation did not finish');
 await mark('Cover letter written automatically and CV attached');await until(9.8);
 // 9.8–13.1: complex written answers and dropdowns; one answer from the user.
 await heading('Even the long answers. <em>Evidence-based.</em>',4,'NARRATIVE ANSWERS · AUTOFILLED');
 await scroll(280,.5);await mark('Custom narrative answers and dropdowns');await until(11.35);
 await heading('Just one answer <em>from you.</em>',4,'REVIEW & COMPLETE');
 const notice=ui.getByRole('textbox',{name:'Notice period',exact:true});await moveTo(notice,.2);await click(notice,.1);
 const answer='2 weeks';for(let i=1;i<=answer.length;i++){await notice.fill(answer.slice(0,i));await hold(.1)}
 await until(12.7);await moveTo(ui.getByRole('button',{name:'Open employer form',exact:true}),.3);await mark('Open employer form');
 await click(ui.getByRole('button',{name:'Open employer form',exact:true}),.1);
 await mode('employer');await ui.evaluate(()=>window.scrollTo(0,0));
 await ui.frameLocator('.employer-browser-frame').locator('#resume').waitFor({state:'attached'});
 const employer=page.frame({url:/employer.html/});if(!employer)throw Error('Employer mock did not load');
 // 13.1–15.3: real local file input receives the same generated demo CV.
 await heading('Your application. <em>Autofilled on site.</em>',5,'ON THE EMPLOYER’S SITE');await page.evaluate(()=>window.film.hideCursor());await until(13.45);
 await employer.locator('#resume').setInputFiles({name:'Alex_Morgan_CV.pdf',mimeType:'application/pdf',buffer:cv});
 const attachment=await employer.locator('#resume').evaluate(input=>({name:input.files[0]?.name,size:input.files[0]?.size}));
 if(attachment.name!=='Alex_Morgan_CV.pdf'||attachment.size!==cv.length)throw Error('CV attachment was not transferred');
 const expected=await ui.evaluate(()=>window.demo.state().applications[0]);
 for(const field of expected.formFields.filter(field=>field.type!=='file')){
   const actual=await employer.locator(`[name="${field.id}"]`).inputValue();
   if(actual!==field.value)throw Error(`Employer field differs from reviewed application: ${field.id}`);
 }
 const saved=await employer.locator('#notice').inputValue();
 await heading('CV uploaded. <em>Cover letter autofilled.</em>',5,'ON THE EMPLOYER’S SITE');await mark('CV uploaded and cover letter carried over');await until(15.3);
 // 15.3–17.95: employer narrative fields, dropdowns and user Apply click.
 await heading('Even complex forms. <em>Filled from your evidence.</em>',5,'NARRATIVE ANSWERS · AUTOFILLED');
 const bottom=await employer.evaluate(()=>document.scrollingElement.scrollHeight-innerHeight);await scroll(bottom,.55,employer);
 await mark('Complex employer form fully completed');await until(17.1);
 await heading('You review. <em>You make the final click.</em>',5,'REVIEW & APPLY');
 await moveTo(employer.getByRole('button',{name:/Apply now/}),.4);await until(17.8);await click(employer.getByRole('button',{name:/Apply now/}),.15);
 await employer.getByText('Application received.',{exact:true}).waitFor();await page.evaluate(()=>window.film.hideCursor());await until(18.65);
 await heading('From experience <em>to opportunity.</em>',5,'YOUR NEXT MOVE');await page.evaluate(()=>document.querySelector('#end').style.display='flex');await mark('Application received');await until(20);
 encoder.stdin.end();const [code]=await once(encoder,'close');if(code!==0)throw Error(`Encoder failed: ${code}`);
 if(errors.length||blocked.length)throw Error(JSON.stringify({errors,blocked}));
 await fs.writeFile(path.join(out,'render-report-v2.json'),JSON.stringify({duration:frame/30,frames:frame,fps:30,width:1920,height:1080,network:'Localhost only; every API request mocked in memory',errors,blocked,noticePropagated:saved,coverLetterCharacters:written.length,allEmployerFieldsMatch:true,attachment,shots:log},null,2));
 console.log(`Complete: ${frame} frames, ${frame/30} seconds. No external requests; no page errors.`);
} catch(e){encoder.stdin.destroy();encoder.kill();await page.screenshot({path:path.join(out,'render-error.png')}).catch(()=>{});throw e;}
finally{await browser.close();}
