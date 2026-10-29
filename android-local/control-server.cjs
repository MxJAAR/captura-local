const fs=require('node:fs');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {stop}=require('./stop-server.cjs');
const {request}=require('./local-control.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  const action=process.argv[2];
  if(action==='status'){console.log(await request()?'Servidor activo: http://127.0.0.1:8080':'Servidor detenido. Escribe start para iniciarlo.');return;}
  if(action==='stop'){
    await stop();spawnSync('termux-wake-unlock',[],{stdio:'ignore'});return;
  }
  if(action!=='start')throw Error('Usa start, stop o status.');
  if(await request()){console.log('El servidor ya está activo: http://127.0.0.1:8080');return;}
  if(process.env.CAPTURA_UPDATE_CHILD!=='1'){
    const updater=require('./update.cjs');
    const lock=path.join(__dirname,'.start-lock');
    try{fs.mkdirSync(lock);}catch{
      const pid=Number(fs.readFileSync(path.join(lock,'pid'),'utf8'));
      try{process.kill(pid,0);throw Error('Ya hay un inicio en curso. Espera unos segundos.');}
      catch(e){if(e.code!=='ESRCH')throw e;}
      fs.rmSync(lock,{recursive:true,force:true});fs.mkdirSync(lock);
    }
    fs.writeFileSync(path.join(lock,'pid'),String(process.pid));
    try{
      updater.recover();
      const changed=await updater.update();
      const run=()=>spawnSync(process.execPath,[__filename,'start'],{stdio:'inherit',env:{...process.env,CAPTURA_UPDATE_CHILD:'1'}});
      let result=run();
      if(result.status!==0&&changed){updater.recover();result=run();}
      if(result.status!==0)throw Error('No se pudo iniciar el servidor.');
      updater.commit();return;
    }finally{fs.rmSync(lock,{recursive:true,force:true});}
  }
  const log=fs.openSync(path.join(__dirname,'server.log'),'a',0o600);
  let child;
  try{child=spawn(process.execPath,[path.join(__dirname,'server.cjs')],{cwd:__dirname,detached:true,stdio:['ignore',log,log]});}
  finally{fs.closeSync(log);}
  let error;child.on('error',e=>{error=e;});child.unref();
  for(let i=0;i<20;i++){
    await sleep(200);
    if(error)throw error;
    if(child.exitCode!==null)throw Error('No se pudo iniciar. Revisa ~/captura-local/server.log.');
    try{
      if(await request()){
        fs.writeFileSync(path.join(__dirname,'server.pid'),String(child.pid));
        spawnSync('termux-wake-lock',[],{stdio:'ignore'});
        console.log('Servidor iniciado: http://127.0.0.1:8080\nPuedes seguir usando esta terminal. Para apagarlo escribe stop.');return;
      }
    }catch{}
  }
  if(child.exitCode===null)child.kill('SIGTERM');
  throw Error('El servidor no respondió. Revisa ~/captura-local/server.log.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
