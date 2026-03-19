let tradingEnabled = true;

export const initTradingEnabled = (enabled: boolean): void => {
    tradingEnabled = enabled;
};

export const isTradingEnabled = (): boolean => tradingEnabled;

export const setTradingEnabled = (enabled: boolean): void => {
    tradingEnabled = enabled;
};

