const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const ROOT=__dirname;
const BASE=['index.html','Code.gs','server.cjs','storage.cjs','recover-admin.cjs','stop-server.cjs','control-server.cjs','local-control.cjs','install-shortcuts.cjs','mdns-local.cjs','package.json','package-lock.json','update.cjs','update-config.json','release.json','verify-release.cjs'];
function validName(n){return BASE.includes(n)||(/^node_modules\/[a-zA-Z0-9@_.\/-]+$/.test(n)&&!n.split('/').some(s=>s==='..'||s==='.'||s===''));}
async function download(url,limit,signal){
  if(new URL(url).protocol!=='https:')throw Error('La descarga requiere HTTPS.');
  const res=await fetch(url,{signal,headers:{'Cache-Control':'no-cache'}});
  if(!res.ok)throw Error('HTTP '+res.status);
  const chunks=[];let size=0;
  for await(const c of res.body){size+=c.length;if(size>limit)throw Error('Descarga demasiado grande.');chunks.push(c);}
  return Buffer.concat(chunks);
}
function verify(envelope,key){
  if(!crypto.verify(null,Buffer.from(envelope.payload),key,Buffer.from(envelope.signature,'base64')))throw Error('Firma de actualización inválida.');
  return JSON.parse(envelope.payload);
}
function recover(root=ROOT){
  const journal=path.join(root,'.update-journal.json');
  if(!fs.existsSync(journal))return;
  const entries=JSON.parse(fs.readFileSync(journal));
  for(const n of entries){
    if(!validName(n))throw Error('Registro de actualización inválido.');
    const old=path.join(root,'.update-backup',n),dest=path.join(root,n);
    if(fs.existsSync(old)){fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(old,dest);}
    else fs.rmSync(dest,{force:true});
  }
  fs.unlinkSync(journal);
  console.log('Se restauró la versión anterior tras una actualización incompleta.');
}
function install(bundle,root=ROOT){
  const entries=Object.entries(bundle.files||{});
  if(!entries.length||entries.some(([n,v])=>!validName(n)||typeof v!=='string'))throw Error('Archivos de actualización inválidos.');
  for(const n of BASE)if(!Object.hasOwn(bundle.files,n))throw Error('Paquete incompleto: '+n);
  const stage=path.join(root,'.update-stage'),backup=path.join(root,'.update-backup');
  fs.rmSync(stage,{recursive:true,force:true});fs.mkdirSync(stage);
  for(const [n,v] of entries){const dest=path.join(stage,n);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,Buffer.from(v,'base64'));}
  if(JSON.parse(fs.readFileSync(path.join(stage,'release.json'))).version!==bundle.version)throw Error('Versión inconsistente.');
  const check=spawnSync(process.execPath,[path.join(stage,'verify-release.cjs')],{cwd:stage,timeout:20000,encoding:'utf8',env:{...process.env,DATA_DIR:path.join(stage,'.test-data'),MDNS_DISABLED:'1'}});
  if(check.status!==0)throw Error('La nueva versión no pasó la prueba de arranque: '+(check.stderr||check.error?.message||''));
  fs.rmSync(backup,{recursive:true,force:true});fs.mkdirSync(backup);
  for(const [n] of entries){const src=path.join(root,n),dest=path.join(backup,n);if(fs.existsSync(src)){fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(src,dest);}}
  // The durable journal exists before touching installed code. Next start restores on interruption.
  fs.writeFileSync(path.join(root,'.update-journal.json'),JSON.stringify(entries.map(([n])=>n)),{flush:true});
  try{
    for(const [n] of entries){const dest=path.join(root,n);fs.mkdirSync(path.dirname(dest),{recursive:true});const tmp=dest+'.update-tmp';fs.copyFileSync(path.join(stage,n),tmp);fs.renameSync(tmp,dest);}
  }catch(e){recover(root);throw e;}
}
function commit(root=ROOT){fs.rmSync(path.join(root,'.update-journal.json'),{force:true});}
async function update(root=ROOT){
  const config=JSON.parse(fs.readFileSync(path.join(root,'update-config.json')));
  const current=JSON.parse(fs.readFileSync(path.join(root,'release.json'))).version;
  console.log('Buscando actualizaciones (versión '+current+')...');
  try{
    const signal=AbortSignal.timeout(15000);
    const manifest=verify(JSON.parse(await download(config.manifest,65536,signal)),config.publicKey);
    if(!Number.isSafeInteger(manifest.version)||manifest.version<=current){console.log('Ya tienes la versión actual.');return false;}
    const archive=await download(manifest.url,16*1024*1024,signal);
    if(crypto.createHash('sha256').update(archive).digest('hex')!==manifest.sha256)throw Error('La descarga está incompleta o fue modificada.');
    const bundle=JSON.parse(archive);
    if(bundle.version!==manifest.version)throw Error('Versión inconsistente.');
    install(bundle,root);console.log('Actualización preparada: '+bundle.version);return true;
  }catch(e){console.log('Se conserva la versión instalada: '+e.message);return false;}
}
module.exports={BASE,validName,verify,install,recover,commit,update};
