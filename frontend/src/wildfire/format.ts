export const fmtClock = (min: number) => {
  const h = Math.floor(min / 60), m = Math.floor(min % 60)
  return `+${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
