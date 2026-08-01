/**
 * Coin multipliers for crop mutations. A crop carries at most one colour, one weather and one time
 * mutation; some weather/time pairs are worth more together than either alone, so the combination
 * table wins when both are present.
 */
const COLOR_MULT = { Gold: 25, Rainbow: 50 };
const WEATHER_MULT = { Wet: 2, Chilled: 2, Frozen: 6, Thunderstruck: 5, Thundercharged: 7 };
const TIME_MULT = { Dawnlit: 4, Dawnbound: 7, Dawncharged: 7, Ambershine: 6, Amberbound: 10, Ambercharged: 10 };
const COMBO_MULT = { 'Wet+Dawnlit': 5, 'Chilled+Dawnlit': 5, 'Wet+Ambershine': 7, 'Chilled+Ambershine': 7, 'Frozen+Dawnlit': 9, 'Frozen+Dawnbound': 12, 'Frozen+Dawncharged': 12, 'Frozen+Ambershine': 11, 'Frozen+Amberbound': 15, 'Frozen+Ambercharged': 15, 'Thunderstruck+Dawnlit': 8, 'Thunderstruck+Dawnbound': 11, 'Thunderstruck+Dawncharged': 11, 'Thunderstruck+Ambershine': 10, 'Thunderstruck+Amberbound': 14, 'Thunderstruck+Ambercharged': 14, 'Thundercharged+Dawnlit': 10, 'Thundercharged+Dawnbound': 13, 'Thundercharged+Dawncharged': 13, 'Thundercharged+Ambershine': 12, 'Thundercharged+Amberbound': 16, 'Thundercharged+Ambercharged': 16 };

export function mutationMultiplier(mutations) {
  const color = Math.max(1, ...mutations.map(value => COLOR_MULT[value] || 1));
  const weather = mutations.sort((a, b) => (WEATHER_MULT[b] || 0) - (WEATHER_MULT[a] || 0)).find(value => WEATHER_MULT[value]);
  const time = mutations.sort((a, b) => (TIME_MULT[b] || 0) - (TIME_MULT[a] || 0)).find(value => TIME_MULT[value]);
  return color * (COMBO_MULT[`${weather}+${time}`] || Math.max(WEATHER_MULT[weather] || 1, TIME_MULT[time] || 1));
}
