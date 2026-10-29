const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const file=()=>path.join(process.env.DATA_DIR||path.join(__dirname,'data'),'control-token');
function serverToken(){
  if(!fs.existsSync(file()))fs.writeFileSync(file(),crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
  return fs.readFileSync(file(),'utf8').trim();
}
function allowed(req,token){
  const peer=req.socket.remoteAddress;
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)||req.headers.origin)return false;
  const actual=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+token);
  return actual.length===expected.length && crypto.timingSafeEqual(actual,expected);
}
async function request(action='status'){
  const token=fs.existsSync(file())?fs.readFileSync(file(),'utf8').trim():'';
  try{
    const r=await fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/__local-control'+(action==='stop'?'/stop':''),{
      method:action==='stop'?'POST':'GET',headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(1500)
    });
    if(!r.ok)throw Error('El puerto está ocupado por un servidor anterior o de otra instalación. No se puede controlarlo con esta clave.');
    const result=await r.json();
    if(result.control!=='captura-local')throw Error('El puerto está ocupado por otro servicio.');
    return result;
  }catch(error){if(error.cause?.code==='ECONNREFUSED')return null;throw error;}
}
module.exports={serverToken,allowed,request};
