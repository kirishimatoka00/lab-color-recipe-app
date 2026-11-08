import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, predictFormulation, buildSolverColorants } from '../src/color/engine.js';
import {
    makeResin, makeColorant, makeFormulation, makeCurvePoint,
    COLORANT_ROLE, COLORANT_TYPE, RECIPE_MODE,
    effectiveConcentrations, backoutMasterbatch, checkLimits,
} from '../src/data/schema.js';
import { makeSubstrate, ksToLab, DEFAULT_BLANK_LAB } from '../src/color/km.js';
import { solveRecipe } from '../src/color/solver.js';
import { deltaE00 } from '../src/color/colorUtils.js';

const sub = makeSubstrate({ l: 92, a: -0.6, b: 2.4 });

/** 造一支色母：顏料含量 20%，曲線以「色母添加量」記錄 */
function buildColorant(name, kPerUnit, dosages, opts = {}) {
    const loading = opts.pigmentLoading ?? 20;
    const curve = dosages.map((d) => {
        const c = (d * loading) / 100; // 顏料有效濃度
        const lab = ksToLab([0, 1, 2].map((j) => (sub.K[j] + kPerUnit[j] * c) / sub.S[j]));
        return makeCurvePoint({ dosage: d, whiteDosage: 0, lab });
    });
    return makeColorant({
        id: opts.id, name, type: COLORANT_TYPE.SPD, pigmentLoading: loading,
        carrierId: 'carrier1', curve, minFinalPct: opts.minFinalPct ?? 0,
        maxFinalPct: opts.maxFinalPct ?? null, role: opts.role || COLORANT_ROLE.CHROMATIC,
    });
}

function buildDb() {
    const base = makeResin({ id: 'base1', name: 'PP H1500', blankLab: { l: 92, a: -0.6, b: 2.4 } });
    const carrier = makeResin({ id: 'carrier1', name: 'PE carrier', usage: 'carrier' });
    const red = buildColorant('Red SPD', [0.6, 7.0, 6.0], [1, 2, 4, 8], { id: 'red' });
    const yel = buildColorant('Yellow SPD', [0.3, 1.2, 9.0], [1, 2, 4, 8], { id: 'yel' });
    const blu = buildColorant('Blue SPD', [7.5, 4.0, 0.4], [1, 2, 4, 8], { id: 'blu', minFinalPct: 0.1 });
    return {
        resins: [base, carrier], colorants: [red, yel, blu], formulations: [],
    };
}

test('compile 能建出基材與所有色料模型', () => {
    const db = buildDb();
    const c = compile(db, { baseResinId: 'base1', carrierId: 'carrier1', condition: '' });
    assert.ok(c.hasBlank);
    assert.equal(Object.keys(c.models).length, 3);
    assert.equal(c.warnings.length, 0, c.warnings.join('; '));
    // 曲線 1–8% 添加量、含量 20% → 有效濃度 0.2–1.6%
    assert.ok(Math.abs(c.models.red.cRange[0] - 0.2) < 1e-9);
    assert.ok(Math.abs(c.models.red.cRange[1] - 1.6) < 1e-9);
});

test('direct 模式：濃度換算與預測一致', () => {
    const db = buildDb();
    const c = compile(db, { baseResinId: 'base1', carrierId: 'carrier1' });
    const f = makeFormulation({
        mode: RECIPE_MODE.DIRECT, baseResinId: 'base1', carrierId: 'carrier1',
        components: [{ colorantId: 'red', value: 3 }, { colorantId: 'yel', value: 1.5 }],
    });
    const eff = effectiveConcentrations(f, c.colorantsById);
    assert.ok(Math.abs(eff[0].c - 0.6) < 1e-9, '3% 色母 × 20% 含量 = 0.6%');
    assert.ok(Math.abs(eff[1].c - 0.3) < 1e-9);

    const p = predictFormulation(f, c);
    assert.ok(Number.isFinite(p.lab.l));
    assert.ok(p.confidence.score > 70, `score=${p.confidence.score} ${p.confidence.reasons.join(';')}`);
});

