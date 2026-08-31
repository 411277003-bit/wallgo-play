// model_io.js — 純 Node.js 的模型讀寫（train.js 與 worker.js 共用）
import * as tf from '@tensorflow/tfjs-node';
import fs from 'fs';

export function compileModel(model, learningRate) {
    model.compile({
        optimizer: tf.train.adam(learningRate),
        loss: { policy: 'categoricalCrossentropy', value: 'meanSquaredError' },
        lossWeights: { policy: 1.0, value: 1.0 }
    });
    return model;
}

export async function loadModel(dir, learningRate = 0.001) {
    const jsonPath   = `${dir}/model.json`;
    const weightPath = `${dir}/weights.bin`;
    if (!fs.existsSync(jsonPath) || !fs.existsSync(weightPath)) return null;

    const handler = {
        load: async () => {
            const modelJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            const weightBuf = fs.readFileSync(weightPath);
            const ab = weightBuf.buffer.slice(
                weightBuf.byteOffset,
                weightBuf.byteOffset + weightBuf.byteLength
            );
            return {
                modelTopology: modelJson.modelTopology,
                weightSpecs:   modelJson.weightsManifest[0].weights,
                weightData:    ab
            };
        }
    };
    return compileModel(await tf.loadLayersModel(handler), learningRate);
}

export async function saveModel(model, dir, suffix = '') {
    const saveDir = suffix ? `${dir}${suffix}` : dir;
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

    const handler = tf.io.withSaveHandler(async (artifacts) => {
        const modelJson = {
            format: 'layers-model',
            generatedBy: `TensorFlow.js v${tf.version.tfjs}`,
            convertedBy: null,
            modelTopology: artifacts.modelTopology,
            weightsManifest: [{ paths: ['weights.bin'], weights: artifacts.weightSpecs }]
        };
        fs.writeFileSync(`${saveDir}/model.json`, JSON.stringify(modelJson, null, 2));
        if (artifacts.weightData) {
            fs.writeFileSync(`${saveDir}/weights.bin`, Buffer.from(artifacts.weightData));
        }
        return {
            modelArtifactsInfo: {
                dateSaved: new Date(),
                modelTopologyType: 'JSON',
                weightDataBytes: artifacts.weightData?.byteLength ?? 0
            }
        };
    });
    await model.save(handler);
    return saveDir;
}
