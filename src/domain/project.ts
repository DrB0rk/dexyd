import { z } from 'zod';

export const browseProjectQuerySchema = z.object({
  path: z.string().max(1000).default('')
});

export const createProjectRequestSchema = z.object({
  parentPath: z.string().max(1000).default(''),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._ -]+$/, 'project name may only contain letters, numbers, spaces, dots, underscores and dashes')
});

export type BrowseProjectQuery = z.infer<typeof browseProjectQuerySchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
