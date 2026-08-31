// train.js — AlphaZero 完整訓練腳本（多進程平行版）
// 執行方式: node train.js
// 需先: npm install @tensorflow/tfjs-node
//
// 與單進程版的差異：
//   - backend 改用 @tensorflow/tfjs-node（原生 CPU kernel，非純 JS）
//   - 自我對局與評估拆到 numWorkers 個子進程平行執行
//   - 經驗回放池改存一般陣列而非 tf.Tensor（避免 tensor 洩漏）

import * as tf from '@tensorflow/tfjs-node';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { loadModel, saveModel, compileModel } from './model_io.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════
//  訓練超參數
// ═══════════════════════════════════════════════════════
const CONFIG = {
    // 自我對局
    gamesPerIteration:  30,      // 每輪產生局數
    maxStepsPerGame:    150,     // 每局最大步數（防止死局）
    mctsSimulations:    200,     // MCTS 每步模擬次數
                                 // 改成 2 步移動後分支數約 46~96，80 次模擬會讓
                                 // 每個子節點訪問數不到 2，visit-count 政策目標等同雜訊。
    epsilonStart:       0.30,    // 初期探索率
    epsilonEnd:         0.05,    // 末期探索率
    epsilonDecay:       0.97,    // 每輪衰減率
    temperatureThresh:  20,      // 前N步用高溫（更多樣性）

    // 平行
    numWorkers:         Math.max(1, Math.min(12, os.cpus().length - 2)),

    // 訓練
    epochs:             5,
    batchSize:          64,
    learningRate:       0.001,
    l2Reg:             1e-4,
    replayBufferMax:    5000,    // 經驗回放池上限

    // 分數系統
    targetScore:        100,     // 目標勝場數
    evalGames:          20,      // 每輪評估局數（新vs舊）
    evalSimulations:    100,     // 評估時的 MCTS 模擬次數
    promotionThreshold: 0.55,    // 新模型勝率超過此值才晉升

    // 儲存
    modelDir:           './alpha_model',
    workerModelDir:     './_worker_model',  // 給子進程讀的當前模型快照
    tmpDir:             './_worker_tmp',    // 子進程結果暫存
    checkpointInterval: 5,       // 每N輪存一次checkpoint
};

// ═══════════════════════════════════════════════════════
//  建立雙頭 ResNet（Input: [7,7,8]）
// ═══════════════════════════════════════════════════════
function buildResNet() {
    const input = tf.input({ shape: [7, 7, 8] });

    let x = tf.layers.conv2d({
        filters: 64, kernelSize: 3, padding: 'same',
        kernelRegularizer: tf.regularizers.l2({ l2: CONFIG.l2Reg })
    }).apply(input);
    x = tf.layers.batchNormalization().apply(x);
    x = tf.layers.activation({ activation: 'relu' }).apply(x);

    // 殘差塊 × 4
    for (let i = 0; i < 4; i++) {
        let res = tf.layers.conv2d({
            filters: 64, kernelSize: 3, padding: 'same',
            kernelRegularizer: tf.regularizers.l2({ l2: CONFIG.l2Reg })
        }).apply(x);
        res = tf.layers.batchNormalization().apply(res);
        res = tf.layers.activation({ activation: 'relu' }).apply(res);
        res = tf.layers.conv2d({
            filters: 64, kernelSize: 3, padding: 'same',
            kernelRegularizer: tf.regularizers.l2({ l2: CONFIG.l2Reg })
        }).apply(res);
        res = tf.layers.batchNormalization().apply(res);
        x = tf.layers.add().apply([x, res]);
        x = tf.layers.activation({ activation: 'relu' }).apply(x);
    }

    // Policy Head
    let ph = tf.layers.conv2d({ filters: 2, kernelSize: 1, padding: 'same', activation: 'relu' }).apply(x);
    ph = tf.layers.batchNormalization().apply(ph);
    ph = tf.layers.flatten().apply(ph);
    ph = tf.layers.dropout({ rate: 0.3 }).apply(ph);
    const policyHead = tf.layers.dense({
        units: 392, activation: 'softmax', name: 'policy'
    }).apply(ph);

    // Value Head
    let vh = tf.layers.conv2d({ filters: 1, kernelSize: 1, padding: 'same', activation: 'relu' }).apply(x);
    vh = tf.layers.batchNormalization().apply(vh);
    vh = tf.layers.flatten().apply(vh);
    vh = tf.layers.dense({ units: 64, activation: 'relu' }).apply(vh);
    vh = tf.layers.dropout({ rate: 0.3 }).apply(vh);
    const valueHead = tf.layers.dense({
        units: 1, activation: 'tanh', name: 'value'
    }).apply(vh);

    return compileModel(
        tf.model({ inputs: input, outputs: [policyHead, valueHead] }),
        CONFIG.learningRate
    );
}