test('masterbatch 模式：letdown 正確稀釋', () => {
    const db = buildDb();
    const c = compile(db, { baseResinId: 'base1', carrierId: 'carrier1' });
    const direct = makeFormulation({
        mode: RECIPE_MODE.DIRECT, baseResinId: 'base1',
        components: [{ colorantId: 'red', value: 1 }],
    });
    // 母粒含 25% 紅色母，letdown 4% → 最終 1% 紅色母，與 direct 1% 等價
    const mb = makeFormulation({
        mode: RECIPE_MODE.MASTERBATCH, baseResinId: 'base1', letdown: 4,
        components: [{ colorantId: 'red', value: 25 }],
    });
    const a = predictFormulation(direct, c).lab;
    const b = predictFormulation(mb, c).lab;
    assert.ok(deltaE00(a, b) < 1e-6, `兩種模式應等價，ΔE=${deltaE00(a, b)}`);
});

test('母粒反推：由目標有效濃度回推母粒組成', () => {
    const db = buildDb();
    const byId = Object.fromEntries(db.colorants.map((x) => [x.id, x]));
    const r = backoutMasterbatch([{ colorantId: 'red', c: 0.2 }, { colorantId: 'yel', c: 0.1 }], 5, byId);
    // 紅：有效濃度 0.2% ÷ 20% 含量 = 1% 色母於最終 → ÷5% letdown = 20% 於母粒
    assert.ok(Math.abs(r.components[0].value - 20) < 1e-9);
    assert.ok(Math.abs(r.components[1].value - 10) < 1e-9);
    assert.ok(Math.abs(r.carrierPct - 70) < 1e-9);
    assert.ok(r.feasible);
});

test('母粒配方超過 100% 會被標記不可行', () => {
    const db = buildDb();
    const byId = Object.fromEntries(db.colorants.map((x) => [x.id, x]));
    const r = backoutMasterbatch([{ colorantId: 'red', c: 0.5 }], 1, byId);
    assert.equal(r.feasible, false, '0.5% 有效濃度配 1% letdown 需要 250% 母粒含量');
});

test('反解走完整管線並回傳可行配方', () => {
    const db = buildDb();
    const c = compile(db, { baseResinId: 'base1', carrierId: 'carrier1' });
    const truth = makeFormulation({
        mode: RECIPE_MODE.DIRECT, baseResinId: 'base1',
        components: [{ colorantId: 'red', value: 2.5 }, { colorantId: 'yel', value: 1.0 }],
    });
    const target = predictFormulation(truth, c).lab;

    const cols = buildSolverColorants(['red', 'yel', 'blu'], c);
    const r = solveRecipe({ target, colorants: cols, substrate: c.substrate });

    assert.ok(r.dE00 < 0.5, `ΔE00=${r.dE00}`);
    assert.equal(r.violations.length, 0);
    // 藍有 0.1% 最低含量，若解出微量藍必須歸零或達標
    const blueC = r.c[2];
    assert.ok(blueC === 0 || blueC >= 0.1 - 1e-9, `blue=${blueC}`);
});

test('最低含量檢查抓得到違規', () => {
    const db = buildDb();
    const byId = Object.fromEntries(db.colorants.map((x) => [x.id, x]));
    const f = makeFormulation({
        mode: RECIPE_MODE.DIRECT,
        components: [{ colorantId: 'blu', value: 0.1 }], // 0.1%×20% = 0.02% < 0.1% 下限
    });
    const v = checkLimits(effectiveConcentrations(f, byId));
    assert.equal(v.length, 1);
    assert.equal(v[0].kind, 'below_min');
});

test('缺本色與缺曲線會產生警告而非崩潰', () => {
    const db = buildDb();
    db.resins[0].blankLab = null;
    db.colorants.push(makeColorant({ id: 'empty', name: '未建曲線色母', curve: [] }));
    const c = compile(db, { baseResinId: 'base1' });
    assert.ok(c.warnings.some((w) => w.includes('本色')));
    assert.ok(c.warnings.some((w) => w.includes('未建曲線色母')));
    assert.equal(c.hasBlank, false);
});
