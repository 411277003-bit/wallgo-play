// train.js
import * as tf from '@tensorflow/tfjs';
import fs from 'fs';
import { WallGoGame } from './wallgo_logic.js';
import { WallGoAI } from './ai_agent.js';

function buildDualHeadResNet() {
    const input = tf.input({ shape: [7, 7, 5] });
    let x = tf.layers.conv2d({ filters: 16, kernelSize: 3, padding: 'same', activation: 'relu' }).apply(input);
    let res = tf.layers.conv2d({ filters: 16, kernelSize: 3, padding: 'same', activation: 'relu' }).apply(x);
    res = tf.layers.conv2d({ filters: 16, kernelSize: 3, padding: 'same' }).apply(res);
    x = tf.layers.add().apply([x, res]);
    x = tf.layers.activation({ activation: 'relu' }).apply(x);

    let policyConv = tf.layers.conv2d({ filters: 2, kernelSize: 1, padding: 'same', activation: 'relu' }).apply(x);
    policyConv = tf.layers.flatten().apply(policyConv);
    const policyHead = tf.layers.dense({ units: 392, activation: 'softmax', name: 'policy' }).apply(policyConv);

    let valueConv = tf.layers.conv2d({ filters: 1, kernelSize: 1, padding: 'same', activation: 'relu' }).apply(x);
    valueConv = tf.layers.flatten().apply(valueConv);
    let valueDense = tf.layers.dense({ units: 32, activation: 'relu' }).apply(valueConv);
    const valueHead = tf.layers.dense({ units: 1, activation: 'tanh', name: 'value' }).apply(valueDense);

    const model = tf.model({ inputs: input, outputs: [policyHead, valueHead] });
    model.compile({
        optimizer: tf.train.adam(0.002),
        loss: { policy: 'categoricalCrossentropy', value: 'meanSquaredError' }
    });
    return model;
}

async function startSelfPlayTraining() {
    let model;
    
    if (fs.existsSync('./alpha_model/model.json') && fs.existsSync('./alpha_model/weights.bin')) {
        console.log("💾 偵測到本地已有練過的大腦，正在喚醒舊記憶繼續進化...");
        const pureJsLoadHandler = {
            load: async () => {
                const modelJson = JSON.parse(fs.readFileSync('./alpha_model/model.json', 'utf8'));
                const weightBuffer = fs.readFileSync('./alpha_model/weights.bin');
                const ab = weightBuffer.buffer.slice(weightBuffer.byteOffset, weightBuffer.byteOffset + weightBuffer.byteLength);
                return {
                    modelTopology: modelJson.modelTopology,
                    weightSpecs: modelJson.weightsManifest[0].weights,
                    weightData: ab
                };
            }
        };
        model = await tf.loadLayersModel(pureJsLoadHandler);
        model.compile({
            optimizer: tf.train.adam(0.002),
            loss: { policy: 'categoricalCrossentropy', value: 'meanSquaredError' }
        });
    } else {
        console.log("🧬 未偵測到舊模型，初始化全新【CPU輕量優化版】雙頭類神經網絡...");
        model = buildDualHeadResNet();
    }

    let agent = new WallGoAI(model);
    const memoryStates = [];
    const memoryPolicies = [];
    const memoryValues = [];

    const numGames = 30; 
    console.log(`🤖 啟動新一輪 AlphaZero 自我對弈數據生成計畫...`);

    for (let g = 0; g < numGames; g++) {
        let game = new WallGoGame();
        game.pieces.push({ color: 'red', r: 0, c: 2 }, { color: 'red', r: 0, c: 10 });
        game.pieces.push({ color: 'blue', r: 12, c: 2 }, { color: 'blue', r: 12, c: 10 });
        game.phase = 'movement';
        
        let turn = 'red';
        let stepCount = 0;
        const gameHistory = []; 

        while (game.phase !== 'game_over' && stepCount < 120) {
            const stateTensor = agent.encodeState(game, turn);
            
            // 🌟 關鍵修正：傳入 0.25 (25% 隨機探索率)，打破 30 局一模一樣的死結局勢
            const action = await agent.getBestMove(game, turn, 40, 0.25);
            if (!action) { game.phase = 'game_over'; break; }

            const actIdx = agent.encodeAction(action.pIdx % 2, action.mr, action.mc, action.wr, action.wc);
            const targetPolicy = new Array(392).fill(0);
            targetPolicy[actIdx] = 1; 

            gameHistory.push({ stateTensor: stateTensor, targetPolicy: targetPolicy, player: turn });
            game.applyMove(action.pIdx, action.mr, action.mc, action.wr, action.wc, turn);
            game.checkEndGame();

            turn = turn === 'red' ? 'blue' : 'red';
            stepCount++;
        }

        const winner = game.winner || 'Draw';
        console.log(` 🎮 對弈第 ${g+1}/${numGames} 局結束，總步數: ${stepCount}, 勝者: ${winner}`);

        gameHistory.forEach(hist => {
            let targetValue = 0;
            if (winner !== 'Draw') {
                targetValue = (hist.player === winner) ? 1.0 : -1.0;
            }
            memoryStates.push(hist.stateTensor);
            memoryPolicies.push(hist.targetPolicy);
            memoryValues.push([targetValue]);
        });
    }

    console.log(`\n🧠 數據收集完畢，開始深度反向傳播訓練...`);
    const X = tf.concat(memoryStates, 0);
    const Y_policy = tf.tensor2d(memoryPolicies);
    const Y_value = tf.tensor2d(memoryValues);

    await model.fit(X, { policy: Y_policy, value: Y_value }, {
        epochs: 2,
        batchSize: 64,
        shuffle: true
    });

    console.log("🎉 類神經網絡模型優化成功！正在將大腦導出至本機目錄...");
    
    const pureJsSaveHandler = tf.io.withSaveHandler(async (artifacts) => {
        const modelJson = {
            format: 'layers-model',
            generatedBy: 'TensorFlow.js v' + tf.version.tfjs,
            convertedBy: null,
            modelTopology: artifacts.modelTopology,
            weightsManifest: [{ paths: ['weights.bin'], weights: artifacts.weightSpecs }]
        };
        if (!fs.existsSync('./alpha_model')) fs.mkdirSync('./alpha_model');
        fs.writeFileSync('./alpha_model/model.json', JSON.stringify(modelJson, null, 2));
        if (artifacts.weightData) fs.writeFileSync('./alpha_model/weights.bin', Buffer.from(artifacts.weightData));
        return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON', weightDataBytes: artifacts.weightData ? artifacts.weightData.byteLength : 0 } };
    });

    await model.save(pureJsSaveHandler);
    console.log("🚀 最新版 ResNet 大腦已成功導出至 alpha_model 資料夾，隨時可以上傳 GitHub！");
    
    X.dispose(); Y_policy.dispose(); Y_value.dispose();
}

startSelfPlayTraining().catch(err => console.error("❌ 訓練過程發生崩潰:", err));
