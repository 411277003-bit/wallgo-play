# assets

## bgm.mp3

大廳背景音樂，由 `index.html` 右下角工具列的 🔈 按鈕開關（設定記在 localStorage）。

目前使用的曲目：

> **Carefree** — Kevin MacLeod ([incompetech.com](https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100199))
> 授權：[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)

CC BY 4.0 要求標示出處，署名已放在 `index.html` 的「系統資訊」視窗中。
換掉這首歌時請一併更新那裡的署名，或改用不需署名的授權（CC0／public domain）。

檔案約 6.3 MB，因此 `<audio>` 設為 `preload="none"` —— 沒開音樂的使用者不會被迫下載。
瀏覽器政策禁止自動播放，音樂會在使用者第一次點擊或按鍵時才開始。

想換成自己的音樂，直接覆蓋 `bgm.mp3` 即可，不用改程式。
檔案不存在或載入失敗時頁面不會壞掉，只是沒有聲音（錯誤會記在 console）。

---

## sfx/

**只服務登入前的開場動畫**（`playSfx()` 在 `introStage === null` 時直接略過），
開場播完進到大廳後就回到只有背景音樂的狀態。跟背景音樂共用同一顆 🔈 開關。

開場動畫原本在頁面載入時就自動播，但瀏覽器禁止未經互動的音訊播放，
所以那段動畫永遠是靜音的。現在改成：載入後先擺出開場的起始盤面並停住，
顯示「點擊任何一處開始」（`#intro-gate`），使用者點下去才開演 ——
那一下同時解鎖音訊，敲擊聲才出得來。`armIntroGate()` 負責這件事，
`step()` 在 `phase === 'introGate'` 時直接 return 把畫面凍住。

| 檔案 | 觸發時機 | 原始檔 |
|---|---|---|
| `piece-move.ogg` | 棋子開始移動（`startMove()`），音量 0.26 | `chip-lay-1` — Casino Audio |
| `wall-build.ogg` | 牆蓋起來（`walls.set()`），四面牆收網時依序錯開 90ms，音量 0.46 | `impactWood_medium_000` — Impact Sounds |
| `wall-break.ogg` | 破牆（`smashWall()`），音量 1.00 × **5 層疊播** —— 全場最重的一下 | `impactMining_000` — Impact Sounds |

`HTMLAudioElement.volume` 的上限是 `1`，破牆聲已經頂到天花板，再調數字不會有差別。
要讓它明顯比其他音重，靠的是 `SFX.break.stagger`：陣列長度就是疊幾層，
每個值是該層延遲幾毫秒起播。目前 `[0,0,14,30,48]` —— 前兩層同時下去給衝擊力，
其餘錯開撐出厚度，比五份完全同時播更像一記重擊而不是破音。
另外把背景音樂壓到 `0.16`、其他音效一併壓低，讓那一下切得出來。

**不要改回 Web Audio 的 `GainNode`。** 曾經試過用 `createMediaElementSource()` 加
`GainNode`（可以大於 1）加限幅器，但那個 API 一旦接上，聲音就**只**走該路徑：
`AudioContext` 停在 `suspended`、或以 `file://` 開啟導致媒體來源被 taint 時，
結果是完全沒聲音，而且不會拋例外所以 `try/catch` 也接不到。疊播雖然土，
但在所有瀏覽器與 `file://` 下都會動。

全部出自 [Kenney](https://kenney.nl) 的音效包，授權
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)（公共領域，
署名非必要但已在「系統資訊」視窗中標示）。

格式是 Ogg Vorbis —— Kenney 只提供這個格式。Chrome、Firefox、Edge 都原生支援；
Safari 要 17.4 以上。若要支援更舊的 Safari，需另外轉檔成 m4a 並用
`<source>` 提供備援。
