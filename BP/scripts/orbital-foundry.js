import { STARFORGE_AUTH } from "./starforge-spec.js";
import { NS } from "./config.js";
import { CONSTRUCTION_PLAN, FOUNDRY_CARGO, FOUNDRY_STARTER, FOUNDRY_DELIVERIES,
  FOUNDRY_STARTUP_ENERGY, FOUNDRY_STARTUP_MS, FOUNDRY_DELIVERY_MS } from "./foundry-spec.js";

const KEY = "of:orbital_foundry_project";
const format = n=>n.toLocaleString("en-US");
const secondsLeft = (deadline,now)=>Math.max(0,Math.ceil((deadline-now)/1000));

export function installOrbitalFoundry(core) {
  const {world,system,gameClock,playerFlight,rocketStage,rocketPlan,selectPlan,research,keyOf,
    expansion,registry,countItem,removeItems,giveItems,nameOf,createForm,sameMachine,toast}=core;
  const startingSites=new Map();
  const terminal=NS+":orbital_terminal", landing=NS+":landing_pad";
  function read(player) {
    try {return {phase:"collecting",stock:{},...JSON.parse(player.getDynamicProperty(KEY)??"{}")};}
    catch {return {phase:"collecting",stock:{}};}
  }
  const save = (player,state)=>player.setDynamicProperty(KEY,JSON.stringify(state));
  const defeated = player=>Number(player.getDynamicProperty("of:boss_rank")??0)>0;
  const eligible = player=>rocketStage(player)>=4 && research.isUnlocked("orbital_industry",player);
  const readyCargo = state=>FOUNDRY_CARGO.every(([id,need])=>(state.stock[id]??0)>=need);
  function cargoIssue(player) {
    if(!eligible(player))return "軌道産業を研究し、自分の軌道便の貨物を一度回収してください";
    if(read(player).phase!=="collecting")return "軌道工廠の建設資材はすでに搬入済みです";
    if(!readyCargo(read(player)))return "軌道ターミナルで建設資材を揃えてください";
    if(!defeated(player))return "建設便を発射するにはオーバーシアの撃破が必要です";
  }
  function acceptConstruction(player,flight) {
    if(!flight?.foundryConstruction || flight.owner!==player.id || gameClock.now()<flight.readyAt)return false;
    const state=read(player);
    if(state.phase!=="collecting")return true;
    if(!readyCargo(state))return false;
    save(player,{phase:"delivered",stock:{}});
    return true;
  }
  function finalize(player) {
    const state=read(player);
    if(state.phase!=="starting" || gameClock.now()<state.readyAt)return state;
    const completed={phase:"complete",stock:{},dim:state.dim,completedAt:gameClock.now(),starter:true};
    save(player,completed);
    try {
      player.onScreenDisplay.setTitle("§b§l軌道工廠 完成",
        {subtitle:"§f本編クリア · 軌道資源の配送が解放されました",fadeInDuration:10,stayDuration:100,fadeOutDuration:25});
      player.playSound("random.levelup",{volume:.8,pitch:1});
    } catch {}
    try {
      const {x,y,z}=state.site, dim=world.getDimension(state.dim);
      dim.playSound("beacon.activate",{x:x+.5,y:y+1,z:z+.5},{volume:1.25,pitch:1.1});
      for(let level=1;level<=6;level++)dim.spawnParticle("minecraft:endrod",{x:x+.5,y:y+level,z:z+.5});
    } catch {}
    return completed;
  }
  const hasCompleted = player=>read(player).phase==="complete";
  const hasBombard = player=>{const st=read(player);return st.phase==="complete"&&!!st.bombard;};
  system.runInterval(()=>{
    for(const player of world.getPlayers()){
      try {
        const state=finalize(player);
        if(state.phase==="starting"){
          const {x,y,z}=state.site;
          startingSites.set(keyOf(state.dim,state.site),state.readyAt);
          const dim=world.getDimension(state.dim);
          if(dim.getBlock(state.site)?.typeId===terminal)
            dim.spawnParticle("minecraft:endrod",{x:x+.5,y:y+1.1,z:z+.5});
        }
      } catch {}
    }
    for(const [key,until] of startingSites)if(until<=gameClock.now())startingSites.delete(key);
  },20);

  function commission(player,block) {
    const state=read(player);
    if(!sameMachine(block,terminal) || state.phase!=="delivered" || !defeated(player))return "起動条件を確認してください";
    const site={...block.location},dim=block.dimension.id,key=keyOf(dim,site);
    expansion.updateNetwork(registry());
    if(!expansion.spend(key,FOUNDRY_STARTUP_ENERGY,false))return "軌道ターミナルにつないだ電力網に "+format(FOUNDRY_STARTUP_ENERGY)+" SE が必要です";
    const readyAt=gameClock.now()+FOUNDRY_STARTUP_MS;
    save(player,{phase:"starting",stock:{},site,dim,readyAt});
    startingSites.set(key,readyAt);
    try {block.dimension.playSound("beacon.activate",{x:site.x+.5,y:site.y+1,z:site.z+.5},{volume:.9,pitch:.7});} catch {}
  }
  function rewardList(player,block) {
    if(block?.typeId!==landing)return [];
    const state=finalize(player);
    if(state.phase!=="complete" || state.dim!==block.dimension.id)return [];
    const offers=[];
    if(!state.starforgeReward)offers.push({kind:"starforge",label:"星炉装備の製作用チップを受け取る",cargo:[[STARFORGE_AUTH,5]]});
    if(state.starter)offers.push({kind:"starter",label:"軌道工廠の完成報酬を回収",cargo:FOUNDRY_STARTER});
    const cargo=FOUNDRY_DELIVERIES[state.route];
    if(cargo && gameClock.now()>=state.nextAt)offers.push({kind:"route",label:"軌道工廠からの定期便を回収",cargo});
    return offers;
  }
  function claimReward(player,block,kind) {
    if(!sameMachine(block,landing))return false;
    const offer=rewardList(player,block).find(option=>option.kind===kind);
    if(!offer)return false;
    const state=read(player);
    if(kind==="starforge")state.starforgeReward=true;
    else if(kind==="starter")state.starter=false;
    else state.nextAt=gameClock.now()+FOUNDRY_DELIVERY_MS;
    save(player,state);
    for(const [id,quantity] of offer.cargo)giveItems(player,id,quantity);
    return true;
  }
  async function show(player,block,back) {
    const state=finalize(player);
    const flight=playerFlight(player);
    const actions=[];
    const form=createForm().title("軌道工廠の建設");
    const add=(label,action,icon)=>{form.button(label,icon);actions.push(action);};
    const icon=id=>"textures/items/"+id.split(":")[1];
    const cargoText=cargo=>cargo.map(([id,n])=>nameOf(id)+" ×"+n).join(" / ");
    if(!eligible(player)){
      form.body("自分の軌道便の貨物を着陸台で一度回収すると、軌道工廠の計画を始められます。");
    }else if(state.phase==="complete"){
      const route=FOUNDRY_DELIVERIES[state.route];
      form.body("§b本編クリア§r · 軌道工廠は稼働中です。\n\n"+
        (state.starter?"完成報酬が着陸台に届いています。\n":"")+
        "着陸台で星炉認証チップを受け取ると、作業台で星炉外骨格と四連自律砲を製作できます。\n"+
        (state.bombard?"§d軌道爆撃: 解禁済み§r · 指示器で地面を狙って使用\n":"星炉ウィザー: 鉄ブロックのT字に追尾・星炉・重装の頭部を並べ、星炉頭部に整備レンチ。撃破して終焉星核をここへ\n")+
        (route?("定期便 "+cargoText(route)+" · "+(gameClock.now()>=state.nextAt?"着陸台で回収可能":"到着まで "+secondsLeft(state.nextAt,gameClock.now())+" 秒")):"下の一覧から定期便の資源を選べます。")+
        "\n定期便は1便ごとに10分かかります。起動したディメンションの着陸台で回収します。");
      // 星炉ウィザーの終焉星核を送り返すと軌道爆撃が解禁される
      if(!state.bombard && countItem(player,NS+":end_star_core")>0)add("§5終焉星核を軌道工廠へ送り返す§r · 軌道爆撃を解禁",()=>{
        const current=read(player);
        if(current.phase!=="complete"||current.bombard||!removeItems(player,NS+":end_star_core",1))return;
        current.bombard=true;save(player,current);
        giveItems(player,NS+":orbital_strike_designator",1);
        try{player.dimension.playSound("beacon.power",player.location,{volume:1,pitch:.6});}catch{}
        toast(player,"§d軌道工廠が終焉星核を受理 · 軌道爆撃指示器を受け取りました");
      },icon(NS+":end_star_core"));
      if(state.bombard && countItem(player,NS+":orbital_strike_designator")<1)add("軌道爆撃指示器を再発行",()=>{
        if(read(player).bombard && countItem(player,NS+":orbital_strike_designator")<1)giveItems(player,NS+":orbital_strike_designator",1);
      },icon(NS+":orbital_strike_designator"));
      for(const [key,cargo] of Object.entries(FOUNDRY_DELIVERIES)){
        if(key===state.route)continue;
        add("定期便を設定 · "+cargoText(cargo),()=>{
          const current=read(player);
          if(current.phase!=="complete" || current.route===key)return;
          if(current.route && gameClock.now()>=current.nextAt)return toast(player,"到着済みの貨物を着陸台で回収してください");
          current.route=key;current.nextAt=gameClock.now()+FOUNDRY_DELIVERY_MS;
          save(player,current);
        },icon(cargo[0][0]));
      }
    }else if(state.phase==="starting"){
      form.body("軌道工廠の起動シーケンス中\n完了まで "+secondsLeft(state.readyAt,gameClock.now())+" 秒");
    }else if(state.phase==="delivered"){
      const key=keyOf(block.dimension.id,block.location);
      expansion.updateNetwork(registry());
      form.body("軌道への資材搬入・組み立てが完了しました。\n\n"+
        "起動用電力 "+format(expansion.availablePower(key,false))+" / "+format(FOUNDRY_STARTUP_ENERGY)+" SE\n"+
        "この軌道ターミナルに送電ケーブルをつないで起動してください。");
      add("軌道工廠を起動する · "+format(FOUNDRY_STARTUP_ENERGY)+" SE",()=>{
        const issue=commission(player,block);
        if(issue)toast(player,issue);
      },icon(NS+":foundry_stabilizer"));
    }else if(flight?.foundryConstruction){
      form.body("建設便が飛行中です。\n"+(gameClock.now()>=flight.readyAt
        ?"着陸台で搬入の完了を確認してください。"
        :"帰還まで "+secondsLeft(flight.readyAt,gameClock.now())+" 秒。帰還後に着陸台へ向かってください。"));
    }else{
      form.body("組立機で軌道工廠の部品を製作し、ここで投入して建設便に積み込みます。\n"+
        "オーバーシア撃破 "+(defeated(player)?"済み":"未達成")+"\n\n"+
        FOUNDRY_CARGO.map(([id,n])=>nameOf(id)+" "+(state.stock[id]??0)+" / "+n).join("\n")+
        (rocketPlan(player)===CONSTRUCTION_PLAN?"\n\n発射台で建設便を確認して発射してください。":""));
      add("持ち物から必要資材を投入",()=>{
        const current=read(player);
        if(current.phase!=="collecting" || playerFlight(player)?.foundryConstruction)return;
        let added=0;
        for(const [id,required] of FOUNDRY_CARGO){
          const have=current.stock[id]??0;
          const quantity=Math.min(required-have,countItem(player,id));
          if(quantity>0 && removeItems(player,id,quantity)){current.stock[id]=have+quantity;added+=quantity;}
        }
        if(added)save(player,current);
        else toast(player,"投入できる資材がありません");
      },icon(NS+":foundry_frame"));
      if(Object.values(state.stock).some(n=>n>0))add("投入済みの資材をすべて取り出す",()=>{
        const current=read(player);
        if(current.phase!=="collecting" || playerFlight(player)?.foundryConstruction)return;
        save(player,{...current,stock:{}});
        if(rocketPlan(player)===CONSTRUCTION_PLAN)selectPlan(player,-1,block);
        for(const [id,n] of Object.entries(current.stock))giveItems(player,id,n);
      });
      add("建設便を発射台に指定",()=>{
        const issue=cargoIssue(player);
        if(issue)return toast(player,issue);
        if(playerFlight(player))return toast(player,"先に現在の軌道便を荷下ろししてください");
        selectPlan(player,CONSTRUCTION_PLAN,block);
        toast(player,"建設便を指定しました。発射台で確認してください");
      },icon(NS+":foundry_relay"));
    }
    add("表示を更新",()=>{});
    form.button("軌道ターミナルへ戻る");
    const result=await form.show(player);
    if(result.canceled || !sameMachine(block,terminal))return;
    if(result.selection===actions.length)return back(player,block);
    if(!actions[result.selection])return;
    actions[result.selection]();
    return show(player,block,back);
  }
  return {hasCompleted,hasBombard,workingAt:key=>(startingSites.get(key)??0)>gameClock.now(),cargoIssue,acceptConstruction,rewardList,claimReward,show};
}
