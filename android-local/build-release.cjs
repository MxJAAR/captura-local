// Publisher-only tool. The private key stays outside distributable files.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {BASE}=require('./update.cjs');
const root=__dirname, privateDir=path.join(root,'tools','release-private');
fs.mkdirSync(privateDir,{recursive:true});
const keyFile=path.join(privateDir,'signing-key.pem');
if(!fs.existsSync(keyFile)){
  if(fs.existsSync(path.join(root,'update-config.json')))throw Error('Falta la clave privada original. Recupérala antes de publicar; no se generará una clave incompatible con los teléfonos.');
  const pair=crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(keyFile,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
}
const key=fs.readFileSync(keyFile),publicKey=crypto.createPublicKey(key).export({type:'spki',format:'pem'});
const repository=process.env.RELEASE_REPOSITORY||'MxJAAR/captura-local';
if(!/^[\w.-]+\/[\w.-]+$/.test(repository))throw Error('Repositorio inválido.');
const config={manifest:`https://github.com/${repository}/releases/latest/download/version.json`,publicKey};
fs.writeFileSync(path.join(root,'update-config.json'),JSON.stringify(config,null,2)+'\n');
const version=JSON.parse(fs.readFileSync(path.join(root,'release.json'))).version;
if(!Number.isSafeInteger(version)||version<1)throw Error('Usa una versión entera positiva.');
const out=path.join(root,'dist'),manual=path.join(out,'android-local');
fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(manual,{recursive:true});
const files={};
function add(n){const b=fs.readFileSync(path.join(root,n));files[n]=b.toString('base64');const dest=path.join(manual,n);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,b);}
for(const n of BASE)add(n);
function walk(dir){for(const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){const n=dir+'/'+e.name;if(e.isSymbolicLink())throw Error('Enlace no permitido: '+n);if(e.isDirectory())walk(n);else add(n);}}
walk('node_modules');
const bundle=Buffer.from(JSON.stringify({version,files}));
fs.writeFileSync(path.join(out,'update.json'),bundle);
const payload=JSON.stringify({version,url:`https://github.com/${repository}/releases/download/v${version}/update.json`,sha256:crypto.createHash('sha256').update(bundle).digest('hex')});
fs.writeFileSync(path.join(out,'version.json'),JSON.stringify({payload,signature:crypto.sign(null,Buffer.from(payload),key).toString('base64')}));
console.log('Preparada versión '+version+' en '+out+' (sin data ni claves privadas).');
