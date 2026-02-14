import { type ScanResult, CORE_ANALYZERS, uniqueAnalyzers } from "./types.js";
import { ensureScannerApi } from "./lifecycle.js";
import { buildZipBuffer } from "../zip.js";
import { getErrorMessage } from "../utils.js";

const SKILL_SCAN_API_TIMEOUT_MS = 120_000;

async function runSkillScannerApi(
  files: Map<string, Buffer>,
  apiUrl: string
): Promise<ScanResult> {
  const queryParams = new URLSearchParams();
  queryParams.set("use_behavioral", "true");

  const llmApiKey = process.env.SKILL_SCANNER_LLM_API_KEY;
  const llmModel = process.env.SKILL_SCANNER_LLM_MODEL;
  const llmProvider = process.env.SKILL_SCANNER_LLM_PROVIDER;

  if (llmApiKey) {
    queryParams.set("use_llm", "true");
    if (llmModel) {
      queryParams.set("llm_model", llmModel);
    }
    if (llmProvider) {
      queryParams.set("llm_provider", llmProvider);
    }
  }

  const requestedAnalyzers = CORE_ANALYZERS;

  const scanUrl = `${apiUrl.replace(/\/$/, "")}/scan-upload?${queryParams.toString()}`;
  console.error(`[Scanner] scan-upload request URL: ${scanUrl}`);
  console.error(
    `[Scanner] requested analyzers: ${requestedAnalyzers.join(", ")}`
  );
  console.error(`[Scanner] files in zip: ${files.size}`);

  const zipBuffer = buildZipBuffer(files);

  const boundary = `----SkillSMPBoundary${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const parts: Buffer[] = [];

  const appendFormField = (name: string, value: string) => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  };

  appendFormField("use_behavioral", "true");
  if (llmApiKey) {
    appendFormField("use_llm", "true");
    if (llmModel) {
      appendFormField("llm_model", llmModel);
    }
    if (llmProvider) {
      appendFormField("llm_provider", llmProvider);
    }
  }

  // File part
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skill.zip"\r\nContent-Type: application/zip\r\n\r\n`
    )
  );
  parts.push(zipBuffer);
  parts.push(Buffer.from("\r\n"));

  // End boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    SKILL_SCAN_API_TIMEOUT_MS
  );

  try {
    const response = await fetch(scanUrl, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      return {
        available: true,
        status: "ERROR",
        error: `API returned ${response.status}: ${errorBody}`,
      };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      return {
        available: true,
        status: "ERROR",
        error: `Skill Scanner API returned invalid JSON from ${scanUrl}`,
      };
    }

    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const analyzersFromResponse = Array.isArray(parsed.analyzers_used)
      ? uniqueAnalyzers(parsed.analyzers_used.map((value) => String(value)))
      : [];
    const analyzersFromFindings = uniqueAnalyzers(
      findings
        .map((f) =>
          typeof f === "object" && f !== null
            ? (f as Record<string, unknown>).analyzer
            : ""
        )
        .map((value) => String(value || ""))
    );
    const executedAnalyzers = uniqueAnalyzers([
      ...requestedAnalyzers,
      ...analyzersFromResponse,
      ...analyzersFromFindings,
    ]);
    console.error(
      `[Scanner] executed analyzers: ${executedAnalyzers.length > 0 ? executedAnalyzers.join(", ") : "(none reported)"}`
    );
    return {
      available: true,
      status: parsed.is_safe === true ? "SAFE" : "UNSAFE",
      maxSeverity: String(parsed.max_severity || "UNKNOWN"),
      totalFindings:
        typeof parsed.findings_count === "number"
          ? parsed.findings_count
          : findings.length,
      findings: findings.map((f: Record<string, unknown>) => ({
        rule_id: String(f.rule_id || f.ruleId || ""),
        severity: String(f.severity || ""),
        description: String(f.description || f.message || ""),
        file_path: String(f.file_path || f.filePath || ""),
        analyzer: String(f.analyzer || ""),
      })),
      analyzersUsed:
        executedAnalyzers.length > 0 ? executedAnalyzers : undefined,
      scanDuration:
        typeof parsed.scan_duration_seconds === "number"
          ? `${parsed.scan_duration_seconds}s`
          : undefined,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        available: true,
        status: "ERROR",
        error: "Skill Scanner API request timed out",
      };
    }
    return {
      available: false,
      error: `Skill Scanner API unreachable at ${apiUrl}: ${getErrorMessage(error)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function runSkillScanner(
  files: Map<string, Buffer>
): Promise<ScanResult> {
  const apiUrl = await ensureScannerApi();

  if (!apiUrl) {
    return {
      available: false,
      error:
        "Security scanner not available — uvx is not installed.\n" +
        "Install uv to enable automatic security scanning:\n" +
        "  macOS/Linux: curl -LsSf https://astral.sh/uv/install.sh | sh\n" +
        '  Windows: powershell -c "irm https://astral.sh/uv/install.ps1 | iex"\n' +
        "Skill content was still read successfully.",
    };
  }

  return runSkillScannerApi(files, apiUrl);
}