// ═══════════════════════════════════════════════════════
//  子進程管理
// ═══════════════════════════════════════════════════════
function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 把 total 份工作平均切給 numWorkers 個子進程
function splitWork(total, numWorkers) {
    const chunks = [];
    for (let i = 0; i < numWorkers; i++) {
        const size = Math.floor(total / numWorkers) + (i < total % numWorkers ? 1 : 0);
        if (size > 0) chunks.push(size);
    }
    return chunks;
}

function runWorker(cfg, onProgress) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'worker.js'), JSON.stringify(cfg)], {
            cwd: __dirname,
            env: {
                ...process.env,
                TF_CPP_MIN_LOG_LEVEL:   '3',  // 關掉 TF 啟動訊息
                TF_NUM_INTRAOP_THREADS: '1',  // 每個子進程單執行緒，避免超額訂閱
                TF_NUM_INTEROP_THREADS: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdoutBuf = '', stderrBuf = '';
        child.stdout.on('data', chunk => {
            stdoutBuf += chunk;
            const lines = stdoutBuf.split('\n');
            stdoutBuf = lines.pop();
            for (const line of lines) {
                if (line.startsWith('PROGRESS ')) {
                    try { onProgress(JSON.parse(line.slice(9))); } catch { /* 忽略壞行 */ }
                }
            }
        });
        child.stderr.on('data', chunk => { stderrBuf += chunk; });

        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) return reject(new Error(`worker 結束碼 ${code}\n${stderrBuf}`));
            try {
                resolve(JSON.parse(fs.readFileSync(cfg.outFile, 'utf8')));
            } catch (err) {
                reject(new Error(`讀取 worker 結果失敗: ${err.message}\n${stderrBuf}`));
            } finally {
                fs.rmSync(cfg.outFile, { force: true });
            }
        });
    });
}

