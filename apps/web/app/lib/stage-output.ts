import { z } from 'zod';

// core のスキーマを使わない: あちらは予算の上限を値に取り込んでいて、過去に別の予算で書いた記録を画面が読めなくなるため
const thinkSchema = z.object({
  params: z
    .object({
      prompt: z.string().optional(),
      negativePrompt: z.string().optional(),
      seed: z.number().optional(),
      steps: z.number().optional(),
      cfgScale: z.number().optional(),
      // M4 で cfgScale に改めた。それより前に書いた記録は cfg のまま残っているので、cfgScale として読む
      cfg: z.number().optional(),
    })
    .transform(({ cfg, ...params }) => ({
      ...params,
      ...(params.cfgScale === undefined && cfg !== undefined && { cfgScale: cfg }),
    })),
  rationale: z.string(),
});

const judgeSchema = z.object({
  images: z.array(z.object({ score: z.number(), issues: z.array(z.string()) })),
  nextChange: z.string(),
  canStop: z.boolean(),
});

export type Think = z.infer<typeof thinkSchema>;
export type Judge = z.infer<typeof judgeSchema>;

// 読めなければ undefined を返し、画面が生の JSON を出す: 形が変わった記録でも、中身を隠さないため
export function readThink(value: unknown): Think | undefined {
  const parsed = thinkSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function readJudge(value: unknown): Judge | undefined {
  const parsed = judgeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
