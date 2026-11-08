import React from 'react';
import {
    Card, Button, Field, NumberInput, LabInput, Swatch, DeltaEBadge, Empty, fmt,
} from './ui.jsx';
import { correctBatch, correctionToWeights } from '../color/candidates.js';

/**
 * 修色：試片已經打出來了，量到的顏色與目標有差，問各成分該加減多少。
 *
 * 關鍵在於把「實測 − 模型預測」當成這一爐料的局部偏差並固定住，
 * 再去解修正量。這比重跑一次反解準得多，因為偏差裡含了這爐料
 * 真實的分散狀況與機台條件。
 */
export default function CorrectionPanel({ solverCols, current, compiled, target, threshold, onApply }) {
    const [measured, setMeasured] = React.useState(null);
    const [addOnly, setAddOnly] = React.useState(true);
    const [batchKg, setBatchKg] = React.useState(100);

    const result = React.useMemo(() => {
        if (!measured || !current || !solverCols.length) return null;
        return correctBatch({
            colorants: solverCols, current, measured, target,
            substrate: compiled.substrate, addOnly,
        });
    }, [measured, current, solverCols, target, compiled, addOnly]);

    const weights = React.useMemo(
        () => (result ? correctionToWeights(result, solverCols, batchKg) : null),
        [result, solverCols, batchKg],
    );

    if (!current) return null;

    return (
        <Card title="修色（試片 → 目標）">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div>
                    <div className="mb-1 text-[11px] font-medium text-slate-600">試片實測色</div>
                    {measured
                        ? <LabInput lab={measured} onChange={setMeasured} />
                        : (
                            <Button onClick={() => setMeasured({ ...target })}>
                                填入試片量測值
                            </Button>
                        )}
                </div>
                <div className="flex flex-wrap items-end gap-3">
                    <Field label="批量 (kg)" className="w-28">
                        <NumberInput value={batchKg} onChange={setBatchKg} />
                    </Field>
                    <label className="flex items-center gap-1.5 pb-2 text-[11px] text-slate-600">
                        <input type="checkbox" checked={addOnly} onChange={(e) => setAddOnly(e.target.checked)} />
                        只加不減（料已在桶內）
                    </label>
                </div>
            </div>

            {!measured ? (
                <div className="mt-3">
                    <Empty>填入試片的實測 Lab，程式會算出各成分要加減多少。</Empty>
                </div>
            ) : !result ? null : (
                <>
                    <div className="mt-3 flex flex-wrap items-center gap-4 rounded-md bg-slate-50 p-2">
                        <div className="text-center">
                            <Swatch lab={result.before.lab} size={36} />
                            <div className="mt-1 text-[10px] text-slate-500">目前試片</div>
                        </div>
                        <div className="text-center">
                            <Swatch lab={target} size={36} />
                            <div className="mt-1 text-[10px] text-slate-500">目標</div>
                        </div>
                        <div className="text-center">
                            <Swatch lab={result.lab} size={36} />
                            <div className="mt-1 text-[10px] text-slate-500">修色後預測</div>
                        </div>
                        <div className="flex flex-col gap-1 text-[11px]">
                            <div className="flex items-center gap-2">
                                <span className="w-16 text-slate-400">修色前</span>
                                <DeltaEBadge value={result.before.dE00} threshold={threshold} />
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="w-16 text-slate-400">修色後</span>
                                <DeltaEBadge value={result.dE00} threshold={threshold} />
                            </div>
                        </div>
                    </div>

                    <div className="mt-2 text-[11px] text-slate-500">
                        這爐料的偏差：ΔL {result.bias.l >= 0 ? '+' : ''}{result.bias.l.toFixed(2)} ·
                        Δa {result.bias.a >= 0 ? '+' : ''}{result.bias.a.toFixed(2)} ·
                        Δb {result.bias.b >= 0 ? '+' : ''}{result.bias.b.toFixed(2)}
                        <span className="ml-1 text-slate-400">（實測相對模型預測，修色時假設它維持不變）</span>
                    </div>

                    <table className="mt-3 w-full text-xs">
                        <thead>
                            <tr className="border-b border-slate-200 text-left text-[10px] uppercase tracking-wide text-slate-400">
                                <th className="py-1">色料</th>
                                <th className="py-1 text-right">目前濃度</th>
                                <th className="py-1 text-right">修正後</th>
                                <th className="py-1 text-right">色母增減 wt%</th>
                                <th className="py-1 text-right">{batchKg} kg 要加</th>
                            </tr>
                        </thead>
                        <tbody>
                            {weights.map((w, i) => {
                                const none = Math.abs(w.deltaC) < 1e-4;
                                return (
                                    <tr key={w.id} className="border-b border-slate-100 last:border-0">
                                        <td className="py-1.5 text-slate-700">{w.name}</td>
                                        <td className="py-1.5 text-right font-mono text-slate-500">{fmt(current[i])}</td>
                                        <td className="py-1.5 text-right font-mono text-slate-700">{fmt(result.c[i])}</td>
                                        <td className={`py-1.5 text-right font-mono ${
                                            none ? 'text-slate-300' : w.deltaDosage > 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                                            {none ? '—' : `${w.deltaDosage > 0 ? '+' : ''}${fmt(w.deltaDosage)}`}
                                        </td>
                                        <td className={`py-1.5 text-right font-mono font-semibold ${
                                            none ? 'text-slate-300' : w.kg > 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                                            {none ? '—' : `${w.kg > 0 ? '+' : ''}${w.kg.toFixed(3)} kg`}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>

                    {addOnly && result.delta.every((d) => Math.abs(d) < 1e-4) && (
                        <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
                            只加不減的前提下找不到改善空間。這批料可能已經過濃，需要加基礎樹酯稀釋，
                            或取消勾選看看完整的修正方向。
                        </p>
                    )}
                    {result.violations.length > 0 && (
                        <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
                            修正後有成分低於最低含量：{result.violations.map((v) => v.name).join('、')}
                        </p>
                    )}

                    <div className="mt-2 flex items-center gap-2">
                        <Button onClick={() => onApply(result.c)}>把修正後的配方帶入上方</Button>
                        <Button variant="ghost" onClick={() => setMeasured(null)}>清除</Button>
                    </div>
                </>
            )}
        </Card>
    );
}
