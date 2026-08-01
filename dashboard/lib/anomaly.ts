const ANOMALY_Z_THRESHOLD = 2.0;
const MIN_HISTORICAL_VALUES = 4;

export interface AnomalyResult {
  isAnomaly: boolean;
  currentValue?: number;
  mean?: number;
  stddev?: number;
  zScore?: number;
  direction?: "high" | "low" | "normal";
  explanation?: string;
}

function formatNum(n: number): string {
  return n.toLocaleString("es-ES", { maximumFractionDigits: 2 });
}

/**
 * Compute z-score anomaly detection.
 * values[0] = current period; values[1..] = historical.
 * Returns { isAnomaly: false } when insufficient data.
 */
export function computeAnomaly(values: number[]): AnomalyResult {
  if (values.length < MIN_HISTORICAL_VALUES + 1) {
    return { isAnomaly: false };
  }

  const currentValue = values[0];
  const historical = values.slice(1);

  const n = historical.length;
  const mean = historical.reduce((sum, v) => sum + v, 0) / n;
  const variance =
    historical.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
  const stddev = Math.sqrt(variance);

  if (stddev === 0) {
    return {
      isAnomaly: false,
      currentValue,
      mean,
      stddev: 0,
      zScore: 0,
      direction: "normal",
      explanation:
        currentValue === mean
          ? `El valor actual (${formatNum(currentValue)}) es igual a la media de los últimos ${n} períodos.`
          : `El valor actual (${formatNum(currentValue)}) difiere de la media (${formatNum(mean)}), pero todos los valores históricos son idénticos — no es posible evaluar si hay anomalía.`,
    };
  }

  const zScore = (currentValue - mean) / stddev;
  const isAnomaly = Math.abs(zScore) > ANOMALY_Z_THRESHOLD;
  const direction: "high" | "low" | "normal" =
    zScore > ANOMALY_Z_THRESHOLD
      ? "high"
      : zScore < -ANOMALY_Z_THRESHOLD
      ? "low"
      : "normal";

  const delta = currentValue - mean;
  const dirText = direction === "high" ? "por encima" : "por debajo";

  const explanation =
    direction !== "normal"
      ? mean !== 0
        ? `El valor actual (${formatNum(currentValue)}) está un ${Math.abs(((delta / Math.abs(mean)) * 100)).toFixed(0)}% ${dirText} de la media de los últimos ${n} períodos (${formatNum(mean)}).`
        : `El valor actual (${formatNum(currentValue)}) está ${dirText} de la media de los últimos ${n} períodos (${formatNum(mean)}), con una diferencia absoluta de ${formatNum(Math.abs(delta))}.`
      : `El valor actual (${formatNum(currentValue)}) está dentro del rango normal (media: ${formatNum(mean)}).`;

  return {
    isAnomaly,
    currentValue,
    mean,
    stddev,
    zScore,
    direction,
    explanation,
  };
}
