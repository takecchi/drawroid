import { z } from 'zod';

import { type CandidateKind, generationRequestSchema, loraSchema } from '../backend.js';
import type { ShownCandidate } from '../candidates/select.js';
import type { Budget } from '../loop/budget.js';
import { PARAM_KEYS, type ParamKey } from '../params/param-key.js';
import type { Permissions } from '../permissions/permission.js';

export interface ParamsSchemaContext {
  // その回に考える役へ見せた候補（selectCandidates の結果）。見せていない候補は選べない
  shown: Partial<Record<CandidateKind, readonly ShownCandidate[]>>;
  budget: Budget;
}

export type OmittedReason = 'no-candidates-shown' | 'not-supported-yet';

export interface ParamsSchema {
  schema: z.ZodObject<Record<string, z.ZodType>>;
  // auto なのにスキーマに入れられなかったもの（UI と記録に出すため）
  omitted: Partial<Record<ParamKey, OmittedReason>>;
}

type ValueSchema = z.ZodType | OmittedReason;

function shownEnum(context: ParamsSchemaContext, kind: CandidateKind): z.ZodEnum | OmittedReason {
  const [first, ...rest] = (context.shown[kind] ?? []).map((c) => c.name);
  return first === undefined ? 'no-candidates-shown' : z.enum([first, ...rest]);
}

const request = generationRequestSchema.shape;

const valueSchemas: Record<ParamKey, (context: ParamsSchemaContext) => ValueSchema> = {
  prompt: ({ budget }) => z.string().min(1).max(budget.text.prompt),
  negativePrompt: ({ budget }) => z.string().max(budget.text.negativePrompt),
  checkpoint: (context) => shownEnum(context, 'checkpoint'),
  vae: (context) => shownEnum(context, 'vae'),
  sampler: (context) => shownEnum(context, 'sampler'),
  scheduler: (context) => shownEnum(context, 'scheduler'),
  loras: (context) => {
    const name = shownEnum(context, 'lora');
    return typeof name === 'string' ? name : z.array(loraSchema.extend({ name }));
  },
  // 数値に上限を付けるのは、考える役への入力に載る長さを予算の内に保つため（loop/inputs の見積もりはこの上限を前提にしている）
  steps: () => request.steps.max(150),
  cfgScale: () => request.cfgScale.min(1).max(30),
  // 要求では省けば乱数になるが、AI に任せたなら値を決めさせる
  seed: () => request.seed.unwrap().max(4294967295),
  width: () => request.width,
  height: () => request.height,
  // アップスケーラーの候補をポートから取れないので、名前を AI に作らせないよう、取れるまで入れない
  hiresFix: () => 'not-supported-yet',
  // 元画像・マスクの選び方が未決（#5 の G・H）で、要求にも欄がまだ無いので、決まるまで入れない
  img2img: () => 'not-supported-yet',
  inpaint: () => 'not-supported-yet',
  controlnet: () => 'not-supported-yet',
};

// 許可していないパラメータはスキーマにそもそも置かない: 出力に含めて後で捨てる形だと、捨て忘れた瞬間に許可を迂回されるため
export function buildParamsSchema(
  permissions: Permissions,
  context: ParamsSchemaContext,
): ParamsSchema {
  const shape: Record<string, z.ZodType> = {};
  const omitted: Partial<Record<ParamKey, OmittedReason>> = {};
  for (const key of PARAM_KEYS) {
    if (permissions[key].mode !== 'auto') continue;
    const value = valueSchemas[key](context);
    if (typeof value === 'string') omitted[key] = value;
    else shape[key] = value;
  }
  return { schema: z.object(shape), omitted };
}

export interface ParsedParams {
  result: z.ZodSafeParseResult<Record<string, unknown>>;
  // スキーマに無いので捨てた欄。黙って消すとローカルモデルの癖を後から追えないので、呼び出しの記録に載せる
  droppedKeys: string[];
}

export function parseParams({ schema }: ParamsSchema, raw: unknown): ParsedParams {
  const droppedKeys =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? Object.keys(raw).filter((key) => !Object.hasOwn(schema.shape, key))
      : [];
  return { result: schema.safeParse(raw), droppedKeys };
}
