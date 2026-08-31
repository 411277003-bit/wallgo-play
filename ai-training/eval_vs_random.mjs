// eval_vs_random.mjs — 診斷：模型對上隨機下棋者
// 用法: node eval_vs_random.mjs <模型資料夾> [局數] [MCTS模擬次數]
//
// 這是最基本的健全性檢查。任何有在學習的模型都應該大幅擊敗隨機對手；
// 若勝率接近 50%，代表訓練根本沒讓網路學到有用的東西。
import { WallGoGame } from './wallgo_logic.js';
import { WallGoAI } from './ai_agent.js';
import { loadModel } from './model_io.js';

const modelDir = process.argv[2] || './alpha_model';
const numGames = Number(process.argv[3] || 20);
const sims     = Number(process.argv[4] || 100);
const MAX_STEPS = 150;

const agent = new WallGoAI(await loadModel(modelDir));
const randomAgent = new WallGoAI(null);   // model=null → getBestMove 走隨機

let modelWins = 0, randomWins = 0, draws = 0;

for (let g = 0; g < numGames; g++) {
    const game = new WallGoGame();
    game.pieces = [
        { color: 'red',  r: 0,  c: 2  }, { color: 'red',  r: 0,  c: 10 },
        { color: 'blue', r: 12, c: 2  }, { color: 'blue', r: 12, c: 10 }
    ];
    game.phase = 'movement';

    const modelColor  = g % 2 === 0 ? 'red' : 'blue';
    const randomColor = modelColor === 'red' ? 'blue' : 'red';
    let turn = 'red', step = 0;

    while (game.phase !== 'game_over' && step < MAX_STEPS) {
        game.maybeUseBreaker(turn);
        const action = turn === modelColor
            ? await agent.getBestMove(game, turn, sims, 0.0)
            : randomAgent.getRandomMove(game, turn);
        if (!action) { game.phase = 'game_over'; break; }
        game.applyMove(action.pIdx, action.mr, action.mc, action.wr, action.wc, turn);
        game.checkEndGame();
        turn = turn === 'red' ? 'blue' : 'red';
        step++;
    }

    if      (game.winner === modelColor)  modelWins++;
    else if (game.winner === randomColor) randomWins++;
    else                                  draws++;

    process.stdout.write(`  ${g + 1}/${numGames}  模型${modelWins} 隨機${randomWins} 平${draws}   \r`);
}

const rate = (100 * modelWins / numGames).toFixed(1);
console.log(`\n${modelDir}：模型 ${modelWins} 勝 / 隨機 ${randomWins} 勝 / ${draws} 平  → 勝率 ${rate}%`);
