import { z } from 'zod';

export const fileQuerySchema = z.object({
  path: z.string().default('')
});

export const readFileQuerySchema = z.object({
  path: z.string().min(1),
  maxBytes: z.coerce.number().int().min(1).max(256 * 1024).default(64 * 1024)
});

export type FileEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'other';
  size: number;
  modifiedAt: string;
};
