import { WallGoGame } from './wallgo_logic.js';
import { WallGoAI } from './ai_agent.js';
import { loadModel } from './model_io.js';

const game = new WallGoGame();
game.pieces = [{color:'red',r:0,c:2},{color:'red',r:0,c:10},
               {color:'blue',r:12,c:2},{color:'blue',r:12,c:10}];
game.phase = 'movement';

for (const dir of ['./alpha_model_best', './alpha_model']) {
  const agent = new WallGoAI(await loadModel(dir));
  const branching = agent.getActionMask(game, 'red').filter(v => v).length;
  console.log(`\n${dir}  (合法動作 ${branching} 個)`);
  for (const sims of [200, 800]) {
    const policy = await agent.getMCTSPolicy(game, 'red', sims, 1.0);
    const nz = policy.filter(p => p > 0).sort((a,b) => b-a);
    const top = nz.slice(0,5).map(p => (p*100).toFixed(1)+'%').join(' ');
    // 有效動作數：exp(熵)，均勻分佈時等於分支數
    const H = -nz.reduce((a,p) => a + p*Math.log(p), 0);
    console.log(`  ${String(sims).padStart(4)} 次模擬 → 前5高: ${top}  | 有效選項數 ${Math.exp(H).toFixed(1)} / ${branching}`);
  }
}
