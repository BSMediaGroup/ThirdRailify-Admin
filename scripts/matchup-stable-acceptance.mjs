import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
const ADMIN='https://admin.thirdrailify.com', PUBLIC='https://thirdrailify.com', ROOT='/polls/abootnothing/brackets';

// Run only in the operator-created, legitimately authenticated browser. This uses
// visible UI for mutations and anonymous Poll controls for one bounded web vote.
// There is no cookie export, account impersonation or paid/provider event path.
export async function acceptance({browser,page,directory}) {
  const run=`studio-acceptance-${Date.now()}`, title=`TEMP ACCEPTANCE — ${run}`;
  const names=['Alpha','Beta','Gamma','Delta'].map(n=>`${run} ${n}`), record={run,title,polls:[],bracketUrl:null,completed:[],cleaned:false};
  const save=()=>writeFile(`${directory}/acceptance-record.json`,JSON.stringify(record,null,2));
  const capture=async(name,p=page)=>{await p.bringToFront();await p.screenshot({path:`${directory}/${name}.png`});};
  const waitSaved=()=>page.waitForFunction(()=>document.querySelector('.bracket-save-state')?.textContent.includes('Saved'));
  const action=async(name)=>{await page.getByRole('button',{name,exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});};
  const closeEditor=async()=>{const editor=page.getByRole('dialog',{name:'Edit matchup',exact:true});if(await editor.isVisible())await editor.getByRole('button',{name:'Done',exact:true}).click();};
  const editMatch=async(index)=>{await closeEditor();await page.getByRole('button',{name:`Edit round 1 match ${index+1}`,exact:true}).click();await page.getByRole('dialog',{name:'Edit matchup',exact:true}).waitFor();};
  const publicContext=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}), visitor=await publicContext.newPage();
  try {
    await page.goto(ADMIN+ROOT);await page.getByRole('button',{name:'Create season',exact:true}).waitFor();
    await capture('live-admin-studio');
    await page.getByRole('button',{name:'Create season',exact:true}).click();await page.getByRole('dialog').getByLabel('Title',{exact:true}).fill(title);await page.getByLabel('Starting slots',{exact:true}).selectOption('4');await action('Create private draft');
    await page.getByRole('heading',{name:title,exact:true}).waitFor();record.bracketUrl=page.url();await save();
    await page.getByLabel('Quick add / bulk paste',{exact:true}).fill(names.join('\n'));await page.getByRole('button',{name:'Add ideas',exact:true}).click();
    const selects=()=>[page.getByLabel('Opponent 1 slot',{exact:true}),page.getByLabel('Opponent 2 slot',{exact:true})];
    await editMatch(0);await selects()[0].selectOption({label:names[0]});await selects()[1].selectOption({label:names[1]});
    await editMatch(1);await selects()[0].selectOption({label:names[2]});await selects()[1].selectOption({label:names[3]});
    await closeEditor();await page.getByRole('button',{name:'Save draft',exact:true}).click();await waitSaved();await page.reload();await waitSaved();await capture('live-saved-draft');record.completed.push('create arrange save hard-reload');await save();
    await editMatch(1);await page.getByRole('button',{name:'Record manual result / bye',exact:true}).click();await page.getByLabel('Winner',{exact:true}).selectOption({label:names[2]});await page.getByLabel(`Score: ${names[2]} (blank = unknown)`,{exact:true}).fill('2');await page.getByLabel(`Score: ${names[3]} (blank = unknown)`,{exact:true}).fill('1');await page.getByLabel('Reason',{exact:true}).fill('Disposable acceptance historical record; not a real season result.');await action('Confirm labelled decision & advance');
    await editMatch(0);await page.getByRole('button',{name:'Create Poll',exact:true}).click();await page.getByLabel('Poll title',{exact:true}).fill(`${title} Poll A`);await capture('live-create-poll');await action('Create and link private Poll');
    await editMatch(0);const editHref=await page.getByRole('link',{name:'Edit Poll',exact:true}).getAttribute('href'),slug=new URL(editHref,ADMIN).searchParams.get('edit');record.polls.push({slug,title:`${title} Poll A`});await save();await capture('live-linked-poll');
    await page.getByRole('link',{name:'Edit Poll',exact:true}).click();await page.getByLabel('Poll title',{exact:true}).waitFor();
    const card=page.locator('article').filter({has:page.getByRole('heading',{name:`${title} Poll A`,exact:true})});await card.getByRole('button',{name:'Open',exact:true}).click();
    await visitor.goto(PUBLIC+'/polls/'+slug);if(await visitor.getByRole('button',{name:'Reject non-essential',exact:true}).count())await visitor.getByRole('button',{name:'Reject non-essential',exact:true}).click();
    await visitor.locator('.poll-options article').filter({hasText:names[0]}).getByRole('button',{name:'Vote',exact:true}).click();await visitor.getByRole('button',{name:'Your vote',exact:true}).waitFor();
    await page.reload();await card.getByRole('button',{name:'Close',exact:true}).click();
    await page.goto(record.bracketUrl);await waitSaved();await editMatch(0);await page.getByRole('button',{name:'Confirm winner & advance',exact:true}).click();await page.getByText(`Accepted poll decision · ${names[0]}`,{exact:true}).waitFor();await capture('live-confirmed-advancement');record.completed.push('one private linked Poll; one bounded ordinary vote; closed settled confirmation');await save();
    await page.goto(ADMIN+'/polls/abootnothing');await page.getByRole('button',{name:'Create matchup',exact:true}).click();await page.getByLabel('Poll title',{exact:true}).fill(`${title} Poll B`);await page.getByLabel('Name',{exact:true}).nth(0).fill(names[3]);await page.getByLabel('Name',{exact:true}).nth(1).fill(names[2]);await page.getByRole('button',{name:'Save matchup',exact:true}).click();await page.getByRole('heading',{name:'Edit matchup',exact:true}).waitFor();
    await page.goto(record.bracketUrl);await waitSaved();await editMatch(1);await page.getByRole('button',{name:'Link existing Poll',exact:true}).click();await page.getByLabel('Search all Aboot Polls',{exact:true}).fill(`${title} Poll B`);await page.getByRole('button',{name:'Map these opponents',exact:true}).click();await page.getByRole('button',{name:'Reverse option mapping',exact:true}).click();await capture('live-link-existing');await action('Confirm mapping & link');
    await editMatch(1);const secondHref=await page.getByRole('link',{name:'Edit Poll',exact:true}).getAttribute('href');record.polls.push({slug:new URL(secondHref,ADMIN).searchParams.get('edit'),title:`${title} Poll B`});await save();
    await closeEditor();await page.getByRole('button',{name:'Review publication',exact:true}).click();await page.getByLabel('Public title',{exact:true}).fill(title);await page.getByLabel('Public URL slug',{exact:true}).fill(run);await page.getByLabel('Introduction',{exact:true}).fill('Temporary release acceptance roadmap. This is test data and will be unpublished after verification.');
    const png=await sharp({create:{width:1200,height:600,channels:4,background:'#11110e'}}).composite([{input:Buffer.from('<svg width="1200" height="600"><text x="70" y="260" fill="#efc65c" font-size="64">TEMPORARY ACCEPTANCE</text><text x="70" y="340" fill="white" font-size="34">Matchup Studio · disposable release verification</text></svg>')}]).png().toBuffer();
    for(const [i,label] of ['Feature / thumbnail image','Wide cover image'].entries()){await page.getByLabel(label,{exact:true}).setInputFiles({name:'temporary-acceptance.png',mimeType:'image/png',buffer:png});await page.waitForFunction(n=>document.querySelectorAll('dialog .bracket-upload-preview').length>=n,i+1);}
    await capture('live-publication-dialog');await action('Publish reviewed roadmap');await visitor.goto(PUBLIC+ROOT+'/'+run);await visitor.getByRole('heading',{name:title,exact:true}).waitFor();await capture('live-public-roadmap',visitor);await visitor.setViewportSize({width:390,height:844});await capture('live-public-mobile',visitor);
    await page.getByLabel('Working title',{exact:true}).fill(`${title} PRIVATE WORKING EDIT`);await page.getByRole('button',{name:'Save draft',exact:true}).click();await waitSaved();await visitor.reload();await visitor.getByRole('heading',{name:title,exact:true}).waitFor();assert.equal(await visitor.getByText('PRIVATE WORKING EDIT').count(),0);
    await page.getByRole('button',{name:'Publish changes',exact:true}).click();await page.getByLabel('Introduction',{exact:true}).fill('Temporary acceptance: explicitly republished revision.');await action('Publish reviewed changes');await visitor.reload();await visitor.getByText('Temporary acceptance: explicitly republished revision.',{exact:true}).waitFor();
    record.completed.push('separate Poll reversed mapping; historical provenance preserved; media publication; anonymous desktop mobile; private edit isolated; republish');await save();
    await page.getByRole('button',{name:'Unpublish',exact:true}).click();await action('Confirm unpublish');await visitor.reload();await visitor.getByRole('heading',{name:'Roadmap unavailable'}).waitFor();await capture('live-unpublished-denial',visitor);
    for(const p of record.polls){await page.goto(ADMIN+'/polls/abootnothing');const c=page.locator('article').filter({has:page.getByRole('heading',{name:p.title,exact:true})});await c.getByRole('button',{name:'Archive',exact:true}).click();}
    await page.goto(record.bracketUrl);await page.getByRole('button',{name:'Archive',exact:true}).click();await action('Confirm archive');record.cleaned=true;record.completed.push('unpublished denial; both Polls and bracket archived; audit retained');await save();console.log(JSON.stringify(record));
  } catch(e) {record.failure=e.message;await save();await capture('live-acceptance-failure').catch(()=>{});throw e;}
  finally {await publicContext.close();}
}
