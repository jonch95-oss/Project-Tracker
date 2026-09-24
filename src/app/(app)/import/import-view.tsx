"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Button,
  Field,
  Input,
  PageHeader,
  Panel,
  Select,
  StatusPill,
} from "@/components/ui/primitives";
import {
  guessMapping,
  IMPORT_FIELDS,
  IMPORT_KIND_LABEL,
  IMPORT_KINDS,
  MAX_PROJECT_IMPORT_ROWS,
  validateRows,
  type ImportKind,
  type ImportSheet,
  type RejectedRow,
} from "@/core/import";
import { PROJECT_TYPE_LABEL } from "@/core/labels";
import { errorMessage, useTRPC } from "@/lib/trpc";

type Sheet = ImportSheet;
type Result = {
  read: number;
  valid: number;
  imported: number;
  rejected: RejectedRow[];
};

const WHAT: Record<ImportKind, string> = {
  projects:
    "One row per project: name, address, borough, BBL, type, and any key facts.",
  budget:
    "One row per budget line: category, line, amount. Goes into the project you choose.",
  units:
    "One row per unit: unit, floor, sf, beds, baths, exposure, outdoor space, asking price.",
  vendors:
    "One row per company: name, kind, trade, phone, email, website, notes.",
  template:
    "One row per task: phase, task, role, days due, and the task it follows. Becomes a new template.",
};

