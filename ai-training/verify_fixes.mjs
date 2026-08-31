// verify_fixes.mjs — 驗證四項修正是否生效
import { WallGoGame } from './wallgo_logic.js';
import { WallGoAI } from './ai_agent.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`);
    ok ? pass++ : fail++;
};

function freshGame() {
    const g = new WallGoGame();
    g.pieces = [
        { color: 'red',  r: 0,  c: 2  }, { color: 'red',  r: 0,  c: 10 },
        { color: 'blue', r: 12, c: 2  }, { color: 'blue', r: 12, c: 10 }
    ];
    g.phase = 'movement';
    return g;
}

// ── ④ 移動最多 2 步 ────────────────────────────────
{
    const g = freshGame();
    const moves = g.getValidMoves(6, 6);          // 空曠處的棋格
    const dists = moves.map(m => (Math.abs(m.r - 6) + Math.abs(m.c - 6)) / 2);
    const maxDist = Math.max(...dists);
    check('④ 移動可達 2 步', maxDist === 2, `最遠 ${maxDist} 步，共 ${moves.length} 個目標`);
    check('④ 不會超過 2 步', dists.every(d => d <= 2));

    // 牆會擋住路徑
    const g2 = freshGame();
    g2.walls.set('6,7', 'red');                    // 擋住 (6,6)→(6,8)
    const blocked = g2.getValidMoves(6, 6).some(m => m.r === 6 && m.c === 8);
    check('④ 牆能擋住移動', !blocked);

    // 不能穿過別人的棋子
    const g3 = freshGame();
    g3.pieces.push({ color: 'blue', r: 6, c: 8 });
    const through = g3.getValidMoves(6, 6).some(m => m.r === 6 && m.c === 10);
    check('④ 不能穿過棋子', !through);
}

// ── ② turnIndex 是單調計數而非奇偶 ─────────────────
{
    const g = freshGame();
    const seen = [];
    for (let i = 0; i < 5; i++) {
        g.applyMove(0, 0, 2, 1, 2, 'red');
        seen.push(g.turnIndex);
    }
    check('② turnIndex 單調遞增', JSON.stringify(seen) === '[1,2,3,4,5]', seen.join(','));

    const g2 = freshGame();
    for (let i = 0; i < 30; i++) g2.applyMove(0, 0, 2, 1, 2, 'red');
    const turnNorm = Math.min(g2.turnIndex / 60, 1);
    check('② 回合進度特徵有變化', turnNorm === 0.5, `30 手後 turnNorm=${turnNorm}`);

    // getCurrentPlayer 仍正確交替
    const g3 = freshGame();
    const players = [];
    for (let i = 0; i < 4; i++) { players.push(g3.getCurrentPlayer()); g3.applyMove(0, 0, 2, 1, 2, 'red'); }
    check('② getCurrentPlayer 仍交替', JSON.stringify(players) === '["red","blue","red","blue"]', players.join(','));
}

// ── ③ 破牆者會在行動力低時觸發 ─────────────────────
{
    // 把紅方一顆棋子關進死角
    const g = freshGame();
    g.pieces = [{ color: 'red', r: 0, c: 0 }, { color: 'blue', r: 12, c: 12 }];
    g.walls.set('1,0', 'red');   // 南
    g.walls.set('0,1', 'red');   // 東
    const mobBefore = g.getMobility('red');
    const key = g.maybeUseBreaker('red');
    check('③ 低行動力時觸發破牆', key !== null, `行動力 ${mobBefore} → 拆掉 ${key}`);
    check('③ 破牆後 hasBreaker 變 false', g.playersInfo.red.hasBreaker === false);
    check('③ 破牆後行動力上升', g.getMobility('red') > mobBefore, `→ ${g.getMobility('red')}`);

    // 行動力充足時不該浪費
    const g2 = freshGame();
    const used = g2.maybeUseBreaker('red');
    check('③ 行動力足夠時不使用', used === null && g2.playersInfo.red.hasBreaker === true);

    // 只能拆自己的牆
    const g3 = freshGame();
    g3.pieces = [{ color: 'red', r: 0, c: 0 }, { color: 'blue', r: 12, c: 12 }];
    g3.walls.set('1,0', 'blue');
    g3.walls.set('0,1', 'blue');
    check('③ 不能拆對手的牆', g3.maybeUseBreaker('red') === null);
}

// ── ① MCTS 樹中雙方交替出手 ────────────────────────
{
    const agent = new WallGoAI(null);   // 不需模型，只驗證樹的結構
    // 直接用內部方法建兩層樹
    const g = freshGame();
    const AgentCls = agent.constructor;

    // 借用 _expand：需要 model，改用手動模擬 _expand 的換手邏輯
    // 這裡驗證的是 MCTSNode 的 toMove 是否逐層翻轉、ucb 是否對子節點取負號
    const mod = await import('./ai_agent.js');
    // MCTSNode 未匯出，改以行為驗證：檢查 _expand 產生的子節點狀態
    // 用一個假模型讓 predict 回傳均勻分佈
    const fakeModel = {
        predict: () => [
            { dataSync: () => new Float32Array(392).fill(1 / 392) },
            { dataSync: () => new Float32Array([0]) }
        ]
    };
    const a2 = new WallGoAI(fakeModel);
    const root = { game: g.clone(), toMove: 'red', parent: null, children: [], expanded: false };
    await a2._expand(root);

    check('① 根節點展開出子節點', root.children.length > 0, `${root.children.length} 個`);
    const allOpp = root.children.every(c => c.toMove === 'blue');
    check('① 子節點換手成 blue', allOpp);

    // 展開一個子節點，檢查孫節點動的是藍棋
    const child = root.children[0];
    await a2._expand(child);
    const grand = child.children[0];
    check('① 孫節點換回 red', grand.toMove === 'red');

    const bluePiecesRoot  = g.pieces.filter(p => p.color === 'blue').map(p => `${p.r},${p.c}`).join('|');
    const bluePiecesGrand = grand.game.pieces.filter(p => p.color === 'blue').map(p => `${p.r},${p.c}`).join('|');
    check('① 對手在樹中真的會動', bluePiecesRoot !== bluePiecesGrand,
          `根 ${bluePiecesRoot} vs 深度2 ${bluePiecesGrand}`);

    const wallOwners = [...grand.game.walls.values()];
    check('① 深度2 兩色都蓋過牆', new Set(wallOwners).size === 2, wallOwners.join(','));
}

console.log(`\n通過 ${pass} 項，失敗 ${fail} 項`);
process.exit(fail === 0 ? 0 : 1);
