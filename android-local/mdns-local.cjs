// Wi-Fi IPv4 mDNS announcement. No router or client configuration is required.
const os=require('node:os');
function startMdns(){
  let create;
  try{create=require('multicast-dns');}catch{console.log('mDNS no disponible: instala multicast-dns para usar captura.local.');return ()=>{};}
  const name='captura.local';
  let socket=null,current='',timers=[],closed=false;
  function clear(){timers.forEach(clearTimeout);timers=[];if(socket){socket.destroy();socket=null;}}
  function update(){
    if(closed)return;
    let address='';
    try{address=(os.networkInterfaces().wlan0||[]).find(a=>a.family==='IPv4'&&!a.internal)?.address||'';}catch(error){console.log('mDNS: '+error.message);return;}
    if(address===current)return;
    clear();current=address;
    if(!address){console.log('mDNS: esperando Wi-Fi.');return;}
    let ready=false,conflict=false;
    const mdns=create({interface:address,bind:'0.0.0.0',ttl:255});socket=mdns;
    const record=()=>({name,type:'A',ttl:30,flush:true,data:address});
    const announce=()=>{if(ready&&!conflict&&!closed)mdns.respond([record()]);};
    mdns.on('error',error=>console.log('mDNS error: '+error.message));
    mdns.on('warning',error=>console.log('mDNS aviso: '+error.message));
    mdns.on('response',packet=>{
      if([...(packet.answers||[]),...(packet.additionals||[])].some(r=>r.name.toLowerCase()===name && r.type==='A' && r.ttl>0 && r.data!==address)){
        if(!conflict)console.log('mDNS: captura.local ya pertenece a otro equipo; anuncio deshabilitado en esta red.');
        conflict=true;
      }
    });
    mdns.on('query',(packet,remote)=>{
      if(!ready||conflict)return;
      const questions=(packet.questions||[]).filter(q=>q.name.toLowerCase().replace(/\.$/,'')===name && (q.type==='A'||q.type==='ANY'));
      if(!questions.length)return;
      const unicast=remote.port!==5353||questions.some(q=>q.qu);
      const legacy=remote.port!==5353;
      mdns.respond({id:legacy?packet.id:0,questions:legacy?questions:[],answers:[{...record(),ttl:legacy?10:30,flush:!legacy}]},unicast?remote:undefined);
    });
    mdns.on('ready',()=>{
      for(const ms of [0,250,500])timers.push(setTimeout(()=>mdns.query(name,'ANY'),ms));
      timers.push(setTimeout(()=>{
        if(conflict)return;
        ready=true;announce();console.log('mDNS: '+name+' -> '+address);
        timers.push(setTimeout(announce,1000));
        const repeat=()=>{announce();if(!closed&&socket===mdns)timers.push(setTimeout(repeat,20000));};
        timers.push(setTimeout(repeat,20000));
      },1000));
    });
  }
  update();const monitor=setInterval(update,5000);
  return ()=>{closed=true;clearInterval(monitor);clear();};
}
module.exports={startMdns};
if(require.main===module){const close=startMdns();for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{close();process.exit(0);});}
