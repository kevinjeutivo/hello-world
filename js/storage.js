// PutSeller Pro -- storage.js
// localStorage wrapper with QuotaExceededError handling.

const S={
  get:k=>{try{return JSON.parse(localStorage.getItem(k));}catch{return null;}},
  set:(k,v)=>{
    try{
      localStorage.setItem(k,JSON.stringify(v));
    }catch(e){
      if(e.name==='QuotaExceededError'||e.code===22){
        console.warn('Storage full -- could not save',k);
        toast('Storage full -- clear cached data in Settings',4000);
      }
    }
  },
  del:k=>localStorage.removeItem(k)
};
