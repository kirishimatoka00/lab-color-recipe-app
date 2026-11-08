/**
 * 資料結構定義與濃度換算
 *
 * 濃度帳是整個模型的地基，所有換算集中在這裡，不散落到 UI 或求解器。
 *
 * 名詞：
 *  - dosage      某成分佔「最終製品」的重量百分比 (wt%)
 *  - pctInMB     某成分佔「母粒」的重量百分比 (wt%)
 *  - letdown     母粒佔最終製品的重量百分比 (wt%)
 *  - pigmentLoading  顏料佔該色母 (SPD) 的重量百分比 (wt%)
 *  - c (有效濃度)  顏料本身佔最終製品的重量百分比 (wt%)  ← 模型真正吃的量
 *
 * 兩種配方模式：
 *  direct       色母直接加進基礎樹酯        c = dosage × pigmentLoading / 100
 *  masterbatch  先做複合母粒再 letdown      c = letdown/100 × pctInMB × pigmentLoading / 100
 */

export const COLORANT_TYPE = { SPD: 'SPD', RAW: 'RAW_PIGMENT' };
export const COLORANT_ROLE = { CHROMATIC: 'chromatic', WHITE: 'white' };
export const RECIPE_MODE = { DIRECT: 'direct', MASTERBATCH: 'masterbatch' };
export const ADDITIVE_TYPE = { WAX: 'wax', AO: 'AO', OTHER: 'other' };

