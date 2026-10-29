// Local terminal recovery only. Never expose this module through the HTTP API.
const {DatabaseSync}=require('node:sqlite');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const {Writable}=require('node:stream');

function openExisting(filename){
  if(!fs.existsSync(filename))throw Error('No existe la base de datos. No se creó ni modificó ninguna base.');
  const db=new DatabaseSync(filename);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
  return db;
}
function administrators(db){
  return db.prepare("SELECT num,data FROM rows WHERE sheet='Login' AND num>1 ORDER BY num").all()
    .map(record=>({num:record.num,row:JSON.parse(record.data)}))
    .filter(record=>String(record.row[2]).trim().toLowerCase()==='admin');
}
function recoverAdmin(filename,{account,username,password,confirmation}){
  if(typeof password!=='string'||password.length<6||password.length>128)throw Error('La contraseña debe tener de 6 a 128 caracteres.');
  if(password!==confirmation)throw Error('Las contraseñas no coinciden.');
  const db=openExisting(filename);
  try {
    db.exec('BEGIN IMMEDIATE');
    const user=administrators(db).find(record=>record.row[0]===account);
    if(!user)throw Error('La cuenta administrativa seleccionada ya no existe.');
    const name=String(username||account).trim();
    if(!/^[a-zA-Z0-9._-]{3,64}$/.test(name))throw Error('Usa de 3 a 64 letras, números, puntos, guiones o guiones bajos para el usuario.');
    const duplicate=db.prepare("SELECT num,data FROM rows WHERE sheet='Login' AND num>1").all()
      .some(record=>record.num!==user.num && String(JSON.parse(record.data)[0]).trim().toLowerCase()===name.toLowerCase());
    if(duplicate)throw Error('Ese usuario ya existe.');
    const salt=crypto.randomBytes(16).toString('hex');
    user.row[0]=name;
    user.row[1]='scrypt$'+salt+'$'+crypto.scryptSync(password,salt,32).toString('hex');
    user.row[3]=true;
    db.prepare("UPDATE rows SET data=? WHERE sheet='Login' AND num=?").run(JSON.stringify(user.row),user.num);
    // Invalidate all administrative sessions; keep capture sessions and CaptureKey.
    for(const record of db.prepare("SELECT key,value FROM properties WHERE key LIKE 'CAPTURA_SESSION_%'").all()){
      let session;try{session=JSON.parse(record.value);}catch{session=null;}
      if(!session||session.role==='admin')db.prepare('DELETE FROM properties WHERE key=?').run(record.key);
    }
    db.exec('COMMIT');
    return {username:name};
  } catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  finally{db.close();}
}
function prompt(label,secret=false){
  return new Promise((resolve,reject)=>{
    process.stdout.write(label);
    const output=new Writable({write(chunk,encoding,callback){if(!secret)process.stdout.write(chunk);callback();}});
    const rl=readline.createInterface({input:process.stdin,output,terminal:true,historySize:0});
    let settled=false;
    rl.on('SIGINT',()=>rl.close());
    rl.on('close',()=>{if(!settled){settled=true;process.stdout.write('\n');reject(Error('Cancelado. No se modificó el acceso.'));}});
    rl.question('',answer=>{settled=true;rl.close();if(secret)process.stdout.write('\n');resolve(answer);});
  });
}
async function main(){
  if(process.argv.includes('--help')){
    console.log('Uso: node recover-admin.cjs\nRecupera un administrador desde Termux sin contraseña anterior.\nSolicita usuario y nueva contraseña oculta; requiere una terminal interactiva.\nNo acepta contraseñas como argumentos. Ctrl+C cancela antes de guardar.');return;
  }
  if(process.argv.length>2)throw Error('No pases credenciales como argumentos. Ejecuta el comando sin argumentos.');
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Abre Termux y ejecuta este comando en su terminal interactiva.');
  const filename=path.join(process.env.DATA_DIR||path.join(__dirname,'data'),'captura.sqlite');
  const db=openExisting(filename);
  let accounts;try{accounts=administrators(db);}finally{db.close();}
  if(!accounts.length)throw Error('No hay cuentas administrativas para recuperar.');
  console.log('Recuperar administrador local\nLa contraseña anterior no es necesaria. Se cerrarán las sesiones administrativas.');
  accounts.forEach((record,i)=>console.log(`${i+1}. ${record.row[0]}`));
  let index=0;
  if(accounts.length>1){
    const selection=await prompt('Número de cuenta: ');
    if(!/^[1-9][0-9]*$/.test(selection))throw Error('Selección inválida.');
    index=Number(selection)-1;if(!accounts[index])throw Error('Selección inválida.');
  }
  const account=accounts[index].row[0];
  const username=(await prompt(`Nuevo usuario (Enter conserva ${account}): `)).trim()||account;
  const password=await prompt('Nueva contraseña (6 a 128 caracteres, no se muestra): ',true);
  const confirmation=await prompt('Repite la nueva contraseña: ',true);
  // Validate before the final confirmation; no writes have occurred yet.
  if(password.length<6||password.length>128)throw Error('La contraseña debe tener de 6 a 128 caracteres.');
  if(password!==confirmation)throw Error('Las contraseñas no coinciden. No se modificó el acceso.');
  if((await prompt(`Guardar el acceso de ${username}? Escribe SI: `)).trim().toUpperCase()!=='SI')throw Error('Cancelado. No se modificó el acceso.');
  const result=recoverAdmin(filename,{account,username,password,confirmation});
  console.log(`Acceso recuperado. Usuario: ${result.username}\nInicia sesión con la nueva contraseña en http://127.0.0.1:8080\nLas capturas y la CaptureKey se conservaron. Los archivos de acceso inicial no se actualizan.`);
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={recoverAdmin};
