/** Wire types shared by the server and the client. */

export const ITEM_STATUSES = ['open', 'done', 'archived'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export interface Item {
  id: number;
  title: string;
  notes: string | null;
  status: ItemStatus;
  created_at: string;
  updated_at: string;
}

export interface ItemEvent {
  id: number;
  item_id: number;
  type: string;
  actor: string;
  at: string;
}

export interface FieldError {
  field: string;
  message: string;
}

/** What GET /api/me answers: who is signed in, and what they may do here. */
export interface Me {
  username: string;
  access: 'view' | 'edit' | 'manage';
}
