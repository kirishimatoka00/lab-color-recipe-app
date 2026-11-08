import React from 'react';

/**
 * 主題：預設暗色。
 * 'dark' class 掛在 <html> 上，Tailwind 的 dark: 變體與 index.css 的
 * CSS 變數都吃這一個開關。
 */
const KEY = 'recipe_theme';

function readPref() {
    try {
        const saved = window.localStorage.getItem(KEY);
        if (saved === 'light') return false;
        if (saved === 'dark') return true;
    } catch { /* 無痕模式讀不到就用預設 */ }
    return true;
}

// 在第一次渲染前就把 class 掛上，避免開場閃一下亮色
if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', readPref());
}

const ThemeContext = React.createContext({ dark: true, toggle: () => {} });

export const useTheme = () => React.useContext(ThemeContext);

export function ThemeProvider({ children }) {
    const [dark, setDark] = React.useState(readPref);

    React.useEffect(() => {
        document.documentElement.classList.toggle('dark', dark);
        try { window.localStorage.setItem(KEY, dark ? 'dark' : 'light'); } catch { /* 忽略 */ }
    }, [dark]);

    const value = React.useMemo(() => ({ dark, toggle: () => setDark((d) => !d) }), [dark]);
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * 圖表色盤。
 *
 * 不從 getComputedStyle 讀 CSS 變數：那要等 .dark class 掛上去才正確，
 * 而 class 是在 effect 裡掛的，第一次渲染必定讀到亮色值，圖就會是白底。
 * 直接用 JS 常數，渲染時機就不影響結果。index.css 裡的同名變數只給
 * 純 CSS 的地方用（例如空色票的斜線底紋），兩邊值保持一致。
 */
const PALETTE = {
    light: {
        face: '#fafafa', frame: '#e2e8f0', grid: '#eef2f7',
        axis: '#cbd5e1', label: '#94a3b8', ink: '#0f172a',
    },
    dark: {
        face: '#0f172a', frame: '#334155', grid: '#1e293b',
        axis: '#475569', label: '#94a3b8', ink: '#e2e8f0',
    },
};

export function usePlotColors() {
    const { dark } = useTheme();
    return React.useMemo(() => ({ ...(dark ? PALETTE.dark : PALETTE.light), dark }), [dark]);
}
