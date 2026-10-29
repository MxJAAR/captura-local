// Control this installation through authenticated loopback HTTP, not /proc.
const fs=require('node:fs');
const path=require('node:path');
async function main(){
  if(process.argv.includes('--help')){
    console.log('Uso: node stop-server.cjs [--status]\nDetiene solo el servidor de esta carpeta, incluso si está en segundo plano.');return;
  }
  const {request}=require('./local-control.cjs');
  const active=await request();
  if(process.argv.includes('--status')){console.log(active?'Servidor activo.':'Servidor detenido.');return;}
  if(!active){console.log('El servidor ya está detenido.');return;}
  await request('stop');
  let stopped=false;
  for(let i=0;i<30;i++){
    await new Promise(resolve=>setTimeout(resolve,200));
    try{if(!await request()){stopped=true;break;}}catch{}
  }
  if(!stopped)throw Error('El servidor no confirmó su detención. Revisa server.log.');
  const pidfile=path.join(__dirname,'server.pid');
  if(fs.existsSync(pidfile))fs.unlinkSync(pidfile);
  console.log('Servidor detenido. Tus datos se conservaron.');
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={stop:main};
