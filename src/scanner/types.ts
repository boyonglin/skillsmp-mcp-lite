type ScanStatus = "SAFE" | "UNSAFE" | "ERROR";

export interface ScanResult {
  available: boolean;
  status?: ScanStatus;
  maxSeverity?: string;
  totalFindings?: number;
  findings?: Array<{
    rule_id?: string;
    severity?: string;
    description?: string;
    file_path?: string;
    analyzer?: string;
  }>;
  analyzersUsed?: AnalyzerName[];
  scanDuration?: string;
  error?: string;
}

export type AnalyzerName = "static_analyzer" | "behavioral_analyzer";

export const CORE_ANALYZERS: ReadonlyArray<AnalyzerName> = [
  "static_analyzer",
  "behavioral_analyzer",
];

export function normalizeAnalyzerName(value: string): AnalyzerName | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "static" || normalized === "static_analyzer") {
    return "static_analyzer";
  }
  if (normalized === "behavioral" || normalized === "behavioral_analyzer") {
    return "behavioral_analyzer";
  }
  return undefined;
}

export function uniqueAnalyzers(values: Iterable<string>): AnalyzerName[] {
  const result = new Set<AnalyzerName>();
  for (const value of values) {
    const normalized = normalizeAnalyzerName(value);
    if (normalized) {
      result.add(normalized);
    }
  }
  return [...result];
}
