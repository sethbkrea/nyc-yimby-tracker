// NYC Open Data integration for the property research feature.
//
// Two DOB systems are queried:
//   • DOB NOW  — "DOB NOW: Build – Job Application Filings" (w9ak-ipjd)
//   • DOB BIS  — "DOB Permit Issuance" (ipu4-2q9a)
//
// The job/work-type filters below mirror the codes the team tracks:
//   DOB NOW job types: New Building, Full Demolition, ALT-CO (New Buildings),
//                      ALT-CO, Alteration. For Alteration filings we keep only
//                      those carrying one of the structural work types
//                      GC/ST/MS/FO/SE/EA (i.e. real construction, not cosmetic).
//   DOB BIS job types: NB, DM, A1, A2.

const SODA_NOW = "https://data.cityofnewyork.us/resource/w9ak-ipjd.json";
const SODA_BIS = "https://data.cityofnewyork.us/resource/ipu4-2q9a.json";
const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search";

// DOB NOW job_type values to include (verbatim dataset spellings).
export const DOB_NOW_JOB_TYPES = [
  "New Building",
  "Full Demolition",
  "ALT-CO - New Building with Existing Elements to Remain",
  "Alteration CO",
  "Alteration",
] as const;

// Short labels shown in the UI for the verbose dataset spellings.
export const DOB_NOW_JOB_TYPE_LABEL: Record<string, string> = {
  "New Building": "New Building",
  "Full Demolition": "Full Demolition",
  "ALT-CO - New Building with Existing Elements to Remain": "ALT-CO – New Buildings",
  "Alteration CO": "ALT-CO",
  Alteration: "Alteration",
};

// Alteration work-type code → the dataset's YES/NO column for it.
export const DOB_NOW_WORK_TYPE_COLS: Record<string, string> = {
  GC: "general_construction_work_type_",
  ST: "structural_work_type_",
  MS: "mechanical_systems_work_type_",
  FO: "foundation_work_type_",
  SE: "support_of_excavation_work_type_",
  EA: "earth_work_work_type_",
};

export const DOB_BIS_JOB_TYPES = ["NB", "DM", "A1", "A2"] as const;

const BORO_NAME: Record<string, string> = {
  "1": "MANHATTAN",
  "2": "BRONX",
  "3": "BROOKLYN",
  "4": "QUEENS",
  "5": "STATEN ISLAND",
};

export interface ResolvedProperty {
  /** The raw string the user supplied. */
  input: string;
  /** 10-digit BBL, or null if it could not be resolved. */
  bbl: string | null;
  /** Best display address. */
  address: string | null;
  borough: string | null;
  block: string | null;
  lot: string | null;
  /** Set when resolution failed, e.g. "could not geocode". */
  error?: string;
}

export interface DobNowPermit {
  source: "DOB NOW";
  jobFilingNumber: string;
  jobType: string;
  jobTypeLabel: string;
  status: string;
  filingDate: string;
  approvedDate: string;
  workTypes: string[]; // matched GC/ST/MS/FO/SE/EA codes
  description: string;
}

export interface DobBisPermit {
  source: "DOB BIS";
  jobNumber: string;
  jobType: string;
  status: string;
  filingDate: string;
  issuanceDate: string;
  workType: string;
  permitType: string;
}

export type Permit = DobNowPermit | DobBisPermit;

function appToken(): Record<string, string> {
  const t = process.env.NYC_APP_TOKEN;
  return t ? { "X-App-Token": t } : {};
}

async function soda(base: string, params: Record<string, string>): Promise<unknown[]> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${base}?${qs}`, {
    headers: appToken(),
    next: { revalidate: 300 }, // permits change slowly; 5-min cache is plenty
  });
  if (!res.ok) {
    throw new Error(`NYC Open Data ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) throw new Error("Open Data response was not an array");
  return data;
}

const isBbl = (s: string) => /^\d{10}$/.test(s.replace(/\D/g, "")) && s.replace(/\D/g, "").length === 10;

function bblParts(bbl: string): { boro: string; block: string; lot: string } {
  return { boro: bbl[0], block: bbl.slice(1, 6), lot: bbl.slice(6, 10) };
}

