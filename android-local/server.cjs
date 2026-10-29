const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {openBackend}=require('./storage.cjs');
const directory=process.env.DATA_DIR || path.join(__dirname,'data');
fs.mkdirSync(directory,{recursive:true,mode:0o700});
const backend=openBackend(path.join(directory,'captura.sqlite'));
const localControl=require('./local-control.cjs');
const controlToken=localControl.serverToken();
const password=crypto.randomBytes(6).toString('base64url');
const key=crypto.randomBytes(9).toString('base64url');
if(backend.setup(password,key)) fs.writeFileSync(path.join(directory,'acceso-inicial.txt'),
  `Usuario: admin\nContraseña: ${password}\nCaptureKey: ${key}\n`,{mode:0o600});
const methods=new Set(['login','authorizeCaptureKey','logout','getAppData','setSelectedLine','saveEntry','deleteEntry',
  'getAdminDashboard','adminSaveLine','adminSaveRoute','adminSaveCaptureKey','adminDeleteLine','adminDeleteRoute',
  'adminDeleteCatalogItems','setCaptureEnabled','resetCapture','exportEntries','adminUpdateCredentials']);
const attempts=new Map();
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  try {
    if(req.url==='/__local-control'||req.url==='/__local-control/stop'){
      if(!localControl.allowed(req,controlToken))return json(403,{error:'Acceso local no autorizado'});
      if(req.url==='/__local-control'&&req.method==='GET')return json(200,{control:'captura-local',running:true});
      if(req.url==='/__local-control/stop'&&req.method==='POST'){
        json(200,{control:'captura-local',stopping:true});setImmediate(shutdown);return;
      }
      return json(405,{error:'Método no permitido'});
    }
    if(req.method==='GET' && (req.url==='/' || req.url==='/index.html')) {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      return res.end(fs.readFileSync(path.join(__dirname,'index.html')));
    }
    if(req.method==='GET' && req.url==='/health')return json(200,{ok:true,storage:'sqlite'});
    if(req.method!=='POST' || req.url!=='/api')return json(404,{error:'No encontrado'});
    if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`)return json(403,{error:'Origen no permitido'});
    if(!/^application\/json\b/.test(req.headers['content-type'] || ''))return json(415,{error:'Se requiere JSON'});
    let body='';
    for await(const chunk of req) {body+=chunk;if(Buffer.byteLength(body)>65536)return json(413,{error:'Solicitud demasiado grande'});}
    const {method,args}=JSON.parse(body);
    if(!methods.has(method)||!Array.isArray(args)||args.length>5)return json(400,{error:'Solicitud inválida'});
    if(method==='login'||method==='authorizeCaptureKey'||method==='adminUpdateCredentials') {
      const ip=req.socket.remoteAddress;
      const now=Date.now();
      for(const [k,v] of attempts)if(v.until<now)attempts.delete(k);
      const attempt=attempts.get(ip)||{count:0,until:now+60000};
      if(++attempt.count>30)return json(429,{error:'Espera un minuto antes de intentar nuevamente.'});
      attempts.set(ip,attempt);
    }
    const result=backend.call(method,args);
    json(200,{result});
  } catch(error) {json(400,{error:error.message || 'Error del servidor'});}
});
server.requestTimeout=15000;
let stopMdns=()=>{};
server.listen(Number(process.env.PORT||8080),process.env.HOST||'0.0.0.0',()=>{
  console.log('Captura local escuchando en puerto '+server.address().port);
  if(process.env.MDNS_DISABLED!=='1')stopMdns=require('./mdns-local.cjs').startMdns();
});
let closing=false;
function shutdown(){
  if(closing)return;closing=true;stopMdns();
  server.close(()=>{backend.close();process.exit(0);});
  server.closeIdleConnections();
  setTimeout(()=>server.closeAllConnections(),2000).unref();
}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