/** Module N: import projects, budgets, unit schedules, the directory and checklist templates from .xlsx or .csv. */
export function ImportView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [kind, setKind] = useState<ImportKind>("vendors");
  const [projectId, setProjectId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [projectType, setProjectType] =
    useState<keyof typeof PROJECT_TYPE_LABEL>("ground_up_condo");
  const [file, setFile] = useState<{
    fileName: string;
    sheets: Sheet[];
  } | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const projects = useQuery({
    ...trpc.projects.list.queryOptions({}),
    enabled: kind === "budget" || kind === "units",
  });
  const companies = useQuery({
    ...trpc.companies.list.queryOptions(),
    enabled: kind === "projects",
  });
  const commit = useMutation(
    trpc.import.commit.mutationOptions({
      onSuccess: async (r) => {
        setResult(r);
        // The rows are in; clear the file so the same rows can't be imported twice by accident.
        setFile(null);
        setInputKey((k) => k + 1);
        await qc.invalidateQueries();
      },
      onError: (e) => setParseError(errorMessage(e)),
    }),
  );

  const sheet = file?.sheets[sheetIdx] ?? null;
  const preview = useMemo(
    () =>
      sheet ? validateRows(kind, sheet.rows, mapping, sheet.rowNumbers) : null,
    [sheet, kind, mapping],
  );
  const fields = IMPORT_FIELDS[kind];
  const missingRequired = fields.filter(
    (f) => f.required && mapping[f.key] == null,
  );
  const needsTarget =
    kind === "projects" && sheet && sheet.rows.length > MAX_PROJECT_IMPORT_ROWS
      ? `Import up to ${MAX_PROJECT_IMPORT_ROWS} projects at a time. Split the sheet.`
      : (kind === "budget" || kind === "units") && !projectId
        ? "Choose the project."
        : kind === "projects" && !companyId
          ? "Choose the company."
          : kind === "template" && !templateName.trim()
            ? "Name the template."
            : null;

  function pickKind(k: ImportKind) {
    setKind(k);
    setResult(null);
    if (sheet) setMapping(guessMapping(k, sheet.headers));
  }
  function pickSheet(i: number) {
    setSheetIdx(i);
    setResult(null);
    if (file?.sheets[i])
      setMapping(guessMapping(kind, file.sheets[i]!.headers));
  }
  async function upload(f: File | null) {
    setParseError(null);
    setResult(null);
    setFile(null);
    if (!f) return;
    setParsing(true);
    try {
      const body = new FormData();
      body.append("file", f);
      const res = await fetch("/api/import/parse", { method: "POST", body });
      const json = (await res
        .json()
        .catch(() => ({
          error:
            res.status === 413
              ? "That file is too big. Keep it under 4 MB."
              : "Couldn't read that file.",
        }))) as { error?: string; fileName?: string; sheets?: Sheet[] };
      if (!res.ok || !json.sheets)
        throw new Error(json.error ?? "Couldn't read that file.");
      setFile({ fileName: json.fileName!, sheets: json.sheets });
      setSheetIdx(0);
      setMapping(guessMapping(kind, json.sheets[0]!.headers));
    } catch (e) {
      setParseError(
        e instanceof Error ? e.message : "Couldn't read that file.",
      );
    } finally {
      setParsing(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Owner & admins"
        title="Import from Excel"
        description="Bring in projects, budgets, unit schedules, the vendor directory and checklist templates from an .xlsx or .csv. You'll see how many rows were read, how many are valid, and why any were turned away, before anything is saved."
      />
      <div className="flex flex-col gap-8">
        <Panel title="1. What are you importing?">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Kind" htmlFor="imp-kind" hint={WHAT[kind]}>
              <Select
                id="imp-kind"
                value={kind}
                onChange={(e) => pickKind(e.target.value as ImportKind)}
              >
                {IMPORT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {IMPORT_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
            {(kind === "budget" || kind === "units") && (
              <Field label="Into project" htmlFor="imp-project">
                <Select
                  id="imp-project"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {projects.data?.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {kind === "projects" && (
              <Field label="Company" htmlFor="imp-company">
                <Select
                  id="imp-company"
                  value={companyId}
                  onChange={(e) => setCompanyId(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {companies.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {kind === "template" && (
              <>
                <Field label="Template name" htmlFor="imp-tname">
                  <Input
                    id="imp-tname"
                    value={templateName}
                    maxLength={120}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="e.g. Gut reno, 2027"
                  />
                </Field>
                <Field label="For project type" htmlFor="imp-ttype">
                  <Select
                    id="imp-ttype"
                    value={projectType}
                    onChange={(e) =>
                      setProjectType(e.target.value as typeof projectType)
                    }
                  >
                    {Object.entries(PROJECT_TYPE_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
          </div>
        </Panel>

        <Panel
          title="2. The file"
          description="An Excel .xlsx or a .csv, up to 4 MB and 500 rows (50 for projects). The first non-empty row is the header."
        >
          <input
            key={inputKey}
            type="file"
            aria-label="Spreadsheet file"
            accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => void upload(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
          {parsing && <p className="mt-3 text-[13px] text-muted">Reading…</p>}
          {parseError && (
            <p role="alert" className="mt-3 text-[13px] text-blocked-text">
              {parseError}
            </p>
          )}
          {file && (
            <div className="mt-4 flex flex-wrap items-end gap-4">
              {file.sheets.length > 1 && (
                <Field label="Sheet" htmlFor="imp-sheet">
                  <Select
                    id="imp-sheet"
                    value={sheetIdx}
                    onChange={(e) => pickSheet(Number(e.target.value))}
                  >
                    {file.sheets.map((s, i) => (
                      <option key={s.name} value={i}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {sheet && (
                <p className="num text-[14px]" role="status">
                  <span className="font-medium">{sheet.total}</span> row
                  {sheet.total === 1 ? "" : "s"} read from {file.fileName}
                  {sheet.total > sheet.rows.length && (
                    <span className="text-attention-text">
                      {" "}
                      · only the first {sheet.rows.length} are imported; split
                      the rest into another file
                    </span>
                  )}
                </p>
              )}
            </div>
          )}
        </Panel>

        {sheet && (
          <Panel
            title="3. Match the columns"
            description="We matched what we could from the headers. Check each one."
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {fields.map((f) => (
                <Field
                  key={f.key}
                  label={`${f.label}${f.required ? " *" : ""}`}
                  htmlFor={`map-${f.key}`}
                  hint={f.hint}
                >
                  <Select
                    id={`map-${f.key}`}
                    value={mapping[f.key] ?? ""}
                    onChange={(e) =>
                      setMapping((m) => ({
                        ...m,
                        [f.key]:
                          e.target.value === "" ? null : Number(e.target.value),
                      }))
                    }
                  >
                    <option value="">
                      {f.required ? "Choose a column…" : "Not in this file"}
                    </option>
                    {sheet.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
            {missingRequired.length > 0 && (
              <p className="mt-4 text-[13px] text-attention-text">
                Still needed: {missingRequired.map((f) => f.label).join(", ")}.
              </p>
            )}
          </Panel>
        )}

        {sheet && preview && missingRequired.length === 0 && (
          <Panel title="4. Check, then import">
            <p
              className="num mb-4 flex flex-wrap gap-x-6 gap-y-1 text-[14px]"
              role="status"
            >
              <span>
                Read <span className="font-medium">{sheet.rows.length}</span>
              </span>
              <span className="text-done-text">
                Valid{" "}
                <span className="font-medium">{preview.valid.length}</span>
              </span>
              <span
                className={
                  preview.rejected.length ? "text-blocked-text" : "text-muted"
                }
              >
                Turned away{" "}
                <span className="font-medium">{preview.rejected.length}</span>
              </span>
            </p>
            {preview.valid.length > 0 && (
              <div className="mb-4 overflow-x-auto rounded-panel border border-border">
                <table className="w-full min-w-[480px] text-[13px]">
                  <caption className="sr-only">The first valid rows</caption>
                  <thead className="bg-sunken text-left text-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">Row</th>
                      {fields
                        .filter((f) => mapping[f.key] != null)
                        .map((f) => (
                          <th key={f.key} className="px-3 py-2 font-medium">
                            {f.label}
                          </th>
                        ))}
                    </tr>
                  </thead>
                  <tbody className="num divide-y divide-border">
                    {preview.valid.slice(0, 8).map((v) => (
                      <tr key={v.row}>
                        <td className="px-3 py-2 text-muted">{v.row}</td>
                        {fields
                          .filter((f) => mapping[f.key] != null)
                          .map((f) => (
                            <td
                              key={f.key}
                              className="max-w-[16rem] truncate px-3 py-2"
                            >
                              {sheet.rows[v.row - 2]?.[mapping[f.key]!] ?? ""}
                            </td>
                          ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Rejected rows={preview.rejected} />
            {needsTarget && (
              <p className="mt-4 text-[13px] text-attention-text">
                {needsTarget}
              </p>
            )}
            <Button
              className="mt-4"
              disabled={preview.valid.length === 0 || !!needsTarget}
              loading={commit.isPending}
              onClick={() => {
                setParseError(null);
                commit.mutate({
                  kind,
                  rows: sheet.rows,
                  rowNumbers: sheet.rowNumbers,
                  mapping,
                  projectId: projectId || undefined,
                  companyId: companyId || undefined,
                  templateName: templateName.trim() || undefined,
                  projectType: kind === "template" ? projectType : undefined,
                });
              }}
            >
              Import {preview.valid.length} row
              {preview.valid.length === 1 ? "" : "s"}
            </Button>
          </Panel>
        )}

        {result && (
          <Panel title="Done">
            <p
              className="num mb-4 flex flex-wrap gap-x-6 gap-y-1 text-[14px]"
              role="status"
            >
              <span>
                Read <span className="font-medium">{result.read}</span>
              </span>
              <span>
                Valid <span className="font-medium">{result.valid}</span>
              </span>
              <span className="text-done-text">
                Imported <span className="font-medium">{result.imported}</span>
              </span>
              <span
                className={
                  result.rejected.length ? "text-blocked-text" : "text-muted"
                }
              >
                Rejected{" "}
                <span className="font-medium">{result.rejected.length}</span>
              </span>
            </p>
            <Rejected rows={result.rejected} />
          </Panel>
        )}
      </div>
    </>
  );
}

function Rejected({ rows }: { rows: RejectedRow[] }) {
  if (rows.length === 0) return null;
  return (
    <details
      className="rounded-panel border border-border"
      open={rows.length <= 10}
    >
      <summary className="cursor-pointer px-4 py-3 text-[14px] font-medium">
        <StatusPill tone="blocked" className="mr-2">
          {rows.length}
        </StatusPill>
        Row{rows.length === 1 ? "" : "s"} turned away, and why
      </summary>
      <ul className="num divide-y divide-border border-t border-border text-[13px]">
        {rows.map((r) => (
          <li key={`${r.row}-${r.reasons[0]}`} className="px-4 py-2">
            <span className="font-medium">Row {r.row}:</span>{" "}
            {r.reasons.join("; ")}
          </li>
        ))}
      </ul>
    </details>
  );
}
