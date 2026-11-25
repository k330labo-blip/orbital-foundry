import { NS } from "./config.js";

export const SOLAR = {
  [`${NS}:solar_generator`]: { name: "太陽光発電機", rate: 100, capacity: 5000 },
  [`${NS}:solar_concentrator`]: { name: "集光型太陽光発電機", rate: 600, capacity: 24000 },
};

export function sunlightStatus(block, time) {
  if (block.dimension.id !== "minecraft:overworld") return "オーバーワールド専用";
  if (time < 0 || time >= 12000) return "夜間停止";
  const {x,y,z}=block.location;
  const top=block.dimension.getTopmostBlock({x,z});
  return top && top.location.y <= y ? "日照あり" : "上空に遮蔽物";
}

export function installSolar(core) {
  const {world,system,registry,research,generatorRecord,generatorCapacity,saveGeneratorRecord,setBlockActive,createForm,sameMachine} = core;
  system.runInterval(()=>{
    const time=world.getTimeOfDay();
    for(const m of registry()){
      const spec=SOLAR[m.type];
      if(!spec || !research.allowsMachine(m.type,m))continue;
      try {
        const block=world.getDimension(m.dim).getBlock(m);
        if(block?.typeId!==m.type)continue;
        const record=generatorRecord(m.key);
        const amount=sunlightStatus(block,time)==="日照あり"
          ? Math.max(0,Math.min(spec.rate,generatorCapacity(m.key)-record.stored)) : 0;
        if(amount){
          record.stored+=amount;
          record.generated+=amount;
          saveGeneratorRecord(m.key,record);
        }
        setBlockActive(block,m.type,m.key,amount>0);
      }catch{}
    }
  },20);

  async function show(player,block,key){
    const type=block.typeId, spec=SOLAR[type], record=generatorRecord(key);
    const limit=generatorCapacity(key);
    const sunlight=sunlightStatus(block,world.getTimeOfDay());
    const status=sunlight==="日照あり" && record.stored>=limit ? "蓄電満杯" : sunlight;
    const form=createForm().title(spec.name)
      .body(`${status}\n発電出力　最大 ${spec.rate} SE/秒\n蓄電　${record.stored} / ${limit} SE\n\n昼間に空が見える場所へ設置し、送電ケーブルをつないでください。`)
      .button("表示を更新").button("閉じる");
    const result=await form.show(player);
    if(result.canceled||!sameMachine(block,type))return;
    if(result.selection===0)return show(player,block,key);
  }
  return {show};
}
