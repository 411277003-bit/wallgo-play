#!/usr/bin/env bash
# sync_to_usb.sh — 把訓練產物同步回隨身碟
#
# 訓練在 ext4 的 ~/wallgo-training 進行（FAT32 裝不了 tfjs-node），
# 這支腳本把模型、程式碼、訓練紀錄複製回 USB 上的原始專案資料夾。
# 不同步 node_modules（FAT32 不支援 symlink，本來就裝不起來）。

set -euo pipefail

SRC="$HOME/wallgo-training"
DST="/media/compute-host/3802-EF37/wallgo-training"

if [ ! -d "$DST" ]; then
    echo "❌ 找不到隨身碟目錄：$DST（隨身碟插著嗎？）" >&2
    exit 1
fi

# 驗證模型資料夾：model.json 可解析，且 weights.bin 大小與權重規格總和相符。
# 抓得到「寫到一半」的權重檔。
validate_model() {
    node -e '
        const fs = require("fs");
        const dir = process.argv[1];
        const j = JSON.parse(fs.readFileSync(dir + "/model.json", "utf8"));
        const specs = j.weightsManifest[0].weights;
        const bytes = { float32: 4, int32: 4, bool: 1, complex64: 8 };
        const want = specs.reduce((a, w) =>
            a + w.shape.reduce((x, y) => x * y, 1) * (bytes[w.dtype] ?? 4), 0);
        const got = fs.statSync(dir + "/weights.bin").size;
        if (want !== got) {
            console.error(`  權重大小不符：預期 ${want} bytes，實際 ${got} bytes`);
            process.exit(1);
        }
    ' "$1" 2>&1
}

if pgrep -f "$SRC/train.js" > /dev/null || pgrep -f "node train.js" > /dev/null; then
    if [ "${1:-}" = "--force" ]; then
        echo "⚠️  訓練仍在進行，改以驗證模式同步（會檢查權重檔完整性）。"
        echo
    else
        echo "⚠️  訓練還在跑，現在同步可能複製到寫到一半的權重檔。" >&2
        echo "   確定要同步請加 --force（會先驗證檔案完整性）" >&2
        exit 1
    fi
fi

echo "同步模型..."
skipped=0
for d in "$SRC"/alpha_model "$SRC"/alpha_model_best "$SRC"/alpha_model_ckpt*; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    if ! out=$(validate_model "$d"); then
        echo "  ✗ $name 驗證失敗，跳過（保留隨身碟上的舊版）"
        echo "$out"
        skipped=$((skipped + 1))
        continue
    fi
    rm -rf "${DST:?}/$name"
    cp -r "$d" "$DST/$name"
    echo "  ✓ $name"
done

if [ -d "$SRC/archive" ]; then
    echo "同步封存的舊模型..."
    rm -rf "${DST:?}/archive"
    cp -r "$SRC/archive" "$DST/archive"
    echo "  ✓ archive/"
fi

echo "同步程式碼..."
for f in train.js worker.js model_io.js ai_agent.js wallgo_logic.js \
         verify_fixes.mjs eval_vs_random.mjs diag_visits.mjs \
         FINDINGS.md package.json sync_to_usb.sh; do
    [ -f "$SRC/$f" ] || continue
    cp "$SRC/$f" "$DST/$f"
    echo "  ✓ $f"
done

[ -f "$SRC/train.log" ] && cp "$SRC/train.log" "$DST/train.log" && echo "  ✓ train.log"

sync   # FAT32 掛載有 flush，仍確保寫入落地
echo
if [ "$skipped" -gt 0 ]; then
    echo "⚠️  同步完成，但有 $skipped 個模型驗證失敗被跳過 → $DST"
else
    echo "✅ 同步完成 → $DST"
fi
echo "訓練狀態："
cat "$DST/alpha_model/train_state.json" 2>/dev/null
