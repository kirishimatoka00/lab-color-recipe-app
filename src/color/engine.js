/**
 * 引擎綁定層：把資料庫（樹酯、色料、歷史配方）編譯成可計算的模型。
 *
 * 流程固定且有順序相依，不能亂：
 *   1. 基材：由基礎樹酯本色 Lab 建 K_resin / S_resin
 *   2. 白：先擬合，因為彩色料要靠白的 k、s 才能從含白樣品反推自己的吸收
 *   3. 彩色料：用步驟 2 的白去還原
 *   4. 校正：用同條件的歷史配方擬合色力係數與殘差場
 */

import {
    makeSubstrate, DEFAULT_BLANK_LAB, fitColorant, fitWhite,
} from './km.js';
import { buildCalibration, calibrationKey, predictCalibrated } from './calibration.js';
import {
    COLORANT_ROLE, effectiveConcentrations, dosageToC,
} from '../data/schema.js';

/**
 * 編譯整個資料庫。
 * @param {object} db { resins:[], colorants:[], formulations:[] }
 * @param {object} ctx { baseResinId, carrierId, condition }
 * @returns {{substrate, models:Object<string,object>, calib, warnings:string[], hasBlank:boolean}}
 */
export function compile(db, ctx = {}) {
    const warnings = [];
    const resinsById = indexBy(db.resins || []);
    const colorantsById = indexBy(db.colorants || []);

    // --- 1. 基材 ---
    const baseResin = resinsById[ctx.baseResinId];
    const hasBlank = !!(baseResin && baseResin.blankLab);
    if (!hasBlank) {
        warnings.push(baseResin
            ? `基礎樹酯「${baseResin.name}」未量測本色，使用預設值，預測會有系統偏差`
            : '未指定基礎樹酯，使用預設本色');
    }
    const substrate = makeSubstrate(hasBlank ? baseResin.blankLab : DEFAULT_BLANK_LAB);

    // --- 2. 白 ---
    const models = {};
    const whites = (db.colorants || []).filter((c) => c.role === COLORANT_ROLE.WHITE);
    for (const w of whites) {
        const pts = curveToPoints(w, colorantsById, null);
        if (pts.length < 2) {
            warnings.push(`白色料「${w.name}」濃度曲線少於 2 點，無法擬合散射，暫以彩色料方式處理`);
            continue;
        }
        models[w.id] = fitWhite(pts.map((p) => ({ c: p.c, lab: p.lab })), substrate);
        models[w.id].cRange = [Math.min(...pts.map((p) => p.c)), Math.max(...pts.map((p) => p.c))];
    }

    // --- 3. 彩色料 ---
    for (const col of db.colorants || []) {
        if (models[col.id]) continue;
        const pts = curveToPoints(col, colorantsById, models);
        if (pts.length < 1) { warnings.push(`「${col.name}」沒有濃度曲線資料，無法參與預測`); continue; }
        const whiteModel = pts.find((p) => p.whiteModel)?.whiteModel || null;
        models[col.id] = fitColorant(
            pts.map((p) => ({ c: p.c, lab: p.lab, whiteC: p.whiteC })),
            substrate, whiteModel,
        );
        const worst = Math.min(...models[col.id].r2);
        if (worst < 0.9) warnings.push(`「${col.name}」濃度曲線擬合品質偏低（R²=${worst.toFixed(3)}）`);
    }

    // --- 4. 校正 ---
    const key = calibrationKey({ baseResinId: ctx.baseResinId, carrierId: ctx.carrierId, condition: ctx.condition });
    const samples = (db.formulations || [])
        .filter((f) => f.measuredLab && calibrationKey(f) === key)
        .map((f) => ({
            id: f.id,
            items: effectiveConcentrations(f, colorantsById)
                .filter((x) => x.colorant && models[x.colorantId])
                .map((x) => ({ colorantId: x.colorantId, model: models[x.colorantId], c: x.c })),
            measuredLab: f.measuredLab,
        }))
        .filter((s) => s.items.length > 0);

    const calib = buildCalibration(samples, substrate);
    if (calib.rejected) {
        warnings.push('歷史配方校正後誤差未改善，已略過色力校正（通常代表歷史資料條件不一致）');
    }

    return { substrate, models, calib, warnings, hasBlank, colorantsById, resinsById, sampleCount: samples.length };
}

/**
 * 把色料的濃度曲線（以色母添加量記錄）換算成「顏料有效濃度 + 白階」。
 */
function curveToPoints(colorant, colorantsById, whiteModels) {
    return (colorant.curve || [])
        .filter((p) => p.lab && p.dosage > 0)
        .map((p) => {
            const whiteCol = p.whiteColorantId ? colorantsById[p.whiteColorantId] : null;
            return {
                c: dosageToC(p.dosage, colorant),
                lab: p.lab,
                whiteC: whiteCol ? dosageToC(p.whiteDosage || 0, whiteCol) : 0,
                whiteModel: whiteModels && whiteCol ? whiteModels[whiteCol.id] || null : null,
            };
        });
}

const indexBy = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));

/**
 * 預測一張配方的顏色（含校正與信心分數）。
 */
export function predictFormulation(formulation, compiled) {
    const { substrate, models, calib, colorantsById, hasBlank } = compiled;
    const eff = effectiveConcentrations(formulation, colorantsById);
    const items = eff
        .filter((x) => models[x.colorantId])
        .map((x) => ({
            colorantId: x.colorantId, colorant: x.colorant,
            model: models[x.colorantId], c: x.c, dosage: x.dosage,
        }));

    const sameCarrier = items.every((it) =>
        !formulation.carrierId || !it.colorant?.carrierId || it.colorant.carrierId === formulation.carrierId);

    const out = predictCalibrated({ items, substrate, calib, sameCarrier, hasBlank });
    return { ...out, items, effective: eff };
}

/**
 * 組出反解用的色料清單。
 * @param {string[]} colorantIds 使用者勾選的色料
 */
export function buildSolverColorants(colorantIds, compiled) {
    const { models, calib, colorantsById } = compiled;
    return colorantIds
        .filter((id) => models[id])
        .map((id) => {
            const col = colorantsById[id];
            return {
                id,
                name: col?.name || id,
                colorant: col,
                model: models[id],
                minC: col?.minFinalPct || 0,
                maxC: col?.maxFinalPct || null,
                strength: calib?.strengths?.[id] ?? 1,
            };
        });
}

export default { compile, predictFormulation, buildSolverColorants };