// ═══════════════════════════════════════════════════════
//  自我對局（平行）
// ═══════════════════════════════════════════════════════
async function selfPlay(numGames, epsilon) {
    ensureDir(CONFIG.tmpDir);
    const chunks = splitWork(numGames, CONFIG.numWorkers);

    let done = 0, timeouts = 0;
    const wins = { red: 0, blue: 0, Draw: 0 };
    const t0 = Date.now();

    const results = await Promise.all(chunks.map((size, i) =>
        runWorker({
            mode:            'selfplay',
            modelDir:        CONFIG.workerModelDir,
            numGames:        size,
            epsilon,
            mctsSimulations: CONFIG.mctsSimulations,
            maxSteps:        CONFIG.maxStepsPerGame,
            tempThresh:      CONFIG.temperatureThresh,
            outFile:         path.join(CONFIG.tmpDir, `selfplay_${i}.json`)
        }, ev => {
            done++;
            if (ev.timeout) timeouts++;
            wins[ev.winner] = (wins[ev.winner] || 0) + 1;
            const rate = (Date.now() - t0) / 1000 / done;
            process.stdout.write(
                `  ${done}/${numGames} 局  紅${wins.red} 藍${wins.blue} 平${wins.Draw}  超時${timeouts}  ${rate.toFixed(1)}秒/局   \r`
            );
        })
    ));

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n      完成 ${numGames} 局，耗時 ${secs} 秒（${CONFIG.numWorkers} 進程平行）`);
    return results.flat();
}

// ═══════════════════════════════════════════════════════
//  評估（平行）：新模型 vs 舊模型
// ═══════════════════════════════════════════════════════
async function evaluate(newDir, oldDir, numGames) {
    ensureDir(CONFIG.tmpDir);
    const chunks = splitWork(numGames, CONFIG.numWorkers);

    // 先後手全域交替，再依序切給各 worker，保證紅藍分配均衡
    const allGames = Array.from({ length: numGames }, (_, g) => ({
        newColor: g % 2 === 0 ? 'red' : 'blue'
    }));

    let offset = 0, done = 0;
    const t0 = Date.now();
    const specs = chunks.map(size => {
        const slice = allGames.slice(offset, offset + size);
        offset += size;
        return slice;
    });

    const results = await Promise.all(specs.map((games, i) =>
        runWorker({
            mode:            'eval',
            newDir, oldDir, games,
            mctsSimulations: CONFIG.evalSimulations,
            maxSteps:        CONFIG.maxStepsPerGame,
            outFile:         path.join(CONFIG.tmpDir, `eval_${i}.json`)
        }, () => {
            done++;
            process.stdout.write(`  評估 ${done}/${numGames} 局...   \r`);
        })
    ));

    const tally = results.reduce((a, r) => ({
        newWins: a.newWins + r.newWins,
        oldWins: a.oldWins + r.oldWins,
        draws:   a.draws   + r.draws
    }), { newWins: 0, oldWins: 0, draws: 0 });

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n      評估耗時 ${secs} 秒`);
    return { ...tally, winRate: tally.newWins / numGames };
}

