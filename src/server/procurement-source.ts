/**
 * Adapter boundary for the external procurement feed («согласованный источник»).
 * Production wiring stays kickoff-blocked; runtime default is a deterministic stub.
 * Tests inject MockProcurementSource — never call a real vendor API from CI.
 */

export type ProcurementNoticeDraft = {
  number: string;
  title: string;
  customer: string;
  region: string;
  nmck: number;
  deadline: string;
  source: string;
  attachmentName?: string;
  tags?: string[];
};

export type ProcurementFetchResult = {
  ok: boolean;
  notices: ProcurementNoticeDraft[];
  detail: string;
  /** true when this adapter is a local stub/mock, not a live vendor */
  stub: boolean;
};

export interface ProcurementSource {
  readonly id: string;
  fetchNotices(orgId: string): Promise<ProcurementFetchResult>;
}

/** Default runtime adapter: synthetic notice for isolated demos / sync job. */
export class StubProcurementSource implements ProcurementSource {
  readonly id = "stub-agreed-source";

  async fetchNotices(orgId: string): Promise<ProcurementFetchResult> {
    const stamp = Date.now().toString().slice(-12);
    return {
      ok: true,
      stub: true,
      detail: `Stub feed for ${orgId}: согласованный источник не подключён`,
      notices: [
        {
          number: `${stamp}-AUTO`,
          title: "Автосинхронизация: ремонт дорожного покрытия",
          customer: "ГБУ «Автодор»",
          region: "Москва",
          nmck: 27_600_000,
          deadline: new Date(Date.now() + 14 * 86_400_000).toISOString(),
          source: "Согласованный источник",
          attachmentName: "izveshchenie.pdf",
          tags: ["автосинхронизация"],
        },
      ],
    };
  }
}

/** Test-only mock: returns caller-supplied notices, never hits network. */
export class MockProcurementSource implements ProcurementSource {
  readonly id = "mock-test-source";
  constructor(
    private readonly notices: ProcurementNoticeDraft[] = [],
    private readonly detail = "mock ok"
  ) {}

  async fetchNotices(_orgId: string): Promise<ProcurementFetchResult> {
    return {
      ok: true,
      stub: true,
      detail: this.detail,
      notices: this.notices.map((n) => ({ ...n })),
    };
  }
}

let activeSource: ProcurementSource = new StubProcurementSource();

export function getProcurementSource(): ProcurementSource {
  return activeSource;
}

export function setProcurementSource(source: ProcurementSource): void {
  activeSource = source;
}

export function resetProcurementSource(): void {
  activeSource = new StubProcurementSource();
}
