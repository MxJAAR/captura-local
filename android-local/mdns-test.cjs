const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
let ip='192.168.1.2',next=0,now=0;
const timers=new Map(),sockets=[];
function timer(fn,ms,repeat=false){const id=++next;timers.set(id,{fn,at:now+ms,ms,repeat});return id;}
function advance(ms){const end=now+ms;while(true){const item=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!item||item[1].at>end)break;const [id,t]=item;now=t.at;timers.delete(id);if(t.repeat)timers.set(id,{...t,at:now+t.ms});t.fn();}now=end;}
const context={module:{exports:{}},console:{log(){}},setTimeout:timer,clearTimeout:id=>timers.delete(id),setInterval:(fn,ms)=>timer(fn,ms,true),clearInterval:id=>timers.delete(id),
  require:name=>name==='node:os'?{networkInterfaces:()=>({wlan0:ip?[{address:ip,family:'IPv4',internal:false,mac:'00:00:00:00:00:00'}]:[]})}:options=>{
    const socket=new EventEmitter();Object.assign(socket,{options,sent:[],queries:[],respond:(...args)=>socket.sent.push(args),query:(...args)=>socket.queries.push(args),destroy:()=>{socket.destroyed=true;}});sockets.push(socket);return socket;
  }};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'mdns-local.cjs'),'utf8'),context);
const close=context.module.exports.startMdns();
let socket=sockets[0];assert.equal(socket.options.interface,ip);
socket.emit('ready');advance(1000);
assert.equal(socket.queries.length,3);assert.equal(socket.sent[0][0][0].data,ip);
socket.emit('query',{id:21,questions:[{name:'captura.local',type:'A'}]},{address:'192.168.1.9',port:49000});
let response=socket.sent.at(-1);assert.equal(response[0].id,21);assert.equal(response[1].port,49000);assert.equal(response[0].answers[0].flush,false);
const count=socket.sent.length;
socket.emit('query',{questions:[{name:'other.local',type:'A'}]},{address:'192.168.1.9',port:5353});assert.equal(socket.sent.length,count);
ip='192.168.2.3';advance(4000);assert.equal(socket.destroyed,true);
socket=sockets[1];assert.equal(socket.options.interface,ip);socket.emit('ready');advance(1000);assert.equal(socket.sent[0][0][0].data,ip);
socket.emit('response',{answers:[{name:'captura.local',type:'A',ttl:30,data:'192.168.2.4'}]});
const afterConflict=socket.sent.length;
socket.emit('query',{questions:[{name:'captura.local',type:'A'}]},{address:'192.168.2.9',port:5353});advance(21000);assert.equal(socket.sent.length,afterConflict);
ip='';advance(5000);assert.equal(socket.destroyed,true);
close();assert.equal(timers.size,0);
console.log('PASS mDNS: hidden Android MAC, correct Wi-Fi address, probes, legacy unicast, unrelated names ignored, IP change, conflict suppression, Wi-Fi disconnect, shutdown');
