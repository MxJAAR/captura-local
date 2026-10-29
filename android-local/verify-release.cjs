// Runs only against disposable data during release validation.
const {spawn}=require('node:child_process');
const path=require('node:path');
const child=spawn(process.execPath,[path.join(__dirname,'server.cjs')],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',MDNS_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
let output='',errors='',ok=false;
const timer=setTimeout(()=>{child.kill();process.exitCode=1;},10000);
child.stderr.on('data',b=>errors+=b);
child.stdout.on('data',async b=>{
  output+=b;const m=output.match(/puerto (\d+)/);if(!m||ok)return;ok=true;
  try{const r=await fetch('http://127.0.0.1:'+m[1]+'/health');if(!(await r.json()).ok)throw Error('health');}
  catch{process.exitCode=1;}finally{child.kill();}
});
child.on('error',e=>{console.error(e.message);clearTimeout(timer);process.exitCode=1;});
child.on('exit',()=>{clearTimeout(timer);if(!ok){console.error(errors);process.exitCode=1;}});
