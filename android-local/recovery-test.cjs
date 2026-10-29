const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {openBackend}=require('./storage.cjs');
const {recoverAdmin}=require('./recover-admin.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'captura-recovery-'));
const file=path.join(dir,'captura.sqlite');
let backend=openBackend(file);
try{
  backend.setup('original-password','capture-key');
  const call=(method,...args)=>backend.call(method,args);
  const admin=call('login','admin','original-password');
  const second=call('login','admin','original-password');
  const capture=call('authorizeCaptureKey','capture-key',crypto.randomUUID());
  call('adminSaveLine',admin.token,{name:'Línea prueba'});
  call('adminSaveRoute',admin.token,{name:'Ruta prueba'});
  const app=call('getAppData',capture.token,{line:'Línea prueba'});
  call('saveEntry',capture.token,{operationId:crypto.randomUUID(),epoch:app.epoch,line:'Línea prueba',routeId:app.routes[0].id,mta:4,complete:true});
  const data=()=>backend.db.prepare("SELECT * FROM rows WHERE sheet!='Login' ORDER BY sheet,num").all();
  const before=JSON.stringify(data());
  const payload={account:'admin',username:'admin',password:'abc123',confirmation:'abc123'};
  assert.throws(()=>recoverAdmin(file,{...payload,confirmation:'wrong'}),/no coinciden/);
  assert.throws(()=>recoverAdmin(file,{...payload,password:'short',confirmation:'short'}),/6 a 128/);
  assert.throws(()=>recoverAdmin(file,{...payload,account:'absent'}),/no existe/);
  assert.throws(()=>recoverAdmin(file,{...payload,username:'invalid user'}),/3 a 64/);
  call('getAdminDashboard',admin.token,{}); // Cache the old session in the live server.
  recoverAdmin(file,payload); // Independent SQLite connection, as with the CLI process.
  assert.throws(()=>call('getAdminDashboard',admin.token,{}),/sesión/);
  assert.throws(()=>call('getAdminDashboard',second.token,{}),/sesión/);
  assert.throws(()=>call('login','admin','original-password'),/incorrectos/);
  const recovered=call('login','admin','abc123');
  assert.equal(call('getAdminDashboard',recovered.token,{}).captureKey,'capture-key');
  assert.equal(call('getAppData',capture.token,{line:'Línea prueba'}).history.length,1);
  assert.equal(JSON.stringify(data()),before);
  // Recovery also reactivates the selected account and allows renaming it.
  const row=JSON.parse(backend.db.prepare("SELECT data FROM rows WHERE sheet='Login' AND num=2").get().data);
  row[3]=false;
  backend.db.prepare("UPDATE rows SET data=? WHERE sheet='Login' AND num=2").run(JSON.stringify(row));
  recoverAdmin(file,{...payload,username:'owner'});
  backend.close();backend=openBackend(file);
  call('login','owner','abc123');
  assert.throws(()=>call('login','admin','abc123'),/incorrectos/);
  assert.equal(JSON.stringify(data()),before);
  const stored=backend.db.prepare("SELECT data FROM rows WHERE sheet='Login' AND num=2").get().data;
  assert.ok(stored.includes('scrypt$'));assert.ok(!stored.includes('abc123'));
  const missing=path.join(dir,'missing.sqlite');
  assert.throws(()=>recoverAdmin(missing,payload),/No existe/);assert.equal(fs.existsSync(missing),false);
  const cli=path.join(__dirname,'recover-admin.cjs');
  const help=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});assert.equal(help.status,0);
  const nonTTY=spawnSync(process.execPath,[cli],{encoding:'utf8',env:{...process.env,DATA_DIR:dir}});
  assert.equal(nonTTY.status,1);assert.match(nonTTY.stderr,/terminal interactiva/);
  const args=spawnSync(process.execPath,[cli,'not-accepted'],{encoding:'utf8'});
  assert.equal(args.status,1);assert.match(args.stderr,/No pases credenciales/);
  assert.equal(backend.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  console.log('PASS recovery: validation/rollback, existing database only, live cached sessions revoked, capture sessions/data preserved, password hash, reactivation/rename, restart, CLI guards');
}finally{backend.close();fs.rmSync(dir,{recursive:true,force:true});}
