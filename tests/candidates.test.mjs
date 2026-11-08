import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSubstrate, DEFAULT_BLANK_LAB, ksToLab, fitColorant, mixToLab } from '../src/color/km.js';
import { findCandidates, correctBatch, correctionToWeights } from '../src/color/candidates.js';
import { deltaE00 } from '../src/color/colorUtils.js';

const sub = makeSubstrate(DEFAULT_BLANK_LAB);

function mk(kPerUnit, concs = [0.25, 0.5, 1, 2]) {
    return fitColorant(concs.map((c) => ({
        c, whiteC: 0,
        lab: ksToLab([0, 1, 2].map((j) => (sub.K[j] + kPerUnit[j] * c) / sub.S[j])),
    })), sub);
}

const RED = mk([0.6, 7.0, 6.0]);
const YEL = mk([0.3, 1.2, 9.0]);
const BLU = mk([7.5, 4.0, 0.4]);
const BLK = mk([20, 20, 20]);

const cols = [
    { id: 'r', name: 'Red', model: RED, minC: 0, maxC: 4, colorant: { pigmentLoading: 25 } },
    { id: 'y', name: 'Yellow', model: YEL, minC: 0, maxC: 4, colorant: { pigmentLoading: 30 } },
    { id: 'b', name: 'Blue', model: BLU, minC: 0, maxC: 4, colorant: { pigmentLoading: 20 } },
    { id: 'k', name: 'Black', model: BLK, minC: 0, maxC: 2, colorant: { pigmentLoading: 40 } },
];

test('候選清單依 ΔE 排序且不重複', () => {
    const target = mixToLab([{ model: RED, c: 0.6 }, { model: YEL, c: 0.3 }], sub).lab;
    const list = findCandidates({ target, colorants: cols, substrate: sub, limit: 6 });

    assert.ok(list.length >= 2, `只找到 ${list.length} 組`);
    for (let i = 1; i < list.length; i++) {
        if (list[i - 1].feasible === list[i].feasible) {
            assert.ok(list[i - 1].dE00 <= list[i].dE00 + 1e-9, '應依 ΔE 遞增');
        }
    }
    const keys = list.map((c) => [...c.ids].sort().join('|'));
    assert.equal(new Set(keys).size, keys.length, '不該有重複的色料組合');
});

test('最佳候選能還原出原配方的兩支色料', () => {
    const target = mixToLab([{ model: RED, c: 0.6 }, { model: YEL, c: 0.3 }], sub).lab;
    const list = findCandidates({ target, colorants: cols, substrate: sub });
    const best = list[0];
    assert.ok(best.dE00 < 0.3, `ΔE00=${best.dE00}`);
    assert.deepEqual([...best.ids].sort(), ['r', 'y']);
});

test('maxComponents 限制成分數', () => {
    const target = { l: 42, a: 12, b: 28 };
    const list = findCandidates({ target, colorants: cols, substrate: sub, maxComponents: 2 });
    for (const c of list) assert.ok(c.usedCount <= 2, `用了 ${c.usedCount} 支`);
});

test('required 的色料一定出現在每組候選裡', () => {
    const target = { l: 60, a: 15, b: 10 };
    const list = findCandidates({ target, colorants: cols, substrate: sub, required: ['k'] });
    assert.ok(list.length > 0);
    for (const c of list) assert.ok(c.ids.includes('k'), `缺少必選色料：${c.ids}`);
});

test('可行的候選排在不可行的前面', () => {
    const tight = cols.map((c) => ({ ...c, minC: 0.5 }));
    const target = { l: 70, a: 8, b: 4 };
    const list = findCandidates({ target, colorants: tight, substrate: sub });
    let seenInfeasible = false;
    for (const c of list) {
        if (!c.feasible) seenInfeasible = true;
        else assert.ok(!seenInfeasible, '可行的候選不該排在不可行之後');
    }
});

/* ---------------- 修色 ---------------- */

test('修色能把帶偏差的試片拉回目標色', () => {
    const current = [0.5, 0.25, 0, 0];
    const target = mixToLab([{ model: RED, c: 0.62 }, { model: YEL, c: 0.3 }], sub).lab;

    // 模擬這爐料紅色力偏弱，實測比模型預測淡
    const measured = mixToLab([
        { model: RED, c: 0.5, strength: 0.85 },
        { model: YEL, c: 0.25, strength: 1.0 },
    ], sub).lab;

    const r = correctBatch({ colorants: cols, current, measured, target, substrate: sub });
    assert.ok(r, '應回傳修色結果');
    assert.ok(r.dE00 < r.before.dE00, `修色後 ${r.dE00.toFixed(2)} 應優於修色前 ${r.before.dE00.toFixed(2)}`);
    assert.ok(r.dE00 < 0.6, `ΔE00=${r.dE00}`);
    assert.ok(Math.abs(r.bias.l) > 0.1, '偏差應被偵測到');
});

test('只加不減模式下不會出現負的修正量', () => {
    const current = [0.9, 0.4, 0, 0];
    // 試片偏濃，理論上該減料，但只加不減時只能靠其他色料補
    const measured = mixToLab([{ model: RED, c: 1.1 }, { model: YEL, c: 0.5 }], sub).lab;
    const target = mixToLab([{ model: RED, c: 0.6 }, { model: YEL, c: 0.3 }], sub).lab;

    const r = correctBatch({ colorants: cols, current, measured, target, substrate: sub, addOnly: true });
    for (const [i, d] of r.delta.entries()) {
        assert.ok(d >= -1e-9, `${cols[i].name} 的修正量為負：${d}`);
    }
    assert.equal(r.addOnly, true);
});

test('修色量可換算成現場要加的公斤數', () => {
    const current = [0.5, 0.25, 0, 0];
    const measured = mixToLab([{ model: RED, c: 0.44 }, { model: YEL, c: 0.25 }], sub).lab;
    const target = mixToLab([{ model: RED, c: 0.6 }, { model: YEL, c: 0.3 }], sub).lab;

    const r = correctBatch({ colorants: cols, current, measured, target, substrate: sub });
    const w = correctionToWeights(r, cols, 500);

    assert.equal(w.length, cols.length);
    const red = w[0];
    // 紅色母含量 25%，所以色母添加量的變化是有效濃度變化的 4 倍
    assert.ok(Math.abs(red.deltaDosage - red.deltaC * 4) < 1e-9);
    assert.ok(Math.abs(red.kg - (red.deltaDosage / 100) * 500) < 1e-9);
});

test('試片已經對準時修色量接近零', () => {
    const current = [0.6, 0.3, 0, 0];
    const lab = mixToLab([{ model: RED, c: 0.6 }, { model: YEL, c: 0.3 }], sub).lab;
    const r = correctBatch({ colorants: cols, current, measured: lab, target: lab, substrate: sub });
    assert.ok(r.dE00 < 0.2, `ΔE00=${r.dE00}`);
    for (const d of r.delta) assert.ok(Math.abs(d) < 0.05, `修正量過大：${d}`);
});
