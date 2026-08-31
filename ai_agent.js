// ai_agent.js
import * as tf from '@tensorflow/tfjs';

export class WallGoAI {
    constructor(model = null) {
        this.model = model;
        this.numActions = 392; // 2隻棋子 * 49個格子 * 4個牆壁方向 = 392 總行動空間
    }

    encodeState(game, aiColor) {
        return tf.tidy(() => {
            const buffer = tf.buffer([7, 7, 5]);
            game.pieces.forEach((p) => {
                const gridR = Math.floor(p.r / 2);
                const gridC = Math.floor(p.c / 2);
                if (gridR >= 0 && gridR < 7 && gridC >= 0 && gridC < 7) {
                    if (p.color === aiColor) {
                        buffer.set(1, gridR, gridC, 0);
                    } else {
                        buffer.set(1, gridR, gridC, 1);
                    }
                }
            });

            for (let r = 0; r < 7; r++) {
                for (let c = 0; c < 7; c++) {
                    const realR = r * 2;
                    const realC = c * 2;
                    if (game.walls.has(`${realR - 1},${realC}`)) buffer.set(1, r, c, 2);
                    if (game.walls.has(`${realR},${realC - 1}`)) buffer.set(1, r, c, 3);
                }
            }

            for (let r = 0; r < 7; r++) {
                for (let c = 0; c < 7; c++) {
                    buffer.set(1, r, c, 4);
                }
            }
            return buffer.toTensor().expandDims(0);
        });
    }

    encodeAction(pIdx, mr, mc, wr, wc) {
        const targetSquare = Math.floor(mr / 2) * 7 + Math.floor(mc / 2);
        let wallDir = 0;
        if (wr === mr - 1) wallDir = 0;
        if (wr === mr + 1) wallDir = 1;
        if (wc === mc - 1) wallDir = 2;
        if (wc === mc + 1) wallDir = 3;
        return (pIdx * 49 * 4) + (targetSquare * 4) + wallDir;
    }

    getActionMask(game, aiColor) {
        const mask = new Array(this.numActions).fill(0);
        const myPieces = game.pieces.map((p, pArrIdx) => ({ ...p, pArrIdx })).filter(p => p.color === aiColor);

        myPieces.forEach((p, relativeIdx) => { 
            const moves = game.getValidMoves(p.r, p.c);
            moves.forEach(m => {
                const vWalls = game.getValidWalls(m.r, m.c);
                vWalls.forEach(w => {
                    const actIdx = this.encodeAction(relativeIdx, m.r, m.c, w.r, w.c);
                    if (actIdx >= 0 && actIdx < this.numActions) {
                        mask[actIdx] = 1; 
                    }
                });
            });
        });
        return mask;
    }

    // 🌟 核心改動：加入 epsilon 參數，預設為 0.0 (網頁對決使出全力)
    async getBestMove(game, aiColor, simulations = 40, epsilon = 0.0) {
        if (!this.model) {
            return this.getRandomMove(game, aiColor);
        }

        // 🌟 隨機探索：一定機率完全隨機走子，強制打破死結、擴展新棋譜
        if (Math.random() < epsilon) {
            return this.getRandomMove(game, aiColor);
        }

        const mask = this.getActionMask(game, aiColor);
        
        return tf.tidy(() => {
            const inputTensor = this.encodeState(game, aiColor);
            const [policyOutput, valueOutput] = this.model.predict(inputTensor);
            const policyValues = policyOutput.dataSync();
            
            let maxScore = -Infinity;
            let bestIdx = -1;
            
            for (let i = 0; i < this.numActions; i++) {
                if (mask[i] === 1) {
                    const score = policyValues[i] + (Math.random() * 0.01); 
                    if (score > maxScore) {
                        maxScore = score;
                        bestIdx = i;
                    }
                }
            }

            if (bestIdx === -1) return this.getRandomMove(game, aiColor);
            return this.decodeAction(bestIdx, game, aiColor);
        });
    }

    decodeAction(idx, game, aiColor) {
        const myPieces = game.pieces.map((p, pArrIdx) => ({ ...p, pArrIdx })).filter(p => p.color === aiColor);
        const pIdx = Math.floor(idx / 196); 
        const remainder = idx % 196;
        const targetSquare = Math.floor(remainder / 4);
        const wallDir = remainder % 4;

        const mr = Math.floor(targetSquare / 7) * 2;
        const mc = (targetSquare % 7) * 2;

        let wr = mr, wc = mc;
        if (wallDir === 0) wr = mr - 1;
        if (wallDir === 1) wr = mr + 1;
        if (wallDir === 2) wc = mc - 1;
        if (wallDir === 3) wc = mc + 1;

        const targetPiece = myPieces[pIdx] || myPieces[0];
        return { pIdx: targetPiece.pArrIdx, mr, mc, wr, wc };
    }

    getRandomMove(game, aiColor) {
        const myPieces = game.pieces.map((p, idx) => ({ ...p, idx })).filter(p => p.color === aiColor);
        const validActions = [];

        myPieces.forEach(p => {
            const moves = game.getValidMoves(p.r, p.c);
            moves.forEach(m => {
                const vWalls = game.getValidWalls(m.r, m.c);
                vWalls.forEach(w => {
                    validActions.push({ pIdx: p.idx, mr: m.r, mc: m.c, wr: w.r, wc: w.c });
                });
            });
        });

        if (validActions.length === 0) return null;
        return validActions[Math.floor(Math.random() * validActions.length)];
    }
}
