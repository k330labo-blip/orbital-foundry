// Each deposit unit can be processed once. Raw inputs and all products use distinct IDs.
export function oreProcessing(ns) {
  const addon = name => ns + ":" + name;
  const vanilla = name => "minecraft:" + name;
  const ores = {
    iron: {name:"鉄", raw:vanilla("raw_iron"), product:addon("crushed_iron")},
    copper: {name:"銅", raw:vanilla("raw_copper"), product:addon("crushed_copper")},
    gold: {name:"金", raw:vanilla("raw_gold"), product:addon("crushed_gold")},
    nickel: {name:"ニッケル", raw:addon("raw_nickel"), product:addon("crushed_nickel"), early:"advanced_materials"},
    bauxite: {name:"ボーキサイト", raw:addon("raw_bauxite"), product:addon("crushed_bauxite"), early:"advanced_materials"},
    coal: {name:"石炭", raw:addon("unprocessed_coal"), product:vanilla("coal"), early:"metallurgy", costs:[[7,8],[11,20,1500],[18,40,2500]]},   // 序盤の燃料不足をやわらげるため金属加工で解禁。石炭1個=100 SE なので、8倍速+ドリル込みでも発電量が上回る電力にする
    redstone: {name:"レッドストーン", raw:addon("unprocessed_redstone"), product:vanilla("redstone"), early:"chemistry"},
    lapis: {name:"ラピスラズリ", raw:addon("unprocessed_lapis"), product:vanilla("lapis_lazuli"), early:"chemistry"},
    quartz: {name:"ネザー石英", raw:addon("unprocessed_quartz"), product:vanilla("quartz"), early:"chemistry"},
    sulfur: {name:"硫黄", raw:addon("unprocessed_sulfur"), product:addon("sulfur"), early:"chemistry"},
    nether_gold: {name:"ネザー金", raw:addon("unprocessed_nether_gold"), product:vanilla("gold_nugget"), early:"chemistry"},
    diamond: {name:"ダイヤモンド", raw:addon("unprocessed_diamond"), product:vanilla("diamond"), early:"large_scale_mining", costs:[[12,280],[20,600,2000],[32,2500,4000]]},
    emerald: {name:"エメラルド", raw:addon("unprocessed_emerald"), product:vanilla("emerald"), early:"large_scale_mining", costs:[[12,280],[20,600,2000],[32,2500,4000]]},
    uranium: {name:"ウラン", raw:addon("raw_uranium"), product:addon("crushed_uranium"), early:"nuclear_power", costs:[[14,750],[26,2500,2500],[40,8000,5000]]},
    ancient_debris: {name:"古代の残骸", raw:vanilla("ancient_debris"), product:addon("crushed_ancient_debris"), early:"orbital_mining", costs:[[16,1000],[28,3500,3000],[50,12000,6000]]},
  };
  const baseCosts=[[4,15],[7,80,1000],[14,400,2000]];
  const industrialCosts=[[6,55],[10,160,1500],[18,650,2500]];
  const stages=[["crusher","crush",2],["washer","wash",3],["ore_beneficiator","beneficiate",5]];
  const notes={
    iron:"粉砕鉄鉱はかまど・溶鉱炉で鉄インゴットに精錬できます。",
    copper:"粉砕銅鉱はかまど・溶鉱炉で銅インゴットに精錬できます。",
    gold:"粉砕金鉱はかまど・溶鉱炉で金インゴットに精錬できます。",
    nickel:"粉砕ニッケル鉱は電気炉で精錬できます。",
    bauxite:"粉砕ボーキサイトはプレス機でアルミ板に加工できます。",
    uranium:"粉砕ウラン鉱は電気炉で精錬できます。",
    ancient_debris:"粉砕古代残骸はかまど・溶鉱炉でネザライトの欠片に精錬できます。",
  };
  const recipes=Object.entries(ores).flatMap(([key,ore])=>
    stages.flatMap(([machine,verb,count],index)=>{
      // Preserve the original iron processing IDs, costs and existing saved selections.
      if(key==="iron" && index<2) return [];
      const [sec,energy,water]=(ore.costs??(ore.early==="chemistry"?industrialCosts:baseCosts))[index];
      const icon=(ore.product.startsWith(ns+":") ? ore.product : ore.raw).split(":")[1];
      return [{
        id:verb+"_"+key, machine, label:`${ore.name}を${count}倍に加工`,icon,
        in:[[ore.raw,1]],out:[[ore.product,count]],sec,energy,
        ...(water?{fluidsIn:[["water",water]]}:{}),
        technology:ore.early??[undefined,"advanced_materials","ore_beneficiation"][index],
        note:notes[key]??"鉱床から得た未処理鉱を使用します。",
      }];
    }));
  const finishing=[
    ["nickel","electric_furnace",addon("nickel_ingot"),6,25,"ニッケルインゴット"],
    ["bauxite","press",addon("aluminum_plate"),3,60,"アルミ板"],
    ["uranium","electric_furnace",addon("uranium_ingot"),12,2000,"ウランインゴット"],
  ].map(([key,machine,out,sec,energy,label])=>({
    id:"finish_crushed_"+key,machine,label:label+"（粉砕鉱から）",icon:out.split(":")[1],
    in:[[ores[key].product,1]],out:[[out,1]],sec,energy,technology:ores[key].early,
  }));
  return {ores,recipes:[...recipes,...finishing]};
}
