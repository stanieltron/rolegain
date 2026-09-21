import {chromium} from 'playwright';
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1920,height:1080}});page.setDefaultTimeout(6000);
page.on('pageerror',e=>console.log('ERROR',e.message));
await page.goto('http://127.0.0.1:5186/video/rolegain-demo/film.html');
const ui=page.frame({url:/ui.html/});
await ui.locator('.dropzone').waitFor();
async function stage(s,mode=s){await ui.evaluate(({s,mode})=>{window.demo.stage(s);window.demo.mode(mode);window.scrollTo(0,0)},{s,mode});await page.waitForTimeout(180);}
async function snap(name){await page.screenshot({path:`video/rolegain-demo/output/${name}.png`});}
await stage('sources','sources');
await ui.locator('.wizard-step-stack>.wizard-panel').scrollIntoViewIfNeeded();
console.log('SOURCES', (await ui.locator('body').innerText()).slice(0,3600));await snap('sources');
await stage('evidence-4','evidence');await ui.evaluate(()=>window.scrollTo(0,0));await snap('evidence');
await stage('search-8','search');await ui.getByRole('button',{name:'Discovery',exact:true}).click();await snap('search');
await stage('matched','search');await snap('matched');
await stage('selected','search');await snap('selected');
await ui.getByRole('button',{name:'Applications',exact:true}).click();await ui.getByRole('button',{name:'Open application'}).first().click();
await ui.evaluate(()=>{window.demo.mode('form');window.scrollTo(0,0)});await page.waitForTimeout(150);await snap('form');await ui.evaluate(()=>window.scrollTo(0,245));await snap('form-scrolled');
console.log('FORM', (await ui.locator('body').innerText()).slice(-2600));
await ui.getByRole('textbox',{name:'Notice period'}).fill('2 weeks');
await ui.getByRole('button',{name:'Open employer form',exact:true}).click();
await ui.evaluate(()=>{window.demo.mode('employer');window.scrollTo(0,0)});
await page.waitForTimeout(250);await snap('employer');console.log('FRAMES',page.frames().map(f=>f.url()));
await browser.close();
