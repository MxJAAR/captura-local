const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {allowed}=require('./local-control.cjs');
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'captura-control-'));
  const env={...process.env,DATA_DIR:dir,PORT:'8098',HOST:'127.0.0.1',MDNS_DISABLED:'1'};
  const server=spawn(process.execPath,[path.join(__dirname,'server.cjs')],{env,stdio:['ignore','pipe','pipe']});
  const exited=new Promise(resolve=>server.once('exit',resolve));
  try{
    await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(Error('Exit '+code)));});
    const token=fs.readFileSync(path.join(dir,'control-token'),'utf8').trim();
    const url='http://127.0.0.1:8098/__local-control';
    assert.equal((await fetch(url)).status,403);
    assert.equal((await fetch(url+'/stop',{method:'POST',headers:{authorization:'Bearer wrong'}})).status,403);
    assert.equal((await fetch(url+'/stop',{method:'POST',headers:{authorization:'Bearer '+token,origin:'http://127.0.0.1:8098'}})).status,403);
    assert.equal(allowed({socket:{remoteAddress:'192.168.1.2'},headers:{authorization:'Bearer '+token}},token),false);
    assert.equal((await fetch(url,{headers:{authorization:'Bearer '+token}})).status,200);
    const run=arg=>new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[path.join(__dirname,'control-server.cjs'),arg],{env});
      let output='';child.stdout.on('data',s=>output+=s);child.stderr.on('data',s=>output+=s);
      child.once('exit',code=>code?reject(Error(output)):resolve(output));
    });
    assert.match(await run('status'),/Servidor activo/);
    assert.match(await run('start'),/ya está activo/);
    assert.match(await run('stop'),/Servidor detenido/);
    await exited;
    assert.match(await run('status'),/Servidor detenido/);
    assert.match(await run('stop'),/ya está detenido/);
    assert.ok(fs.existsSync(path.join(dir,'captura.sqlite')));
    assert.equal(fs.readFileSync(path.join(dir,'control-token'),'utf8').trim(),token);
    console.log('PASS local control: protected token, loopback only, browser origins blocked, independent CLI status/start/stop, idempotent stop, data preserved');
  }finally{if(server.exitCode===null){server.kill();await exited;}fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
