import { GameMode } from "@minecraft/server";
import { TECHNOLOGIES } from "./research.js";

export function installResearchDebug({ system, world }) {
  system.afterEvents.scriptEventReceive.subscribe(event => {
    if (event.id !== "orbital_foundry:research" || event.message.trim() !== "unlock_all") return;
    const player = event.sourceEntity;
    if (event.sourceBlock || player?.typeId !== "minecraft:player") return;
    if (player.getGameMode() !== GameMode.Creative) {
      player.sendMessage("全研究アンロックはクリエイティブ専用です。");
      return;
    }
    try {
      for (const technology of TECHNOLOGIES) {
        world.setDynamicProperty("of:research:" + technology.id, technology.count);
      }
      world.setDynamicProperty("of:research:selected", "");
      player.sendMessage(`全${TECHNOLOGIES.length}件の研究をアンロックしました。ワールド全体の研究に適用されます。`);
    } catch (error) {
      player.sendMessage("研究の保存に失敗しました。コマンドを再実行してください。");
      console.warn("[Orbital Foundry] Research debug unlock: " + error);
    }
  });
}