// ═══════════════════════════════════════════════════════
//  主訓練迴圈
// ═══════════════════════════════════════════════════════
async function train() {
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   Wall Go AlphaZero 自我訓練系統  v3.0       ║');
    console.log('║   （tfjs-node 原生 backend ＋ 多進程平行）   ║');
    console.log('╚══════════════════════════════════════════════╝\n');
    console.log(`⚙  CPU ${os.cpus().length} 執行緒，使用 ${CONFIG.numWorkers} 個對局進程\n`);

    let model = await loadModel(CONFIG.modelDir, CONFIG.learningRate);
    if (model) {
        console.log('💾 載入已有模型，繼續訓練...\n');
    } else {
        console.log('🧬 建立全新 ResNet 雙頭模型...\n');
        model = buildResNet();
    }

    let epsilon = CONFIG.epsilonStart;
    let iteration = 0;
    let totalScore = { red: 0, blue: 0 };
    const statePath = `${CONFIG.modelDir}/train_state.json`;
    if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        iteration  = state.iteration  || 0;
        epsilon    = state.epsilon    || CONFIG.epsilonStart;
        totalScore = state.totalScore || { red: 0, blue: 0 };
        console.log(`📂 續訓：第 ${iteration} 輪，累積分數 紅${totalScore.red} vs 藍${totalScore.blue}\n`);
    }

    let replayBuffer = [];

    while (Math.max(totalScore.red, totalScore.blue) < CONFIG.targetScore) {
        iteration++;
        console.log(`\n${'─'.repeat(50)}`);
        console.log(`🎮 第 ${iteration} 輪訓練  |  ε=${epsilon.toFixed(3)}  |  分數 紅${totalScore.red} 藍${totalScore.blue}`);
        console.log(`${'─'.repeat(50)}`);

        // 1. 自我對局：先把當前模型存成快照供子進程讀取
        console.log(`\n[1/3] 自我對局（${CONFIG.gamesPerIteration} 局）...`);
        await saveModel(model, CONFIG.workerModelDir);
        const newData = await selfPlay(CONFIG.gamesPerIteration, epsilon);

        replayBuffer.push(...newData);
        if (replayBuffer.length > CONFIG.replayBufferMax) {
            replayBuffer = replayBuffer.slice(-CONFIG.replayBufferMax);
        }
        console.log(`      資料池: ${replayBuffer.length} 筆`);

        // 2. 訓練
        console.log(`\n[2/3] 訓練神經網路...`);
        const n = replayBuffer.length;
        const flatStates = new Float32Array(n * 392);
        replayBuffer.forEach((d, i) => flatStates.set(d.state, i * 392));

        const X       = tf.tensor4d(flatStates, [n, 7, 7, 8]);
        const Ypolicy = tf.tensor2d(replayBuffer.map(d => d.policy));
        const Yvalue  = tf.tensor2d(replayBuffer.map(d => [d.value]));

        await model.fit(X, { policy: Ypolicy, value: Yvalue }, {
            epochs: CONFIG.epochs,
            batchSize: CONFIG.batchSize,
            shuffle: true,
            verbose: 0,
            callbacks: {
                onEpochEnd: (epoch, logs) => {
                    process.stdout.write(
                        `  epoch ${epoch+1}/${CONFIG.epochs}  loss=${logs.loss?.toFixed(4)}  policy=${logs.policy_loss?.toFixed(4)}  value=${logs.value_loss?.toFixed(4)}\n`
                    );
                }
            }
        });

        X.dispose(); Ypolicy.dispose(); Yvalue.dispose();

        // 3. 評估：訓練後的新模型 vs 存檔的最佳模型
        console.log(`\n[3/3] 模型評估（${CONFIG.evalGames} 局）...`);
        await saveModel(model, CONFIG.workerModelDir);
        const bestDir = fs.existsSync(`${CONFIG.modelDir}_best/model.json`)
            ? `${CONFIG.modelDir}_best`
            : CONFIG.workerModelDir;
        const { newWins, oldWins, draws, winRate } =
            await evaluate(CONFIG.workerModelDir, bestDir, CONFIG.evalGames);

        console.log(`      結果: 新${newWins} vs 舊${oldWins} 平${draws}  勝率${(winRate*100).toFixed(1)}%`);

        totalScore.red  += newWins;
        totalScore.blue += oldWins;

        if (winRate >= CONFIG.promotionThreshold) {
            console.log(`\n  ✅ 新模型晉升！(勝率 ${(winRate*100).toFixed(1)}% ≥ ${CONFIG.promotionThreshold*100}%)`);
            await saveModel(model, `${CONFIG.modelDir}_best`);
        } else {
            console.log(`\n  ⏸  保留舊模型 (勝率 ${(winRate*100).toFixed(1)}% < ${CONFIG.promotionThreshold*100}%)`);
        }

        await saveModel(model, CONFIG.modelDir);
        if (iteration % CONFIG.checkpointInterval === 0) {
            await saveModel(model, CONFIG.modelDir, `_ckpt${iteration}`);
            console.log(`  💾 Checkpoint 存檔：${CONFIG.modelDir}_ckpt${iteration}`);
        }

        epsilon = Math.max(CONFIG.epsilonEnd, epsilon * CONFIG.epsilonDecay);
        fs.writeFileSync(statePath, JSON.stringify({ iteration, epsilon, totalScore }, null, 2));

        console.log(`\n  📊 累積分數：紅方 ${totalScore.red} / 藍方 ${totalScore.blue} / 目標 ${CONFIG.targetScore}`);

        if (totalScore.red >= CONFIG.targetScore) {
            console.log(`\n🏆 紅方（新模型）率先達到 ${CONFIG.targetScore} 勝！訓練完成！`);
            break;
        }
        if (totalScore.blue >= CONFIG.targetScore) {
            console.log(`\n🏆 藍方（舊模型）達到 ${CONFIG.targetScore} 勝，繼續強化新模型...`);
            // 不停止，繼續強化
        }
    }

    console.log('\n\n╔══════════════════════════════════════════════╗');
    console.log('║              🎉 訓練結束！                    ║');
    console.log(`║  最終分數：紅方 ${String(totalScore.red).padEnd(5)} vs 藍方 ${totalScore.blue}          ║`);
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`\n模型已儲存至：${CONFIG.modelDir}/`);
    console.log('上傳 alpha_model/ 資料夾至 GitHub 即可在遊戲中使用！');
}

train().catch(err => {
    console.error('\n❌ 訓練崩潰：', err);
    process.exit(1);
});
