import type { ClipRef } from '../../shared/contract';

// The backend owns program ordering; clients page forward with a cursor.
export interface ContentClient {
  upcoming(after: string | null, limit: number): Promise<ClipRef[]>;
  destroy(): void;
}
