// Income Engine -- storage.js
// localStorage wrapper with QuotaExceededError handling.

const S={
  get:k=>{try{return JSON.parse(localStorage.getItem(k));}catch{return null;}},
  // Returns true if the value was persisted, false if the write failed for ANY
  // reason (quota, private-mode SecurityError, unserializable value, ...).
  // Callers that report success -- health flags, "fresh" markers -- should gate
  // on the result. localStorage.setItem is atomic, so a failed write leaves any
  // previous value for the key intact. Existing callers that ignore the return
  // value are unaffected.
  set:(k,v)=>{
    try{
      localStorage.setItem(k,JSON.stringify(v));
      return true;
    }catch(e){
      try{
        if(e&&(e.name==='QuotaExceededError'||e.code===22)){
          console.warn('Storage full -- could not save',k);
          toast('Storage full -- clear cached data in Settings',4000);
        }else{
          console.warn('Storage write failed for',k,e&&e.name,e&&e.message);
          if(!S._warnedNonQuota){S._warnedNonQuota=true;toast('Could not save data ('+((e&&e.name)||'error')+')',4000);} // once per session
        }
      }catch{} // never let reporting a failure throw out of S.set
      return false;
    }
  },
  del:k=>localStorage.removeItem(k)
};
