(function(root){
  'use strict';
  const I=()=>root.WolkenworteI18n;
  const t=(source,params={})=>I()?.t(source,params)||source.replace(/\{\{(\w+)\}\}/g,(_,key)=>params[key]??'');
  const text=(element,source,params={})=>{ if(element) { if(I()?.setText) I().setText(element,source,params); else element.textContent=t(source,params); } };
  const ERROR={
    invalid_credentials:'E-Mail-Adresse oder Passwort stimmen nicht.',email_not_confirmed:'Bitte bestätige zuerst deine E-Mail-Adresse.',
    otp_expired:'Der Code ist ungültig oder abgelaufen. Fordere einen neuen Code an.',weak_password:'Verwende ein Passwort mit mindestens 12 Zeichen.',
    account_unauthorized:'Bitte melde dich erneut an.',account_rate_limited:'Bitte warte kurz, bevor du es erneut versuchst.',
    over_email_send_rate_limit:'Bitte warte eine Minute, bevor du einen neuen Code anforderst.',over_request_rate_limit:'Bitte warte kurz, bevor du es erneut versuchst.',
    design_conflict:'Das Design wurde in einem anderen Fenster geändert. Öffne die gespeicherte Version erneut oder speichere eine neue Kopie.',
    design_busy:'Dieses Design wird gerade gespeichert. Bitte versuche es gleich erneut.',design_not_found:'Dieses Design ist nicht mehr verfügbar.',
    design_quota:'Dein Konto bietet Platz für 20 Designs und 100 MB. Lösche ein Design oder verwende kleinere Bilder.',
    invalid_design:'Dieses Design konnte nicht gespeichert werden. Prüfe deine Elemente und versuche es erneut.',
    unsupported_print_characters:'Dieses Design enthält Zeichen, die mit der gewählten Schrift nicht zuverlässig gedruckt werden können. Bitte wählt eine andere Schrift oder ersetzt diese Zeichen.',
    invalid_design_name:'Gib einen Designnamen mit höchstens 80 Zeichen ein.',invalid_email:'Bitte gib eine gültige E-Mail-Adresse ein.',
    same_password:'Bitte wähle ein anderes Passwort.',reauthentication_needed:'Bitte bestätige deine Identität erneut.',
    password_mismatch:'Die beiden Passwörter stimmen nicht überein.',draft_unavailable:'Dein Entwurf konnte in diesem Browser nicht gesichert werden. Bitte lasse diese Seite geöffnet.',
  };
  const message=error=>ERROR[error?.code]||'Das hat leider nicht geklappt. Bitte versuche es erneut.';
  function status(element,source,error=false,params={}){ text(element,source,params); if(element) element.dataset.error=String(error); }
  async function api(path,body){
    if(path==='session'&&body===undefined&&root.WolkenworteAccountMenu)return root.WolkenworteAccountMenu.session();
    const response=await fetch(`/api/account/${path}`,{method:body===undefined?'GET':'POST',cache:'no-store',credentials:'same-origin',
      headers:{'Accept-Language':I()?.getLocale()||'de',...(body===undefined?{}:{'Content-Type':'application/json','X-Wolkenworte-Account':'1'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
    const data=await response.json();
    if(!response.ok) throw Object.assign(new Error('Account request failed'),{code:data.error,status:response.status});
    return data;
  }
  async function busy(element,work,target){
    if(element.dataset.busy==='true') return;
    element.dataset.busy='true'; const buttons=[...element.querySelectorAll('button')];
    const previous=buttons.map(b=>b.disabled);buttons.forEach(b=>b.disabled=true);
    try{return await work();}catch(error){status(target,message(error),true);return null;}
    finally{element.dataset.busy='false';buttons.forEach((b,index)=>b.disabled=previous[index]);}
  }
  function values(form){return Object.fromEntries(new FormData(form));}
  function date(value){return new Intl.DateTimeFormat(I()?.getLocale()||'de',{dateStyle:'medium'}).format(new Date(value));}

  function bindAuth(container,{onDone,returnTo='/konto',beforeRedirect=async()=>true}={}){
    const form=container.querySelector('[data-auth-form]');
    const codeForm=container.querySelector('[data-auth-code-form]');
    const resetForm=container.querySelector('[data-auth-reset-form]');
    const notice=container.querySelector('[data-auth-status]');
    let mode='login',email='',purpose='signin',lastSent=0;
    const modes=container.querySelectorAll('[data-auth-mode]');
    function choose(next){
      mode=next; form.hidden=false;codeForm.hidden=true;resetForm.hidden=true;
      container.querySelector('[data-auth-password-label]').hidden=mode==='recovery';
      form.elements.password.required=mode!=='recovery';
      form.elements.password.autocomplete=mode==='signup'?'new-password':'current-password';
      form.elements.password.minLength=mode==='signup'?12:1;
      container.querySelector('[data-auth-password-help]').hidden=mode!=='signup';
      modes.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.authMode===mode)));
      text(container.querySelector('[data-auth-submit]'),mode==='signup'?'Konto erstellen':mode==='recovery'?'Code anfordern':'Anmelden');
      status(notice,'');
    }
    function showCode(){
      form.hidden=true;codeForm.hidden=false;resetForm.hidden=true;
      container.querySelector('[data-auth-code-email]').textContent=email;
      codeForm.elements.code.value='';codeForm.elements.code.focus();
      status(notice,'Der Code ist 10 Minuten gültig.');
    }
    function recovery(){form.hidden=true;codeForm.hidden=true;resetForm.hidden=false;resetForm.elements.password.focus();}
    async function done(){form.elements.password.value='';resetForm.reset();await onDone?.();}
    modes.forEach(button=>button.addEventListener('click',()=>choose(button.dataset.authMode)));
    container.querySelector('[data-auth-forgot]').addEventListener('click',()=>choose('recovery'));
    form.addEventListener('submit',event=>{
      event.preventDefault();const data=values(form); email=data.email.trim().toLowerCase();
      void busy(container,async()=>{
        await api(mode==='signup'?'signup':mode==='recovery'?'recovery':'login',{email,password:data.password});
        form.elements.password.value='';
        if(mode==='login') return done();
        purpose=mode==='recovery'?'recovery':'signin';lastSent=Date.now();showCode();
      },notice);
    });
    codeForm.addEventListener('submit',event=>{
      event.preventDefault();const data=values(codeForm);
      void busy(container,async()=>{const result=await api('verify',{email,code:data.code,purpose});if(result.recovery) recovery();else await done();},notice);
    });
    container.querySelector('[data-auth-resend]').addEventListener('click',()=>{
      if(Date.now()-lastSent<60000){status(notice,'Bitte warte eine Minute, bevor du einen neuen Code anforderst.',true);return;}
      void busy(container,async()=>{await api(purpose==='recovery'?'recovery':'resend',{email});lastSent=Date.now();showCode();},notice);
    });
    resetForm.addEventListener('submit',event=>{
      event.preventDefault();const data=values(resetForm);
      void busy(container,async()=>{if(data.password!==data.repeat)throw{code:'password_mismatch'};await api('password',{password:data.password});await done();},notice);
    });
    container.querySelector('[data-auth-google]').addEventListener('click',()=>void busy(container,async()=>{
      if(!await beforeRedirect()) throw{code:'draft_unavailable'};
      const data=await api('google',{returnTo});location.assign(data.url);
    },notice));
    return {choose,recovery};
  }

  async function clearOwnedDrafts(userId){await root.WolkenworteConfiguratorSession?.clearAccountDrafts?.(userId);}

  async function initializePage(){
    const page=document.getElementById('account-page');if(!page||page.dataset.available!=='true')return;
    await I()?.ready?.();
    const notice=document.getElementById('account-page-status');
    // The server has already verified this session before rendering the page.
    let current=JSON.parse(page.dataset.accountUser||'null'),pendingEmail=null;
    let libraryReady=false,libraryLoading=Boolean(current&&!current.recovery);
    let section=location.hash==='#einstellungen'||page.dataset.page==='settings'?'settings':'designs';
    const sectionButtons=[...page.querySelectorAll('[data-account-tab]')];
    function showSection(next,{updateUrl=false}={}){
      section=next==='settings'?'settings':'designs';
      const loggedIn=Boolean(current&&!current.recovery);
      page.querySelector('[data-account-navigation]').hidden=!loggedIn;
      page.querySelector('[data-account-library]').hidden=!loggedIn||section!=='designs'||!libraryReady;
      page.querySelector('[data-account-loading]').hidden=!loggedIn||section!=='designs'||!libraryLoading;
      page.querySelector('[data-account-settings]').hidden=!loggedIn||section!=='settings';
      page.querySelector('[data-account-usage]').hidden=!loggedIn;
      page.querySelector('[data-account-email]').hidden=!loggedIn;
      page.querySelector('[data-account-logout]').hidden=!loggedIn;
      if(!loggedIn)page.querySelector('[data-account-email]').textContent='';
      sectionButtons.forEach(button=>{
        const selected=button.dataset.accountTab===section;
        button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
      });
      if(updateUrl)history.replaceState(null,'',location.pathname+(location.search||'')+(section==='settings'?'#einstellungen':''));
    }
    showSection(section);
    sectionButtons.forEach((button,index)=>{
      button.addEventListener('click',()=>showSection(button.dataset.accountTab,{updateUrl:true}));
      button.addEventListener('keydown',event=>{
        const next=event.key==='Home'?0:event.key==='End'?sectionButtons.length-1:
          event.key==='ArrowRight'?(index+1)%sectionButtons.length:event.key==='ArrowLeft'?(index+sectionButtons.length-1)%sectionButtons.length:null;
        if(next===null)return;event.preventDefault();sectionButtons[next].focus();sectionButtons[next].click();
      });
    });
    root.addEventListener('hashchange',()=>showSection(location.hash==='#einstellungen'?'settings':'designs'));
    const authControl=bindAuth(page.querySelector('[data-account-auth]'),{onDone:async()=>{
      if(page.dataset.page==='signin'&&page.dataset.returnTo!=='/konto') location.assign(page.dataset.returnTo);
      else await refresh();
    },returnTo:page.dataset.page==='signin'?page.dataset.returnTo:section==='settings'?'/konto/einstellungen':location.pathname});
    if(new URLSearchParams(location.search).has('error'))status(notice,'Die Google-Anmeldung konnte nicht abgeschlossen werden. Bitte versuche es erneut.',true);

    async function refresh(){
      libraryLoading=true;
      try {
        const data=await api('session');
        if(current?.id!==data.user?.id)libraryReady=false;
        current=data.user;
        const loggedIn=Boolean(current&&!current.recovery);
        page.classList.toggle('is-signin',!loggedIn);
        page.querySelector('[data-account-signin]').hidden=loggedIn;
        showSection(section);
        root.dispatchEvent?.(new root.CustomEvent('wolkenworte:accountchange',{detail:{user:loggedIn?current:null}}));
        if(current?.recovery){authControl.recovery();return;}
        if(!loggedIn)return;
        if(page.dataset.page==='signin'){location.assign(page.dataset.returnTo);return;}
        page.querySelector('[data-account-email]').textContent=current.email;
        if(current.newEmail)showEmailCodes(current.email,current.newEmail);
        await loadLibrary();
        libraryReady=true;
      } finally {
        libraryLoading=false;showSection(section);
      }
    }

    async function confirm({title,description,action='Bestätigen',name=null}){
      const dialog=document.getElementById('account-confirm-dialog');
      text(dialog.querySelector('[data-confirm-title]'),title);text(dialog.querySelector('[data-confirm-description]'),description);
      text(dialog.querySelector('[data-confirm-action]'),action);
      const label=dialog.querySelector('[data-confirm-name]');label.hidden=name===null;
      const input=label.querySelector('input');input.value=name||'';input.required=name!==null;
      dialog.returnValue='cancel';dialog.showModal();
      if(name!==null){input.focus();input.select();}
      else dialog.querySelector('[data-confirm-cancel]').focus({preventScroll:true});
      return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'?{name:input.value}:null),{once:true}));
    }

    function updateUsage(designs){
      text(page.querySelector('[data-account-count]'),'{{count}} von 20 Designs',{count:designs.length});
      text(page.querySelector('[data-account-storage]'),'{{size}} von 100 MB',{
        size:new Intl.NumberFormat(I()?.getLocale()||'de',{maximumFractionDigits:1}).format(designs.reduce((n,d)=>n+d.byteSize,0)/1024/1024)});
    }
    async function loadLibrary(){
      const data=await api('designs');const list=page.querySelector('[data-account-design-list]');list.replaceChildren();
      page.querySelector('[data-account-empty]').hidden=data.designs.length!==0;
      page.querySelector('[data-account-library-toolbar]').hidden=data.designs.length===0;
      updateUsage(data.designs);
      for(const design of data.designs){
        const card=document.createElement('article');card.className='ww-account-design';
        const image=document.createElement('img');image.src=design.previewUrl;image.alt='';image.loading='lazy';
        image.width=480;image.height=320;
        const title=document.createElement('h2');title.textContent=design.name;
        const expires=document.createElement('p');expires.className='ww-account-design-date';text(expires,'Wird bei Inaktivität am {{date}} gelöscht.',{date:date(design.expiresAt)});
        const saved=document.createElement('p');saved.className='ww-account-small';text(saved,'Zuletzt gespeichert: {{date}}',{date:date(design.savedAt)});
        const product=document.createElement('p');product.className='ww-account-small';text(product,design.productName);
        const actions=document.createElement('div');actions.className='ww-account-actions';
        const options=document.createElement('details');options.className='ww-account-design-menu';
        const trigger=document.createElement('summary');trigger.className='ww-menu-trigger';
        if(I()?.setAttribute)I().setAttribute(trigger,'aria-label','Designoptionen');else trigger.setAttribute('aria-label',t('Designoptionen'));
        const icon=document.createElement('span');icon.className='ww-design-options-icon';icon.setAttribute('aria-hidden','true');
        for(let line=0;line<3;line++)icon.append(document.createElement('i'));
        trigger.append(icon);const menu=document.createElement('div');menu.className='ww-account-design-menu-panel';
        options.append(trigger,menu);
        for(const [label,action] of [['Weiter gestalten','open'],['Umbenennen','rename'],['Löschen','delete']]){
          const button=document.createElement('button');button.type='button';text(button,label);if(action==='open')button.className='ww-account-primary';
          button.addEventListener('click',()=>void busy(card,async()=>{
            options.open=false;
            if(action==='open'){const data=await api(`designs/${design.id}/open`,{});location.assign(data.url);return;}
            if(action==='rename'){
              const result=await confirm({title:'Design umbenennen',description:'Wähle einen Namen für dein Design.',name:design.name,action:'Namen speichern'});
              if(!result){trigger.focus({preventScroll:true});return;}
              await api(`designs/${design.id}/rename`,{name:result.name,version:design.version});
            }else{
              if(!await confirm({title:'Design löschen?',description:'Dieses gespeicherte Design wird sofort dauerhaft gelöscht. Warenkorbkopien und Bestellungen bleiben davon unabhängig.',action:'Dauerhaft löschen'})){
                trigger.focus({preventScroll:true});return;
              }
              await api(`designs/${design.id}/delete`,{confirm:true});
              await root.WolkenworteConfiguratorSession?.clearAccountDrafts?.(current.id,design.id);
            }
            await loadLibrary();
          },notice));
          if(action==='open')actions.append(button);else menu.append(button);
        }
        actions.append(options);
        card.append(image,title,product,saved,expires,actions);list.append(card);
      }
    }

    document.addEventListener('pointerdown',event=>{
      page.querySelectorAll('.ww-account-design-menu[open]').forEach(menu=>{if(!menu.contains(event.target))menu.open=false;});
    });
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape')page.querySelectorAll('.ww-account-design-menu[open]').forEach(menu=>{menu.open=false;menu.querySelector('summary').focus();});
    });

    function showEmailCodes(oldEmail,newEmail){pendingEmail={current:oldEmail,new:newEmail};page.querySelector('[data-account-email-codes]').hidden=false;}
    page.querySelector('[data-account-email-form]').addEventListener('submit',event=>{
      event.preventDefault();const form=event.currentTarget,data=values(form);
      void busy(form,async()=>{const result=await api('email',{email:data.email});showEmailCodes(result.currentEmail,result.newEmail);status(notice,'Die Bestätigungscodes wurden angefordert.');},notice);
    });
    for(const form of page.querySelectorAll('[data-account-email-code]'))form.addEventListener('submit',event=>{
      event.preventDefault();const data=values(form),email=pendingEmail?.[form.dataset.accountEmailCode];
      void busy(form,async()=>{const result=await api('email-verify',{email,code:data.code});form.reset();
        if(result.completed){page.querySelector('[data-account-email-codes]').hidden=true;pendingEmail=null;await refresh();status(notice,'Deine E-Mail-Adresse wurde geändert.');}
        else status(notice,'Ein Code wurde bestätigt. Bestätige auch die andere E-Mail-Adresse.');
      },notice);
    });

    const passwordForm=page.querySelector('[data-account-password-form]');
    passwordForm.addEventListener('submit',event=>{
      event.preventDefault();const data=values(passwordForm);
      void busy(passwordForm,async()=>{
        if(data.password!==data.repeat)throw{code:'password_mismatch'};
        try{await api('password',{password:data.password,...(data.code?{code:data.code}:{})});}
        catch(error){if(error.code==='reauthentication_needed'){
          passwordForm.querySelector('[data-account-password-code]').hidden=false;
          passwordForm.querySelector('[data-account-password-request]').hidden=false;
        }throw error;}
        passwordForm.reset();status(notice,'Dein Passwort wurde geändert.');
      },notice);
    });
    passwordForm.querySelector('[data-account-password-request]').addEventListener('click',()=>void busy(passwordForm,async()=>{
      await api('password-code',{});status(notice,'Der Sicherheitscode wurde angefordert.');
    },notice));

    const reauth=document.getElementById('account-reauth-dialog');
    reauth.querySelector('[data-reauth-close]').addEventListener('click',()=>reauth.close());
    reauth.querySelector('[data-reauth-google]').addEventListener('click',()=>void busy(reauth,async()=>{
      const data=await api('google',{purpose:'reauth',returnTo:'/konto/einstellungen'});location.assign(data.url);
    },reauth.querySelector('[data-reauth-status]')));
    reauth.querySelector('[data-reauth-form]').addEventListener('submit',event=>{
      event.preventDefault();const data=values(event.currentTarget);
      void busy(reauth,async()=>{await api('reauthenticate',{password:data.password});event.target.reset();reauth.close();await refresh();status(notice,'Deine Identität wurde bestätigt. Du kannst dein Konto jetzt löschen.');},reauth.querySelector('[data-reauth-status]'));
    });
    page.querySelector('[data-account-delete]').addEventListener('click',()=>void busy(page,async()=>{
      if(!current.recent){reauth.querySelector('[data-reauth-google]').hidden=!current.providers.includes('google');
        reauth.querySelector('[data-reauth-form]').hidden=!current.providers.includes('email');reauth.showModal();return;}
      if(!await confirm({title:'Konto dauerhaft löschen?',description:'Dein Konto und alle gespeicherten Designs werden sofort dauerhaft gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.',action:'Konto löschen'}))return;
      const id=current.id;
      try { await api('delete',{confirm:true}); }
      catch(error) { if(error.code==='reauthentication_needed'){current.recent=false;reauth.showModal();}throw error; }
      await clearOwnedDrafts(id);location.assign('/');
    },notice));
    page.querySelector('[data-account-logout]').addEventListener('click',()=>void busy(page,async()=>{
      const ownerId=current?.id;if(!ownerId)return;
      if(root.WolkenworteAccountMenu){
        await root.WolkenworteAccountMenu.signOut(ownerId);
        current=null;showSection(section);return;
      }
      await api('logout',{});
      current=null;showSection(section);
      await clearOwnedDrafts(ownerId);
      location.assign('/');
    },notice));
    root.addEventListener('wolkenworte:localechange',()=>void refresh().catch(error=>status(notice,message(error),true)));
    await refresh();
  }

  function createConfigurator({getSnapshot,getFingerprint,canSave=()=>true,prepare=async()=>{},preserve,onBeforeDialog,onSourceChange}){
    const dialog=document.getElementById('account-save-dialog');if(!dialog)return null;
    const authDialog=document.getElementById('account-auth-dialog');
    const form=dialog.querySelector('form');const notice=dialog.querySelector('[data-account-save-status]');
    const saveButtons=[...document.querySelectorAll('[data-account-save]')];
    let user=null,source=null,savedFingerprint=null,metadata=null,pendingSave=null,saving=false,starting=false,feedbackTimer=null;
    let selectedTarget=null;
    const latestButton=dialog.querySelector('[data-account-open-latest]');
    const existingButton=dialog.querySelector('[data-account-save-existing]');
    const targetList=dialog.querySelector('[data-account-save-targets]');
    const feedback=[...document.querySelectorAll('[data-account-save-note]')];
    const saveFeedback=(message='',error=false)=>feedback.forEach(element=>status(element,message,error));
    function changed(){
      const label=source?'Gespeichertes Design aktualisieren':'Im Konto speichern';
      const disabled=saving||starting||!canSave()||Boolean(source&&savedFingerprint===getFingerprint());
      for(const button of saveButtons){
        text(button.querySelector('[data-account-save-label]')||button,label);
        button.setAttribute('aria-label',t(label));
        button.disabled=disabled;
        button.setAttribute('aria-busy',String(saving||starting));
      }
    }
    function sourceChanged(){onSourceChange?.(source?{...source,fingerprint:savedFingerprint}:null);changed();}
    async function session(){const data=await api('session');user=data.user;
      root.dispatchEvent?.(new root.CustomEvent('wolkenworte:accountchange',{detail:{user:user&&!user.recovery?user:null}}));
      return user;}
    function showSave(){onBeforeDialog?.();selectedTarget=null;if(targetList){targetList.hidden=true;targetList.replaceChildren();}if(latestButton)latestButton.hidden=true;form.elements.name.value=metadata?.name||t('Mein Design');dialog.querySelector('[data-account-save-copy]').hidden=!source;dialog.showModal();form.elements.name.focus();}
    async function start(){
      await prepare();
      await session();
      if(source && user && user.id!==source.ownerId) throw{code:'account_unauthorized'};
      if(!user||user.recovery){onBeforeDialog?.();if(user?.recovery)authControl.recovery();authDialog.showModal();return;}
      showSave();
    }
    const authControl=bindAuth(authDialog.querySelector('[data-account-auth]'),{onDone:async()=>{await session();
      if(source&&user?.id!==source.ownerId)throw{code:'account_unauthorized'};
      authDialog.close();showSave();},
      returnTo:location.pathname+'?accountSave=1',beforeRedirect:preserve});
    for(const button of saveButtons)button.addEventListener('click',async()=>{
      if(starting||saving||!canSave())return;
      starting=true;changed();clearTimeout(feedbackTimer);saveFeedback();
      try{await start();}catch(error){saveFeedback(message(error),true);}
      finally{starting=false;changed();}
    });
    for(const button of document.querySelectorAll('[data-account-dialog-close]'))button.addEventListener('click',()=>button.closest('dialog').close());
    async function performSave(asNew=false){
      if(saving)return;
      saving=true;changed();
      const name=form.elements.name.value;
      try{return await busy(form,async()=>{
        await prepare();
        const snapshot=getSnapshot(),fingerprint=getFingerprint();
        const target=asNew?null:selectedTarget||source;
        const signature=JSON.stringify({name,fingerprint,asNew,id:target?.id,version:target?.version,owner:user.id,locale:I()?.getLocale()});
        if(pendingSave?.signature!==signature) pendingSave={signature,requestId:crypto.randomUUID(),
          designId:target?.id||crypto.randomUUID(),version:target?.version||0};
        let result;
        try { result=await api('designs',{name,ownerId:user.id,requestId:pendingSave.requestId,designId:pendingSave.designId,version:pendingSave.version,snapshot}); }
        catch(error){if(error.status && error.code!=='design_busy'&&(error.status<500||error.code==='account_storage_unavailable'))pendingSave=null;if(error.code==='design_conflict'&&latestButton)latestButton.hidden=false;throw error;}
        pendingSave=null;
        metadata=result.design;source={id:metadata.id,ownerId:user.id,version:metadata.version};savedFingerprint=fingerprint;
        root.WolkenworteAnalytics?.track('design_saved');
        sourceChanged();const recovered=await preserve();dialog.close();
        saveFeedback(recovered===false?'Im Konto gespeichert. Die lokale Sicherung konnte nicht erstellt werden.':'In deinen Designs gespeichert.',recovered===false);
        clearTimeout(feedbackTimer);feedbackTimer=recovered===false?null:setTimeout(()=>saveFeedback(),3000);
      },notice);}finally{saving=false;changed();}
    }
    form.addEventListener('submit',event=>{event.preventDefault();void performSave();});
    dialog.querySelector('[data-account-save-copy]').addEventListener('click',()=>{if(form.reportValidity())void performSave(true);});
    existingButton?.addEventListener('click',()=>void busy(existingButton,async()=>{
      const result=await api('designs');targetList.replaceChildren();targetList.hidden=false;
      for(const design of result.designs||[]){
        const button=document.createElement('button');button.type='button';button.className='ww-account-secondary';button.textContent=design.name;
        button.addEventListener('click',()=>{
          selectedTarget={id:design.id,version:design.version,ownerId:user.id};form.elements.name.value=design.name;
          targetList.hidden=true;dialog.querySelector('[data-account-save-copy]').hidden=false;
          status(notice,'Beim Speichern wird das ausgewählte Design im Konto ersetzt. Der Warenkorb bleibt unverändert.');
        });targetList.append(button);
      }
    },notice));
    latestButton?.addEventListener('click',()=>void busy(latestButton,async()=>{
      const id=selectedTarget?.id||source?.id;if(!id)return;
      if(!await preserve())throw{code:'draft_unavailable'};
      location.assign(location.pathname+'?accountDesign='+encodeURIComponent(id)+'&accountLatest=1');
    },notice));
    async function restore(id){
      await session();if(!user||user.recovery)throw{code:'account_unauthorized'};
      const result=await api(`designs/${id}/load`,{});metadata=result.design;
      source={id:metadata.id,ownerId:user.id,version:metadata.version};
      return metadata.snapshot;
    }
    function restored(){savedFingerprint=getFingerprint();sourceChanged();}
    async function validateLocal(ref){
      if(!ref)return true;await session();
      if(!user||user.recovery||user.id!==ref.ownerId)return false;
      try { metadata=(await api(`designs/${ref.id}/load`,{})).design; }
      catch(error) { if(error.status===404)return false;throw error; }
      if(metadata.version!==ref.version)return false;
      source={id:ref.id,ownerId:ref.ownerId,version:ref.version};savedFingerprint=ref.fingerprint;sourceChanged();return true;
    }
    async function inspectLocal(ref,fingerprint){
      await session();if(!user||user.recovery||user.id!==ref.ownerId)throw{code:'account_unauthorized'};
      metadata=(await api(`designs/${ref.id}/load`,{})).design;
      if(metadata.version!==ref.version)return {status:fingerprint===ref.fingerprint?'newer':'conflict',snapshot:metadata.snapshot};
      source={id:ref.id,ownerId:ref.ownerId,version:ref.version};savedFingerprint=ref.fingerprint;sourceChanged();
      return {status:'same',snapshot:metadata.snapshot};
    }
    function detach(){source=null;metadata=null;savedFingerprint=null;clearTimeout(feedbackTimer);saveFeedback();sourceChanged();}
    async function ready(){if(new URLSearchParams(location.search).has('accountSave')){
      history.replaceState(null,'',location.pathname);await start();
    }}
    root.addEventListener('wolkenworte:localechange',changed);
    changed();
    return {changed,restore,restored,validateLocal,inspectLocal,detach,ready,source:()=>source,authControl};
  }

  root.WolkenworteAccount={api,bindAuth,createConfigurator,message};
  const pageFailure=error=>status(document.getElementById('account-page-status'),message(error),true);
  root.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>void initializePage().catch(pageFailure));
  else void initializePage().catch(pageFailure);
}(window));
