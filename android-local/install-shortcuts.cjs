const fs=require('node:fs');
const path=require('node:path');
const prefix=process.env.PREFIX||'/data/data/com.termux/files/usr';
const marker='# captura-local shortcut';
const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
if(!fs.existsSync(path.join(prefix,'bin/bash')))throw Error('Ejecuta este instalador dentro de Termux.');
const commands={};
for(const name of ['start','stop','status'])commands[name]=`exec ${quote(process.execPath)} ${quote(path.join(__dirname,'control-server.cjs'))} ${name} "$@"`;
commands.IniciarAdmin=`if [ -n "$DATA_DIR" ]; then exec cat "$DATA_DIR/acceso-inicial.txt"; else exec cat ${quote(path.join(__dirname,'data/acceso-inicial.txt'))}; fi`;
commands.RecuperarAdmin=`exec ${quote(process.execPath)} ${quote(path.join(__dirname,'recover-admin.cjs'))} "$@"`;
commands.IP='if ! command -v ifconfig >/dev/null 2>&1; then echo "Falta ifconfig. Ejecuta: pkg install net-tools"; exit 1; fi\nexec ifconfig "$@"';
// Check all destinations before modifying any existing command.
for(const name of Object.keys(commands)){
  const file=path.join(prefix,'bin',name);
  if(fs.existsSync(file)&&!fs.readFileSync(file,'utf8').includes(marker))throw Error('Ya existe otro comando '+name+'. No se reemplazó.');
}
for(const [name,command] of Object.entries(commands)){
  const file=path.join(prefix,'bin',name);
  fs.writeFileSync(file,`#!${prefix}/bin/bash\n${marker}\n${command}\n`,{mode:0o700});
  fs.chmodSync(file,0o700);
}
console.log('Listo: start, stop, status, IniciarAdmin, RecuperarAdmin e IP funcionan desde cualquier carpeta de Termux.');