/** Resolve a raw input (address or 10-digit BBL) to a property. */
export async function resolveProperty(input: string): Promise<ResolvedProperty> {
  const raw = input.trim();
  const digits = raw.replace(/\D/g, "");

  // BBL path: look up the canonical address from PLUTO.
  if (isBbl(raw) || (digits.length === 10 && /^\d[\d\s-]+$/.test(raw))) {
    const bbl = digits;
    const { boro, block, lot } = bblParts(bbl);
    try {
      const rows = await soda("https://data.cityofnewyork.us/resource/64uk-42ks.json", {
        $select: "address,borough,zipcode",
        bbl,
        $limit: "1",
      });
      const r = (rows[0] ?? {}) as Record<string, string>;
      return {
        input: raw,
        bbl,
        address: r.address ?? null,
        borough: BORO_NAME[boro] ?? null,
        block: String(parseInt(block, 10)),
        lot: String(parseInt(lot, 10)),
      };
    } catch {
      return {
        input: raw, bbl, address: null,
        borough: BORO_NAME[boro] ?? null,
        block: String(parseInt(block, 10)), lot: String(parseInt(lot, 10)),
      };
    }
  }

  // Address path: geocode via NYC GeoSearch.
  try {
    const qs = new URLSearchParams({ text: raw, size: "1" }).toString();
    const res = await fetch(`${GEOSEARCH}?${qs}`, { next: { revalidate: 86400 } });
    if (!res.ok) throw new Error(`geosearch ${res.status}`);
    const j = (await res.json()) as {
      features?: { properties?: Record<string, unknown> }[];
    };
    const p = j.features?.[0]?.properties as
      | { label?: string; addendum?: { pad?: { bbl?: string } } }
      | undefined;
    const bbl = p?.addendum?.pad?.bbl ?? null;
    if (!bbl) return { input: raw, bbl: null, address: null, borough: null, block: null, lot: null, error: "could not geocode address" };
    const { boro, block, lot } = bblParts(bbl);
    return {
      input: raw,
      bbl,
      address: p?.label ?? raw,
      borough: BORO_NAME[boro] ?? null,
      block: String(parseInt(block, 10)),
      lot: String(parseInt(lot, 10)),
    };
  } catch (err) {
    return {
      input: raw, bbl: null, address: null, borough: null, block: null, lot: null,
      error: err instanceof Error ? err.message : "could not resolve",
    };
  }
}

/** DOB NOW filings for a BBL, filtered to tracked job/work types. */
export async function fetchDobNow(bbl: string): Promise<DobNowPermit[]> {
  const jobList = DOB_NOW_JOB_TYPES.map((t) => `'${t.replace(/'/g, "''")}'`).join(",");
  const cols = Object.values(DOB_NOW_WORK_TYPE_COLS).join(",");
  const rows = (await soda(SODA_NOW, {
    $select: `job_filing_number,job_type,filing_status,filing_date,approved_date,job_description,${cols}`,
    $where: `bbl='${bbl}' AND job_type in (${jobList})`,
    $order: "filing_date DESC",
    $limit: "500",
  })) as Record<string, string>[];

  const out: DobNowPermit[] = [];
  for (const r of rows) {
    const matched: string[] = [];
    for (const [code, col] of Object.entries(DOB_NOW_WORK_TYPE_COLS)) {
      if ((r[col] ?? "").toUpperCase() === "YES") matched.push(code);
    }
    // For plain "Alteration", require at least one tracked structural work type;
    // other job types (NB, demo, ALT-CO) are kept regardless.
    if (r.job_type === "Alteration" && matched.length === 0) continue;
    out.push({
      source: "DOB NOW",
      jobFilingNumber: r.job_filing_number ?? "",
      jobType: r.job_type ?? "",
      jobTypeLabel: DOB_NOW_JOB_TYPE_LABEL[r.job_type ?? ""] ?? r.job_type ?? "",
      status: r.filing_status ?? "",
      filingDate: (r.filing_date ?? "").slice(0, 10),
      approvedDate: (r.approved_date ?? "").slice(0, 10),
      workTypes: matched,
      description: r.job_description ?? "",
    });
  }
  return out;
}

/** DOB BIS permit issuances for a lot, filtered to tracked job types. */
export async function fetchDobBis(
  borough: string | null,
  block: string | null,
  lot: string | null,
): Promise<DobBisPermit[]> {
  if (!borough || !block || !lot) return [];
  const jobList = DOB_BIS_JOB_TYPES.map((t) => `'${t}'`).join(",");
  const block5 = block.padStart(5, "0");
  const lot5 = lot.padStart(5, "0");
  const rows = (await soda(SODA_BIS, {
    $select: "job__,job_type,permit_status,filing_date,issuance_date,work_type,permit_type",
    $where: `block='${block5}' AND lot='${lot5}' AND borough='${borough}' AND job_type in (${jobList})`,
    $order: "filing_date DESC",
    $limit: "500",
  })) as Record<string, string>[];

  return rows.map((r) => ({
    source: "DOB BIS" as const,
    jobNumber: r.job__ ?? "",
    jobType: r.job_type ?? "",
    status: r.permit_status ?? "",
    filingDate: (r.filing_date ?? "").slice(0, 10),
    issuanceDate: (r.issuance_date ?? "").slice(0, 10),
    workType: r.work_type ?? "",
    permitType: r.permit_type ?? "",
  }));
}
