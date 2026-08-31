// worker.js — 平行自我對局／評估的子進程
// 由 train.js 以 child_process.spawn 啟動，設定用 argv[2] 傳入 JSON，
// 結果寫到 cfg.outFile，每完成一局往 stdout 印一行 PROGRESS 供母進程統計。
import fs from 'fs';
import { WallGoGame } from './wallgo_logic.js';
import { WallGoAI } from './ai_agent.js';
import { loadModel } from './model_io.js';

const cfg = JSON.parse(process.argv[2]);

// 每局固定開局（與原 train.js 一致）
const START_POSITIONS = [
    { color: 'red',  r: 0,  c: 2  },
    { color: 'red',  r: 0,  c: 10 },
    { color: 'blue', r: 12, c: 2  },
    { color: 'blue', r: 12, c: 10 }
];

function newGame() {
    const game = new WallGoGame();
    game.pieces = START_POSITIONS.map(p => ({ ...p }));
    game.phase  = 'movement';
    return game;
}

function progress(payload) {
    process.stdout.write(`PROGRESS ${JSON.stringify(payload)}\n`);
}

// ═══════════════════════════════════════════════════════
//  自我對局
// ═══════════════════════════════════════════════════════
async function runSelfPlay() {
    const model = await loadModel(cfg.modelDir);
    const agent = new WallGoAI(model);
    const data  = [];

    for (let g = 0; g < cfg.numGames; g++) {
        const game = newGame();
        let turn = 'red';
        let step = 0;
        const history = [];

        while (game.phase !== 'game_over' && step < cfg.maxSteps) {
            // 行動力太低時先動用破牆者（時機同 game(new).html 的內建 AI）
            game.maybeUseBreaker(turn);

            const temperature = step < cfg.tempThresh ? 1.0 : 0.1;
            const policy = await agent.getMCTSPolicy(
                game, turn, cfg.mctsSimulations, temperature
            );

            // 狀態存成一般陣列（tensor 無法跨進程傳遞）
            const stateTensor = agent.encodeState(game, turn);
            const state = Array.from(stateTensor.dataSync());
            stateTensor.dispose();
            history.push({ state, policy, player: turn });

            let action;
            if (Math.random() < cfg.epsilon) {
                action = agent.getRandomMove(game, turn);
            } else {
                const validIndices = policy.reduce((a, v, i) => { if (v > 0) a.push(i); return a; }, []);
                if (validIndices.length === 0) { game.phase = 'game_over'; break; }
                const rand = Math.random();
                let cumsum = 0;
                let chosenIdx = validIndices[0];
                for (const idx of validIndices) {
                    cumsum += policy[idx];
                    if (rand < cumsum) { chosenIdx = idx; break; }
                }
                action = agent.decodeAction(chosenIdx, game, turn);
            }

            if (!action) { game.phase = 'game_over'; break; }
            game.applyMove(action.pIdx, action.mr, action.mc, action.wr, action.wc, turn);
            game.checkEndGame();
            turn = turn === 'red' ? 'blue' : 'red';
            step++;
        }

        const winner = game.winner || 'Draw';
        history.forEach(h => {
            const value = winner === 'Draw' ? 0 : (h.player === winner ? 1.0 : -1.0);
            data.push({ state: h.state, policy: h.policy, value });
        });

        progress({ kind: 'game', step, winner, timeout: step >= cfg.maxSteps });
    }

    fs.writeFileSync(cfg.outFile, JSON.stringify(data));
}

// ═══════════════════════════════════════════════════════
//  評估：新模型 vs 舊模型
// ═══════════════════════════════════════════════════════
async function runEval() {
    const newAgent = new WallGoAI(await loadModel(cfg.newDir));
    const oldAgent = new WallGoAI(await loadModel(cfg.oldDir));
    let newWins = 0, oldWins = 0, draws = 0;

    // cfg.games: [{ newColor }]，先後手由母進程分配以保持均衡
    for (const spec of cfg.games) {
        const game = newGame();
        const newColor = spec.newColor;
        const oldColor = newColor === 'red' ? 'blue' : 'red';
        let turn = 'red';
        let step = 0;

        while (game.phase !== 'game_over' && step < cfg.maxSteps) {
            game.maybeUseBreaker(turn);

            const agent  = turn === newColor ? newAgent : oldAgent;
            const action = await agent.getBestMove(game, turn, cfg.mctsSimulations, 0.0);
            if (!action) { game.phase = 'game_over'; break; }
            game.applyMove(action.pIdx, action.mr, action.mc, action.wr, action.wc, turn);
            game.checkEndGame();
            turn = turn === 'red' ? 'blue' : 'red';
            step++;
        }

        if      (game.winner === newColor) newWins++;
        else if (game.winner === oldColor) oldWins++;
        else                               draws++;

        progress({ kind: 'game', step, winner: game.winner || 'Draw' });
    }

    fs.writeFileSync(cfg.outFile, JSON.stringify({ newWins, oldWins, draws }));
}

const main = cfg.mode === 'eval' ? runEval : runSelfPlay;
main().catch(err => {
    process.stderr.write(`worker ${cfg.mode} 失敗: ${err?.stack || err}\n`);
    process.exit(1);
});
