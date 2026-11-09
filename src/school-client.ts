// Знімок даних закладу з school-service — єдиний прямий виклик між сервісами (розділ 03).
// GET {SCHOOL_INTERNAL_URL}/internal/v1/schools/{schoolId}/snapshot, захищено мережею compose.

export interface SnapshotBell {
  lesson_no: number;
  start: string;
  end: string;
}

export interface SchoolSnapshot {
  school_id: string;
  snapshot_version: number;
  profile: {
    name: string;
    lessons_per_day: number | null;
    saturday: boolean;
    shelter_capacity: number | null;
    non_teaching_staff: number | null;
    shelter_seats: number | null;
  };
  bells: SnapshotBell[];
  classes: { class_id: string; name: string; students: number; in_person_priority: boolean; archived_at: string | null }[];
  subjects: {
    subject_id: string;
    name: string;
    short_name: string;
    education_area: string;
    not_in_shelter: boolean;
    archived_at: string | null;
  }[];
  teachers: {
    teacher_id: string;
    teacher_no: number;
    label: string;
    weekly_hours_limit: number;
    unavailable_days: number[];
    deleted_at: string | null;
  }[];
  curriculum: { class_id: string; subject_id: string; teacher_id: string; hours_per_week: number }[];
}

export type SnapshotFetcher = (schoolId: string, correlationId?: string) => Promise<SchoolSnapshot>;

export class SchoolUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchoolUnavailableError';
  }
}

export function createSnapshotFetcher(baseUrl: string, opts: { timeoutMs?: number; fetch?: typeof fetch } = {}): SnapshotFetcher {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return async (schoolId, correlationId) => {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/internal/v1/schools/${encodeURIComponent(schoolId)}/snapshot`, {
        headers: correlationId ? { 'x-request-id': correlationId } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new SchoolUnavailableError(`school-service недоступний: ${(err as Error).message}`);
    }
    if (!res.ok) throw new SchoolUnavailableError(`school-service повернув HTTP ${res.status}`);
    return (await res.json()) as SchoolSnapshot;
  };
}
