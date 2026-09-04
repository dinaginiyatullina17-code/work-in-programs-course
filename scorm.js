(function(){
  let api=null;
  function findApi(win){
    let attempts=0;
    while(win&&attempts<20){
      if(win.API)return win.API;
      if(win.parent===win)break;
      win=win.parent;
      attempts++;
    }
    return null;
  }
  function getApi(){
    if(api)return api;
    api=findApi(window);
    if(!api&&window.opener)api=findApi(window.opener);
    return api;
  }
  function initialize(){
    const scorm=getApi();
    if(!scorm)return false;
    const ok=scorm.LMSInitialize('')==='true';
    if(ok){
      const status=scorm.LMSGetValue('cmi.core.lesson_status');
      if(!status||status==='not attempted'){
        scorm.LMSSetValue('cmi.core.lesson_status','incomplete');
        scorm.LMSCommit('');
      }
    }
    return ok;
  }
  function complete(){
    const scorm=getApi();
    if(!scorm)return false;
    scorm.LMSSetValue('cmi.core.lesson_status','passed');
    scorm.LMSSetValue('cmi.core.score.raw','100');
    scorm.LMSCommit('');
    return true;
  }
  function finish(){const scorm=getApi();if(scorm)scorm.LMSFinish('')}
  window.SCORM={initialize,complete,finish};
  addEventListener('DOMContentLoaded',initialize);
  addEventListener('pagehide',finish);
})();
