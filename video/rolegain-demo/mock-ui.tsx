import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/ui/App';
import '../../src/ui/design-system.css';
import '../../src/ui/styles.css';
import '../../src/ui/cv-workspace.css';
import './recording.css';

// Recording sandbox: every API call is handled in memory. No real workspace,
// account, GitHub request, employer website or application submission is used.
const now = '2026-09-10T10:00:00.000Z';
const clone = (x: any) => structuredClone(x);
const insightGroups = [
  [['Full-stack product engineering','Built and shipped customer-facing SaaS products.','React · TypeScript · Node.js'],['API design & ownership','Owned REST APIs from architecture to production.','API design · PostgreSQL'],['Measurable product impact','Reduced page load time by 42% through focused profiling.','Performance · Web vitals'],['Cross-functional delivery','Partnered with design and product across 12 launches.','Collaboration · Delivery']],
  [['Production-grade TypeScript','Typed application architecture across 18 repositories.','TypeScript · Architecture'],['Open-source contributions','Reviewed pull requests and shipped 34 contributions.','Git · Code review'],['Automated testing','Integration and unit coverage for critical workflows.','Vitest · Playwright'],['Reliable release pipelines','Automated builds, tests and deployment checks.','CI/CD · GitHub Actions']],
  [['Technical communication','Published practical guides to modern frontend architecture.','Technical writing'],['System design thinking','Explained resilient APIs with concrete trade-offs.','System design · APIs'],['Accessible interface patterns','Documented accessible components and keyboard navigation.','Accessibility · React'],['Knowledge sharing','Turned engineering lessons into reusable team guidance.','Mentoring · Documentation']],
  [['Cloud architecture foundations','Completed a cloud architecture certification.','Cloud · Architecture'],['Secure application delivery','Demonstrated identity, access and networking knowledge.','Security · IAM'],['Operational reliability','Validated monitoring and recovery practices.','Observability'],['Continuous learning','Applied structured learning to production engineering.','Professional development']]
];
const sourceNames = ['Alex_Morgan_CV.pdf','GitHub · alex-morgan-demo','Articles · Engineering notes','Certificate · Cloud architecture'];
const sources = sourceNames.map((name,i)=>({id:`source-${i}`,kind:['cv','github','webpage','document'][i],name, ...(i===1?{url:'https://github.com/alex-morgan-demo',profileField:'github'}:i===2?{url:'https://alex-morgan.example/articles'}:{}),status:'ready',content:'Synthetic source content for this demo only.',addedAt:now,insights:insightGroups[i].map(([title,summary,skills],j)=>({id:`insight-${i}-${j}`,title,summary,evidence:summary,skills:skills.split(' · '),category:'experience'}))}));
const profile = {name:'Alex Morgan',email:'alex.morgan@example.com',phone:'+1 202-555-0148',linkedin:'',github:'https://github.com/alex-morgan-demo',website:'https://alex-morgan.example',location:'Bratislava, Slovakia',headline:'Full-stack engineer',summary:'Product-minded full-stack engineer building reliable web applications.',salaryExpectation:'€70,000–€90,000',targetLocations:'Europe',workplace:'Remote',employmentTypes:'Full-time',workAuthorization:'Authorized to work in the European Union',startDate:'',skills:['TypeScript','React','Node.js','PostgreSQL','Cloud','CI/CD'],languages:['English']};
const jobNames = [['Orbitlane','Senior Full-stack Engineer',94],['Cloudfern','Product Engineer',89],['Lumenpath','Frontend Engineer',86],['Cedarbyte','Software Engineer',81],['Parallel Cove','Platform Engineer',74],['Fieldnote Labs','Backend Engineer',69],['Arcwell Demo','Senior Engineer',0],['Bayside Demo','Product Developer',0]];
const jobs = jobNames.map(([company,title,fit],i)=>({id:`job-${i}`,jobNumber:i+1,company,title,fit,location:'Remote · Europe',workplace:'Remote',compensation:'€75,000–€95,000',sourceUrl:`https://careers.example/jobs/${i}`,applyUrl:`https://careers.example/apply/${i}`,capturedAt:now,summary:i===0?'Build thoughtful developer tools with a small, ambitious product team.':'Own meaningful product work with a collaborative engineering team.',requirements:['Build production React and TypeScript applications','Design and maintain reliable APIs','Ship quality software with automated tests'],requirementMatches:['React & TypeScript','API architecture','Automated testing'].map((r,j)=>({id:`req-${j}`,kind:'required',requirement:r,status:'matched',explanation:'Supported by CV and repository evidence.',evidence:[{sourceId:'source-1',sourceName:sources[1].name,excerpt:insightGroups[1][j][1]}]})),strengths:['Strong TypeScript experience','End-to-end product ownership'],gaps:[],applicationRoute:{status:'verified'}}));
const base = {id:'film-workspace',candidateId:'fictional-alex',phase:'intake',profile:clone(profile),profileCompleteness:100,profileSetupStep:4,sources:clone(sources),questions:[],opportunities:[],searchReadyOpportunities:[],applications:[],rejectedOpportunities:[],searchValidationIssues:[],jobHistory:[],seenJobUrls:[],searchSourceBacklog:[],searchConfig:{discoveryTarget:8,applicationTarget:3,minimumMatchScore:75,developerMode:true},sharedAnswers:{},discoveryNeedsRun:true,finalCv:'Fictional candidate CV for demo recording.',intelligence:{status:'ready',evidenceRun:{id:'mock-evidence',readyForSearch:true,blockers:[],warnings:[],counts:{sources:4,sourceBlocks:32,claims:126,supportedClaims:126,capabilities:24,roleFamilies:3,unknowns:0,contradictions:0}}},workflowExecution:{id:'demo-only',status:'running',type:'analyze'},updatedAt:now};
const coverLetter = `Dear Orbitlane team,

I’m excited to apply for the Senior Full-stack Engineer role. I build reliable React and TypeScript products, own APIs from design to production, and work closely with product and design.

My experience includes reducing page load time by 42%, contributing to 18 repositories, and shipping automated tests and release pipelines. I would bring that same care for performance, quality and clear technical communication to Orbitlane’s developer tools.

Best regards,
Alex Morgan`;
const projectAnswer = 'I reduced page load time by 42% through focused profiling and frontend optimization. I owned the work from diagnosis through release, pairing performance improvements with automated tests. This combined my React and TypeScript experience with end-to-end product ownership.';
const motivationAnswer = 'Orbitlane’s focus on developer tools fits how I work: building reliable APIs, contributing to open source and making technical ideas clear. My repository work and published engineering guides show both hands-on delivery and the ability to communicate the reasoning behind a solution.';
function appFor(i:number) {
 const values = [
  ['name','Full name','text','Alex Morgan','profile'],
  ['email','Email address','email','alex.morgan@example.com','profile'],
  ['resume','CV / Resume','file','Alex_Morgan_CV.pdf','cv'],
  ['github','GitHub profile','text',profile.github,'profile'],
  ['cover','Cover letter','textarea',coverLetter,'generated'],
  ['project','Describe a technical achievement','textarea',projectAnswer,'generated'],
  ['why','Why this role and company?','textarea',motivationAnswer,'generated'],
  ['authorization','Work authorization','select','Authorized to work in the EU','profile'],
  ['workplace','Preferred workplace','select','Remote','profile'],
  ['notice','Notice period','text',i===0?'':'2 weeks','user'],
 ];
 const formFields=values.map(([id,label,type,value,source])=>({id,label,type,value,source,required:true,confidence:source==='user'?100:98,
  ...(id==='cover'?{canonicalKey:'cover_letter'}:{}),
  ...(id==='project'?{evidence:'CV · Performance achievement · 42% faster page loads'}:{}),
  ...(id==='why'?{evidence:'GitHub contributions · Published engineering articles'}:{}),
  ...(id==='authorization'?{options:['Authorized to work in the EU','Sponsorship required']}:{}),
  ...(id==='workplace'?{options:['Remote','Hybrid','On-site']}:{}),
 }));
 return {id:`app-${i}`,jobId:`job-${i}`,addedBy:'agent',status:i===0?'needs_input':'ready_to_send',coverLetter,coverLetterChat:[],formFields,missingQuestions:i===0?['Notice period']:[],adapter:'generic',liveFormValidated:true,formSchema:{observedQuestionCount:values.length,mappedQuestionCount:values.length,fingerprint:'demo',issues:[],verifiedByAgent:true},updatedAt:now};
}
function make(stage:string) {
 const w:any=clone(base);
 if(stage==='upload'){w.sources=[];w.profile={...profile,name:'',email:'',github:'',website:''};w.profileCompleteness=0;w.profileSetupStep=1;w.intelligence={status:'idle'};return w;}
 if(stage==='cv'){w.sources=[clone(sources[0])];w.profile.github='';w.profile.website='';w.profileSetupStep=2;return w;}
 if(stage==='sources'){w.sources=[clone(sources[0])];w.profileSetupStep=2;w.intelligence.evidenceRun.readyForSearch=false;return w;}
 if(stage.startsWith('evidence')){const count=Number(stage.split('-')[1]||4);w.sources=clone(sources.slice(0,count));return w;}
 w.phase='search';w.discoveryNeedsRun=false;
 const count=stage.startsWith('search-')?Number(stage.split('-')[1]):8;
 const filtered=!stage.startsWith('search-');
 const matched=['matched','selected','ready'].includes(stage);
 const selected=['selected','ready'].includes(stage);
 w.opportunities=clone(jobs.slice(0,6));
 const items=jobs.slice(0,count).map((job,i)=>({id:job.id,jobNumber:i+1,company:job.company,title:job.title,sourceUrl:job.sourceUrl,validation:filtered?(i>5?'failed':'passed'):'running',match:filtered&&i<6?(matched?'passed':'running'):'waiting',application:selected&&i<3?'passed':'waiting',applicationVerification:selected&&i<3?'passed':'waiting',applicationReady:i!==0,...(matched&&i<6?{fit:job.fit}:{}),...(filtered&&i>5?{validationDisposition:'rejected',reason:i===6?'Position closed':'On-site only · outside your location preferences'}:{})}));
 w.jobHistory=items;w.searchProgress={stage:selected?'ready':filtered?'verifying':'looking',target:8,found:count,items:clone(items),events:[],activity:filtered?'Comparing every requirement with your evidence':'Finding live roles that fit your experience',updatedAt:now};
 if(selected){w.applications=[0,1,2].map(appFor);}
 if(stage==='ready')w.phase='applications';
 return w;
}
let workspace:any=make('upload');
let stream:ReadableStreamDefaultController<Uint8Array>|undefined;
const json=(body:any)=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
const beta={applicationsUsed:0,applicationLimit:50,batchesStarted:0,batchLimit:10,remainingApplications:50,remainingBatches:10,canStartBatch:true,releaseUpdates:false};
const nativeFetch=window.fetch.bind(window);
window.fetch=async(input:any,init:any={})=>{
 const url=new URL(typeof input==='string'?input:input.url,location.href);
 if(!url.pathname.startsWith('/api/')) {
   if(url.origin!==location.origin) throw new Error('External requests are disabled in the recording sandbox');
   return nativeFetch(input,init);
 }
 const p=url.pathname,body=init.body?JSON.parse(init.body):{};
 if(p==='/api/service-status')return json({codexEnabled:true});
 if(p==='/api/beta')return json(beta);
 if(p==='/api/analytics/events')return json({recorded:false});
 if(p==='/api/workflows/events')return new Response(new ReadableStream({start(c){stream=c;init.signal?.addEventListener('abort',()=>{try{c.close();}catch{}});}}),{headers:{'Content-Type':'text/event-stream'}});
 if(p.endsWith('/evidence'))return json({claims:[],capabilities:[],roleFamilies:[],unknowns:[],contradictions:[]});
 if(p==='/api/job-search/sources') {if(body.kind==='cv')workspace=make('cv');return json(workspace);}
 if(p.endsWith('/analyze')){workspace=make('evidence-4');return json(workspace);}
 if(p.endsWith('/profile-evidence/explore')){workspace.sources=[clone(sources[0]),clone(sources[1])];return json(workspace);}
 if(p.endsWith('/profile')){Object.assign(workspace.profile,body);return json(workspace);}
 if(p.endsWith('/finish-intake')){workspace.profileSetupStep=4;return json(workspace);}
 if(p.endsWith('/prepare')){workspace=make('search-1');return json(workspace);}
 if(p.endsWith('/employer-proxy-session')){
   const app=workspace.applications.find((a:any)=>a.id===p.split('/')[4]);
   sessionStorage.setItem('rolegain.demo.application',JSON.stringify({...app,coverLetter:app.coverLetter,fields:Object.fromEntries(app.formFields.map((f:any)=>[f.id,f.value]))}));
   return json({url:'/video/rolegain-demo/employer.html'});
 }
 if(p.match(/\/applications\/app-\d$/)&&init.method==='POST'){
   const app=workspace.applications.find((a:any)=>a.id===p.split('/').at(-1));
   app.formFields.forEach((f:any)=>{if(body.fields?.[f.id]!==undefined)f.value=body.fields[f.id]});
   if(body.coverLetter!==undefined)app.coverLetter=body.coverLetter;
   app.status='ready_to_send';app.missingQuestions=[];return json(workspace);
 }
 if(p==='/api/job-search')return json(workspace);
 throw new Error(`Unmocked API call blocked: ${p}`);
};
Object.defineProperty(window,'Notification',{value:undefined,configurable:true});
const root=createRoot(document.getElementById('root')!);
root.render(<App/>);
(window as any).demo={
 stage(name:string){workspace=make(name);stream?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({id:crypto.randomUUID(),message:'',createdAt:now,refreshWorkspace:true})}\n\n`));},
 writeCover(fraction:number){const app=workspace.applications[0];app.coverLetter=coverLetter.slice(0,Math.round(coverLetter.length*fraction));app.formFields.find((f:any)=>f.id==='cover').value=app.coverLetter;stream?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({id:crypto.randomUUID(),message:'',createdAt:now,refreshWorkspace:true})}\n\n`));},
 state(){return clone(workspace)},
 mode(name:string){document.body.dataset.shot=name;},
};
