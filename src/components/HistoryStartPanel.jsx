import React from 'react';
import { Card, Button, Swatch, DeltaEBadge, Empty, fmt } from './ui.jsx';
import { findSimilarFormulations } from '../color/candidates.js';
import { effectiveConcentrations } from '../data/schema.js';

/**
 * 從歷史配方出發。
 *
 * 配方師本來就是先找「以前有沒有做過接近的」，調出那張當起點再微調。
 * 這個面板把那一步自動化：列出實測色最接近目標的幾張，點「以此為起點」
 * 就把它的色料與用量帶進工作台，接著可以直接反解或修色。
 */
export default function HistoryStartPanel({ target, compiled, threshold, onLoad }) {
    const list = React.useMemo(() => {
        const inScope = compiled.formulationsInScope || [];
        if (!inScope.length) return [];
        return findSimilarFormulations({
            target,
            formulations: inScope,
            effective: (f) => effectiveConcentrations(f, compiled.colorantsById),
            limit: 5,
        });
    }, [target, compiled]);

    if (!(compiled.formulationsInScope || []).length) {
        return (
            <Card title="從歷史配方開始">
                <Empty>
                    目前設定的基礎樹酯／載體／量測條件下沒有歷史配方。<br />
                    到「歷史配方」分頁建檔，或確認上方的條件設定與配方一致。
                </Empty>
            </Card>
        );
    }

    return (
        <Card title="從歷史配方開始">
            <p className="mb-2 text-[11px] text-slate-500">
                實測色最接近目標的既有配方。點「以此為起點」會把它的色料與用量帶進上方，
                接著可以直接反解微調，或用修色算出要加減多少。
            </p>
            <table className="w-full text-xs">
                <thead>
                    <tr className="border-b border-slate-200 text-left text-[10px] uppercase tracking-wide text-slate-400">
                        <th className="py-1">配方</th>
                        <th className="py-1">成分</th>
                        <th className="py-1 text-right">與目標差距</th>
                        <th className="py-1" />
                    </tr>
                </thead>
                <tbody>
                    {list.map((row, i) => {
                        const f = row.formulation;
                        const usable = row.items.filter((x) => compiled.models[x.colorantId]);
                        return (
                            <tr key={f.id} className={`border-b border-slate-100 last:border-0 ${i === 0 ? 'bg-blue-50/40' : ''}`}>
                                <td className="py-2 align-top">
                                    <div className="flex items-center gap-1.5">
                                        <Swatch lab={f.measuredLab} size={20} />
                                        <div>
                                            <div className="font-medium text-slate-700">{f.name}</div>
                                            <div className="text-[10px] text-slate-400">{f.date} · {f.status}</div>
                                        </div>
                                    </div>
                                </td>
                                <td className="py-2 align-top">
                                    <div className="space-y-0.5">
                                        {row.items.map((x) => (
                                            <div key={x.colorantId} className="flex justify-between gap-3 text-[11px]">
                                                <span className="text-slate-600">{x.colorant?.name}</span>
                                                <span className="font-mono text-slate-500">{fmt(x.c)}%</span>
                                            </div>
                                        ))}
                                    </div>
                                </td>
                                <td className="py-2 text-right align-top">
                                    <DeltaEBadge value={row.dE00} threshold={threshold} />
                                    <div className="mt-1 font-mono text-[10px] text-slate-400">
                                        ΔL {row.diff.dL >= 0 ? '+' : ''}{row.diff.dL.toFixed(1)}
                                        {' '}Δa {row.diff.da >= 0 ? '+' : ''}{row.diff.da.toFixed(1)}
                                        {' '}Δb {row.diff.db >= 0 ? '+' : ''}{row.diff.db.toFixed(1)}
                                    </div>
                                </td>
                                <td className="py-2 text-right align-top">
                                    <Button
                                        variant={i === 0 ? 'primary' : 'default'}
                                        disabled={usable.length === 0}
                                        onClick={() => onLoad(Object.fromEntries(usable.map((x) => [x.colorantId, x.c])))}
                                    >
                                        以此為起點
                                    </Button>
                                    {usable.length < row.items.length && (
                                        <div className="mt-1 text-[10px] text-amber-600">
                                            有 {row.items.length - usable.length} 支色料尚未建模
                                        </div>
                                    )}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </Card>
    );
}
