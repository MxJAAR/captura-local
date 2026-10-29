// Local implementation of the small Apps Script storage surface used by Code.gs.
// Each API call is one SQLite transaction; no Google services or network storage.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function openBackend(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sheets(name TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS rows(sheet TEXT, num INTEGER, data TEXT, PRIMARY KEY(sheet,num));
    CREATE TABLE IF NOT EXISTS properties(key TEXT PRIMARY KEY,value TEXT);`);
  const getRow = db.prepare('SELECT data FROM rows WHERE sheet=? AND num=?');
  const putRow = db.prepare('INSERT OR REPLACE INTO rows VALUES(?,?,?)');
  const cache = new Map();
  class Range {
    constructor(sheet,r,c,n=1,m=1) { Object.assign(this,{sheet,r,c,n,m}); }
    getValues() {
      return Array.from({length:this.n},(_,i)=>{
        const row = JSON.parse(getRow.get(this.sheet.name,this.r+i)?.data || '[]');
        return Array.from({length:this.m},(_,j)=>row[this.c+j-1] ?? '');
      });
    }
    getValue() { return this.getValues()[0][0]; }
    setValues(values) {
      values.forEach((values,i)=>{
        const row = JSON.parse(getRow.get(this.sheet.name,this.r+i)?.data || '[]');
        values.forEach((value,j)=>{ row[this.c+j-1]=value; });
        putRow.run(this.sheet.name,this.r+i,JSON.stringify(row));
      }); return this;
    }
    setValue(value) { return this.setValues([[value]]); }
    clearContent() { return this.setValues(Array.from({length:this.n},()=>Array(this.m).fill(''))); }
    setNumberFormat() { return this; }
    setFontWeight() { return this; }
    createTextFinder(id) { return {matchEntireCell(){return this;},findNext:()=>{
      const i=this.getValues().findIndex(row=>String(row[0])===id);
      return i<0 ? null : {getRow:()=>this.r+i};
    }}; }
  }
  class Sheet {
    constructor(name) { this.name=name; }
    getName() { return this.name; }
    getRange(...args) { return new Range(this,...args); }
    getLastRow() {
      for (const row of db.prepare('SELECT num,data FROM rows WHERE sheet=? ORDER BY num DESC').iterate(this.name)) {
        if(JSON.parse(row.data).some(x=>x!=='' && x!==null)) return row.num;
      } return 0;
    }
    getLastColumn() { return db.prepare('SELECT COALESCE(MAX(json_array_length(data)),0) AS n FROM rows WHERE sheet=?').get(this.name).n; }
    appendRow(row) { putRow.run(this.name,this.getLastRow()+1,JSON.stringify(row)); return this; }
    deleteRow(n) { this.deleteRows(n,1); }
    deleteRows(n,count) {
      db.prepare('DELETE FROM rows WHERE sheet=? AND num>=? AND num<?').run(this.name,n,n+count);
      const tail=db.prepare('SELECT num,data FROM rows WHERE sheet=? AND num>=? ORDER BY num').all(this.name,n+count);
      for(const row of tail) {
        db.prepare('DELETE FROM rows WHERE sheet=? AND num=?').run(this.name,row.num);
        putRow.run(this.name,row.num-count,row.data);
      }
    }
    setFrozenRows() {}
  }
  const spreadsheet={getSheetByName:name=>db.prepare('SELECT name FROM sheets WHERE name=?').get(name)?new Sheet(name):null,
    insertSheet:name=>{db.prepare('INSERT INTO sheets VALUES(?)').run(name);return new Sheet(name);},getId:()=> 'local'};
  const properties={
    getProperty:key=>db.prepare('SELECT value FROM properties WHERE key=?').get(key)?.value ?? null,
    setProperty:(key,value)=>db.prepare('INSERT OR REPLACE INTO properties VALUES(?,?)').run(key,String(value)),
    deleteProperty:key=>db.prepare('DELETE FROM properties WHERE key=?').run(key),
    getProperties:()=>Object.fromEntries(db.prepare('SELECT * FROM properties').all().map(r=>[r.key,r.value]))
  };
  const ctx=vm.createContext({Date,console,JSON,Math,
    PropertiesService:{getScriptProperties:()=>properties},
    CacheService:{getScriptCache:()=>({get:key=>{const v=cache.get(key);if(v?.until>Date.now())return v.value;cache.delete(key);return null;},
      put:(key,value,seconds=60)=>{if(cache.size>2000)cache.clear();cache.set(key,{value,until:Date.now()+seconds*1000});},remove:key=>cache.delete(key)})},
    SpreadsheetApp:{openById:()=>spreadsheet,getActiveSpreadsheet:()=>spreadsheet,flush(){}},
    // Calls run synchronously in one process inside BEGIN IMMEDIATE; SQLite provides the lock.
    LockService:{getScriptLock:()=>({waitLock(){},tryLock:()=>true,releaseLock(){}})},
    Utilities:{getUuid:()=>crypto.randomUUID(),DigestAlgorithm:{SHA_256:'sha256'},
      computeDigest:(alg,text)=>crypto.createHash(alg).update(text).digest(),
      computeHmacSha256Signature:(text,key)=>Array.from(crypto.createHmac('sha256',key).update(text).digest()),
      base64EncodeWebSafe:b=>Buffer.from(b).toString('base64url'),newBlob:s=>({getBytes:()=>Buffer.from(s)})}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'Code.gs'),'utf8'),ctx);
  // Passwords in the local database are salted scrypt hashes.
  ctx.passwordMatches_=(stored,supplied)=>{
    const [prefix,salt,hash]=stored.split('$');
    if(prefix!=='scrypt'||!salt||!hash)return false;
    const actual=crypto.scryptSync(supplied,salt,32),expected=Buffer.from(hash,'hex');
    return expected.length===actual.length && crypto.timingSafeEqual(expected,actual);
  };
  function passwordHash(password) {
    const salt=crypto.randomBytes(16).toString('hex');
    return 'scrypt$'+salt+'$'+crypto.scryptSync(password,salt,32).toString('hex');
  }
  ctx.adminUpdateCredentials=(token,payload={})=>{
    const session=ctx.requireAdmin_(token);
    const user=ctx.findUser_(session.username.toLowerCase());
    if(typeof payload.currentPassword!=='string' || payload.currentPassword.length>128 ||
       !ctx.passwordMatches_(user.password,payload.currentPassword))throw Error('La contraseña actual es incorrecta.');
    const username=String(payload.username || user.username).trim();
    const password=payload.newPassword;
    if(!/^[a-zA-Z0-9._-]{3,64}$/.test(username))throw Error('El usuario debe tener de 3 a 64 letras, números, puntos, guiones o guiones bajos.');
    if(typeof password!=='string' || (password.length && (password.length<6 || password.length>128)))throw Error('La nueva contraseña debe tener de 6 a 128 caracteres.');
    if(password!==payload.confirmPassword)throw Error('Las nuevas contraseñas no coinciden.');
    if(username===user.username && !password)throw Error('Escribe un nuevo usuario o una nueva contraseña.');
    const duplicate=ctx.findUser_(username.toLowerCase());
    if(duplicate && duplicate.row!==user.row)throw Error('Ese usuario ya existe.');
    spreadsheet.getSheetByName('Login').getRange(user.row,1,1,2)
      .setValues([[username,password ? passwordHash(password) : user.password]]);
    // Revoke both cached and durable sessions, including this request's session.
    for(const [key,value] of Object.entries(properties.getProperties())) {
      if(!key.startsWith('CAPTURA_SESSION_'))continue;
      const stored=JSON.parse(value);
      if(stored.role==='admin' && stored.username.toLowerCase()===user.username.toLowerCase())properties.deleteProperty(key);
    }
    cache.clear();
    return {ok:true,username};
  };
  let dataVersion=db.prepare('PRAGMA data_version').get().data_version;
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Termux recovery can update this database from another process.
      const current=db.prepare('PRAGMA data_version').get().data_version;
      if(current!==dataVersion){cache.clear();dataVersion=current;}
      const result=fn();db.exec('COMMIT');return result;
    }
    catch(error) { db.exec('ROLLBACK');cache.clear();throw error; }
  }
  function setup(password,key) {
    if(properties.getProperty('CAPTURA_SPREADSHEET_ID'))return false;
    transaction(()=>{
      const hash=passwordHash(password);
      const login=spreadsheet.insertSheet('Login');
      login.appendRow(['Usuario','Contraseña','Rol','Activo','CaptureKey']);
      login.appendRow(['admin',hash,'admin',true,key]);
      ctx.initializeApp();
    });return true;
  }
  return {db,setup,call:(name,args)=>transaction(()=>ctx[name](...args)),close:()=>db.close()};
}
module.exports={openBackend};