let seq = 0;
export const newId = (prefix = 'id') =>
    `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

/* ------------------------------------------------------------------ *
 * 工廠函式
 * ------------------------------------------------------------------ */

/** 基礎樹酯 / 母粒載體。兩者共用同一張表，用 usage 區分可當哪一種。 */
export const makeResin = (o = {}) => ({
    id: o.id || newId('res'),
    name: o.name || '',
    grade: o.grade || '',
    mfi: o.mfi ?? null,
    /** 未著色本色 Lab；留空則用預設值並標記低信心 */
    blankLab: o.blankLab || null,
    /** 'base' | 'carrier' | 'both' */
    usage: o.usage || 'both',
    note: o.note || '',
});

/**
 * 色母 (SPD) 或單一色粉。
 * curve 的每一點都要記錄量測當時的白階，否則含白系統無法還原。
 */
export const makeColorant = (o = {}) => ({
    id: o.id || newId('col'),
    name: o.name || '',
    code: o.code || '',
    type: o.type || COLORANT_TYPE.SPD,
    role: o.role || COLORANT_ROLE.CHROMATIC,
    /** 載體樹酯 id；RAW_PIGMENT 為 null。預測分群的 key。 */
    carrierId: o.carrierId || null,
    /** 顏料佔本色母的 wt%。RAW_PIGMENT 固定 100。 */
    pigmentLoading: o.pigmentLoading ?? (o.type === COLORANT_TYPE.RAW ? 100 : 20),
    additives: o.additives || [],
    /** 顏料在最終製品的最低有效濃度 (wt%)。使用者答覆：限制是看最終製品含量。 */
    minFinalPct: o.minFinalPct ?? 0,
    /** 顏料在最終製品的最高有效濃度 (wt%)，0 或 null 表示不限 */
    maxFinalPct: o.maxFinalPct ?? null,
    /**
     * 濃度曲線。每點：
     *   { dosage, whiteDosage, lab, resinId, condition, note, spectrum? }
     *   dosage      本色母在量測樣品中的添加量 (wt%)
     *   whiteDosage 同一樣品中白色母的添加量 (wt%)，無白填 0
     *   whiteColorantId 該白色母的 id（跨白階還原需要）
     */
    curve: o.curve || [],
    /** 擬合結果快取，由 calibration/engine 寫入 */
    fit: o.fit || null,
    density: o.density ?? null,
    supplier: o.supplier || '',
    note: o.note || '',
});

export const makeCurvePoint = (o = {}) => ({
    id: o.id || newId('pt'),
    dosage: o.dosage ?? 0,
    whiteDosage: o.whiteDosage ?? 0,
    whiteColorantId: o.whiteColorantId || null,
    lab: o.lab || { l: 0, a: 0, b: 0 },
    resinId: o.resinId || null,
    condition: o.condition || '',
    note: o.note || '',
    spectrum: o.spectrum || null, // 預留：未來接光譜資料
});

export const makeAdditive = (o = {}) => ({
    type: o.type || ADDITIVE_TYPE.WAX,
    name: o.name || '',
    pct: o.pct ?? 0,
});

/** 配方 */
export const makeFormulation = (o = {}) => ({
    id: o.id || newId('rec'),
    name: o.name || '',
    date: o.date || new Date().toISOString().slice(0, 10),
    mode: o.mode || RECIPE_MODE.DIRECT,
    baseResinId: o.baseResinId || null,
    carrierId: o.carrierId || null,
    /** [{ colorantId, value }]；value 的意義依 mode 決定 */
    components: o.components || [],
    additives: o.additives || [],
    letdown: o.letdown ?? 100,
    measuredLab: o.measuredLab || null,
    condition: o.condition || '',
    status: o.status || '試打',
    note: o.note || '',
});

/* ------------------------------------------------------------------ *
 * 濃度換算
 * ------------------------------------------------------------------ */

/**
 * 算出配方中每支色料的有效濃度（顏料佔最終製品 wt%）。
 * @returns {Array<{colorantId, colorant, dosage, c}>}
 *          dosage 為該色母佔最終製品的 wt%，c 為顏料的有效濃度
 */
export function effectiveConcentrations(formulation, colorantsById) {
    const isMB = formulation.mode === RECIPE_MODE.MASTERBATCH;
    const letdownFrac = isMB ? (formulation.letdown ?? 0) / 100 : 1;

    return formulation.components.map((comp) => {
        const col = colorantsById[comp.colorantId];
        const loading = col ? col.pigmentLoading : 100;
        const dosage = (comp.value ?? 0) * letdownFrac;      // 色母佔最終製品 wt%
        return {
            colorantId: comp.colorantId,
            colorant: col || null,
            dosage,
            c: (dosage * loading) / 100,                      // 顏料佔最終製品 wt%
        };
    });
}

/** 由有效濃度反推該色母的添加量（最終製品 wt%） */
export const cToDosage = (c, colorant) =>
    colorant && colorant.pigmentLoading > 0 ? (c * 100) / colorant.pigmentLoading : 0;

/** 由色母添加量算有效濃度 */
export const dosageToC = (dosage, colorant) =>
    colorant ? (dosage * (colorant.pigmentLoading ?? 100)) / 100 : 0;

/**
 * 母粒配方模式下，由目標有效濃度回推母粒組成。
 * @param {Array<{colorantId, c}>} targets 各顏料在最終製品的有效濃度
 * @param {number} letdown 母粒添加量 (wt%)
 * @param {object} colorantsById
 * @returns {{components:Array<{colorantId, value}>, carrierPct:number, feasible:boolean}}
 *          value 為該色母佔母粒的 wt%，carrierPct 為母粒中剩餘載體的 wt%
 */
export function backoutMasterbatch(targets, letdown, colorantsById) {
    const frac = letdown / 100;
    const components = targets.map((t) => {
        const col = colorantsById[t.colorantId];
        const dosageInFinal = cToDosage(t.c, col);
        return { colorantId: t.colorantId, value: frac > 0 ? dosageInFinal / frac : 0 };
    });
    const used = components.reduce((s, c) => s + c.value, 0);
    return { components, carrierPct: 100 - used, feasible: used <= 100 + 1e-9 };
}

/* ------------------------------------------------------------------ *
 * 約束檢查
 * ------------------------------------------------------------------ */

/**
 * 檢查最低/最高含量限制。使用者定義：限制看的是顏料在最終製品的含量。
 * 濃度為 0（這支沒用到）不算違規。
 */
export function checkLimits(items) {
    const violations = [];
    for (const it of items) {
        const col = it.colorant;
        if (!col || it.c <= 0) continue;
        if (col.minFinalPct > 0 && it.c < col.minFinalPct - 1e-9) {
            violations.push({
                colorantId: col.id, name: col.name, kind: 'below_min',
                value: it.c, limit: col.minFinalPct,
            });
        }
        if (col.maxFinalPct && it.c > col.maxFinalPct + 1e-9) {
            violations.push({
                colorantId: col.id, name: col.name, kind: 'above_max',
                value: it.c, limit: col.maxFinalPct,
            });
        }
    }
    return violations;
}

/** 配方內色母總添加量（最終製品 wt%），用來擋「加起來超過 100%」 */
export const totalDosage = (items) => items.reduce((s, it) => s + it.dosage, 0);

export default {
    COLORANT_TYPE, COLORANT_ROLE, RECIPE_MODE, ADDITIVE_TYPE, newId,
    makeResin, makeColorant, makeCurvePoint, makeAdditive, makeFormulation,
    effectiveConcentrations, cToDosage, dosageToC, backoutMasterbatch,
    checkLimits, totalDosage,
};
