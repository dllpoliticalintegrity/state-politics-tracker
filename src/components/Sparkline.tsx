type Props = {
  values: number[];
  color: string;
  width?: number;
  height?: number;
};

export default function Sparkline({ values, color, width = 260, height = 36 }: Props) {
  if (!values || values.length < 2) {
    return (
      <svg
        viewBox={`0 0 ${width + 8} ${height}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height, display: "block" }}
      />
    );
  }

  // Smooth noisy polling data with a centered moving average.
  const windowSize = Math.min(5, Math.max(3, Math.floor(values.length / 4)));
  const half = Math.floor(windowSize / 2);
  const smoothed = values.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += values[k];
    return sum / (hi - lo + 1);
  });

  const min = Math.min(...smoothed);
  const max = Math.max(...smoothed);
  const range = Math.max(1, max - min);
  const coords = smoothed.map((v, i) => {
    const x = (i / (smoothed.length - 1)) * width;
    const y = height - 4 - ((v - min) / range) * (height - 8);
    return [x, y] as const;
  });

  // Catmull-Rom -> cubic Bezier for a smooth curve through every point.
  const tension = 0.5;
  let pts = `M${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i - 1] ?? coords[i];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[i + 2] ?? p2;
    const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension * 2;
    const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension * 2;
    const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension * 2;
    const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension * 2;
    pts += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  const lastX = coords[coords.length - 1][0];
  const lastY = coords[coords.length - 1][1];
  return (
    <svg
      viewBox={`0 0 ${width + 8} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height, display: "block" }}
    >
      <path
        d={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r="2.5" fill={color} />
    </svg>
  );
}
