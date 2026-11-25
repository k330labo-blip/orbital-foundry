import { NS } from "./config.js";

const LABEL = `${NS}:machine_label`;
const EXCLUDED = new Set(["conveyor_1","conveyor_2","conveyor_3","power_cable","fluid_pipe"].map(id=>NS+":"+id));

export function installMachineLabels({world,system,machines,labelHeight}) {
  const labels=new Map();
  world.afterEvents.entityLoad?.subscribe(({entity})=>{
    if(entity.typeId!==LABEL) return;
    for(const label of labels.values()) if(label.entity.id===entity.id) return;
    try{if(entity.isValid)entity.remove();}catch{}
  });
  system.runInterval(()=>{
    const aimed=new Map();
    for(const player of world.getPlayers()){
      try{
        const hit=player.getBlockFromViewDirection({maxDistance:6,includePassableBlocks:true});
        const block=hit?.block;
        if(!block || EXCLUDED.has(block.typeId)) continue;
        const name=machines[block.typeId]?.name;
        if(!name) continue;
        const {x,y,z}=block.location, dimension=block.dimension;
        const key=`${dimension.id}:${x},${y},${z}`;
        const tall=block.typeId===`${NS}:crusher` || block.typeId.includes("container") || block.typeId.includes("grower");
        const height=labelHeight?.(block.typeId)??(tall?1.85:1.3);
        aimed.set(key,{name,dimension,location:{x:x+.5,y:y+height,z:z+.5}});
      }catch{}
    }
    for(const [key,label] of labels){
      const current=aimed.get(key);
      if(label.entity.isValid && current?.name===label.name) continue;
      labels.delete(key);
      try{if(label.entity.isValid) label.entity.remove();}catch{}
    }
    for(const [key,target] of aimed){
      if(labels.has(key)) continue;
      try{
        const entity=target.dimension.spawnEntity(LABEL,target.location);
        entity.nameTag=target.name;
        labels.set(key,{entity,name:target.name});
      }catch{}
    }
  },4);
}
